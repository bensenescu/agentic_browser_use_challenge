/**
 * Agent Orchestrator — Optimized for speed
 *
 * Architecture:
 * - Tools own the browser (Playwright runs inside OpenCode's Bun-based plugin system)
 * - agent.ts does NOT use Playwright — it orchestrates via tool calls only
 * - First challenge: scan-page gets url param to navigate + click START
 * - Subsequent challenges: page is already on the right step
 * - URL verification via get-url tool call
 * - New session per challenge (context isolation)
 *
 * Usage:
 *   npm run agent [-- challenge-url]
 *   npm run agent:headed [-- challenge-url]
 */
import { createOpencode } from "@opencode-ai/sdk/v2"

const CHALLENGE_URL =
  process.argv[2] || "https://serene-frangipane-7fd25b.netlify.app/"
const MAX_CHALLENGES = 35
const MODEL = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
}

// Tool whitelist
const TOOLS: Record<string, boolean> = {
  "*": false,
  "scan-page": true,
  "enter-code": true,
  "find-code": true,
  "get-url": true,
  page_click_element: true,
  page_scroll: true,
  page_hover: true,
  page_evaluate_js: true,
  page_select_option: true,
  page_check_checkbox: true,
  page_press_key: true,
  page_get_page_html: true,
}

const SYSTEM_PROMPT = `You solve browser challenges. SPEED is critical — minimum tool calls.

## Happy path (most challenges): 2 tool calls
1. scan-page → reads current page + auto-scrolls/waits/clicks-reveal/hovers + finds codes
2. enter-code → enters code from CODE CANDIDATES and submits

## If scan-page didn't find the code:
- Read the HTML section in scan-page output to understand the challenge
- Do ONE interaction (click/hover/scroll/evaluate_js) then call scan-page again (with noAuto=true)
- Or use find-code for deep scan, page_get_page_html for raw HTML patterns

## Available tools ONLY:
scan-page, enter-code, find-code, get-url, page_click_element, page_scroll, page_hover, page_evaluate_js, page_select_option, page_check_checkbox, page_press_key, page_get_page_html

## CRITICAL RULES
- You can ONLY use the tools listed above. Do NOT call any other tool.
- You CANNOT navigate. The page is already on the correct step. Just solve it.
- NEVER click decoy buttons: "Continue", "Next", "Go Forward", "Proceed", "Keep Going"
- After entering the code, STOP. The orchestrator handles what comes next.
- Act immediately. No explanations needed.`

// ---- ANSI helpers ----
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`

function truncate(s: string, max = 200): string {
  return s.length <= max ? s : s.substring(0, max) + "..."
}

// ---- Timing ----
interface ChallengeTimings {
  challengeStart: number
  toolCalls: number
  toolTimeMs: number
  lastEventTime: number
  currentToolStart: number | null
}

function newTimings(): ChallengeTimings {
  const now = Date.now()
  return {
    challengeStart: now,
    toolCalls: 0,
    toolTimeMs: 0,
    lastEventTime: now,
    currentToolStart: null,
  }
}

/** Extract step number from URL like /step5?version=2 */
function getStepFromUrl(url: string): number | null {
  const match = url.match(/\/step(\d+)/)
  return match ? parseInt(match[1], 10) : null
}

/** Call get-url tool to check the current page URL */
async function checkCurrentUrl(client: any, sessionId: string): Promise<{ url: string; step: number | null }> {
  try {
    const result = await client.session.prompt({
      sessionID: sessionId,
      model: MODEL,
      system: "Call get-url and return its output verbatim. Nothing else.",
      tools: { "*": false, "get-url": true },
      parts: [{ type: "text" as const, text: "Call get-url now." }],
    })
    // Parse URL from the model's response which includes the tool output
    const message = result.data as any
    if (message?.parts) {
      for (const part of message.parts) {
        if (part.type === "tool" && part.state?.output) {
          try {
            const data = JSON.parse(part.state.output)
            return { url: data.url, step: getStepFromUrl(data.url) }
          } catch {}
        }
        if (part.type === "text" && part.text) {
          // Try to extract URL from text
          const urlMatch = part.text.match(/https?:\/\/[^\s"]+/)
          if (urlMatch) {
            return { url: urlMatch[0], step: getStepFromUrl(urlMatch[0]) }
          }
        }
      }
    }
  } catch {}
  return { url: "", step: null }
}

async function main() {
  const totalStart = Date.now()
  console.log(bold("=== Adcock Challenge Agent ==="))
  console.log(`Challenge URL: ${CHALLENGE_URL}`)
  console.log(`Model: ${MODEL.providerID}/${MODEL.modelID}`)
  console.log(`Headed: ${process.env.HEADED === "true" ? "yes" : "no"}`)
  console.log("")

  // ---- Start OpenCode server ----
  console.log("Starting OpenCode server...")
  const { client } = await createOpencode({
    config: {
      model: `${MODEL.providerID}/${MODEL.modelID}`,
    },
  })

  const health = await client.global.health()
  console.log(`Server healthy: ${health.data?.healthy}, version: ${health.data?.version}`)

  // Timing state (shared with event handler)
  let timings = newTimings()

  // Subscribe to event stream
  console.log("Subscribing to event stream...\n")
  const events = await client.event.subscribe()

  const eventLoop = (async () => {
    try {
      for await (const event of events.stream) {
        const evt = event as any
        const type = evt?.type as string | undefined
        const now = Date.now()

        if (type === "message.part.updated") {
          const part = evt.properties?.part
          const delta = evt.properties?.delta
          if (!part) continue

          // Track thinking gaps
          const gap = now - timings.lastEventTime
          if (gap > 2000 && timings.currentToolStart === null) {
            process.stdout.write(dim(`  [thinking ${(gap / 1000).toFixed(1)}s]\n`))
          }
          timings.lastEventTime = now

          if (part.type === "text") {
            if (delta) process.stdout.write(delta)
          } else if (part.type === "tool") {
            const state = part.state
            const toolName = part.tool || "?"
            if (state?.status === "pending") {
              timings.currentToolStart = now
              timings.toolCalls++
              process.stdout.write(
                `\n${cyan(`[${toolName}]`)} ${dim("calling")}${state.input ? " " + dim(truncate(JSON.stringify(state.input), 100)) : ""}\n`
              )
            } else if (state?.status === "completed") {
              const toolDuration = timings.currentToolStart ? now - timings.currentToolStart : 0
              timings.toolTimeMs += toolDuration
              timings.currentToolStart = null
              const output = state.output ?? state.result ?? ""
              const outputStr = typeof output === "string" ? output : JSON.stringify(output)
              process.stdout.write(
                `${cyan(`[${toolName}]`)} ${green("done")} ${dim(`(${(toolDuration / 1000).toFixed(1)}s)`)} ${dim(truncate(outputStr, 150))}\n`
              )
            } else if (state?.status === "error") {
              timings.currentToolStart = null
              process.stdout.write(
                `${cyan(`[${toolName}]`)} ${red("error")} ${state.error || ""}\n`
              )
            }
          } else if (part.type === "step-finish") {
            const tokens = part.tokens
            if (tokens) {
              process.stdout.write(
                dim(`--- step (in:${tokens.input} out:${tokens.output}) ---\n`)
              )
            }
          }
        } else if (type === "session.error") {
          process.stdout.write(
            `\n${red("[error]")} ${(evt.properties as any)?.error || "?"}\n`
          )
        }
      }
    } catch {
      // Stream closed
    }
  })()

  // ---- Main challenge loop ----
  let expectedStep = 1
  let consecutiveErrors = 0
  let isFirstChallenge = true
  const challengeResults: Array<{ step: number; timeMs: number; tools: number; success: boolean }> = []

  while (expectedStep <= MAX_CHALLENGES) {
    timings = newTimings()

    console.log(
      bold(`\n${"=".repeat(20)} Challenge ${expectedStep} ${"=".repeat(20)}`)
    )

    try {
      // Fresh session per challenge (context isolation)
      const sessionResult = await client.session.create({
        title: `Challenge ${expectedStep}`,
      })
      const sessionId = sessionResult.data!.id

      // Build instruction — first challenge gets URL, subsequent ones don't
      let instruction: string
      if (isFirstChallenge) {
        instruction = `Navigate to the challenge and solve it. Call scan-page with url="${CHALLENGE_URL}" to open the page (it will auto-click START). Then find the code and call enter-code to submit it. STOP after entering the code.`
        isFirstChallenge = false
      } else {
        instruction = `Solve this challenge step. Call scan-page to read the page and find the code, then call enter-code to submit it. Do NOT navigate away. STOP after entering the code.`
      }

      const result = await client.session.prompt({
        sessionID: sessionId,
        model: MODEL,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        parts: [{ type: "text" as const, text: instruction }],
      })

      const message = result.data as any
      const challengeTime = Date.now() - timings.challengeStart
      const thinkingTime = challengeTime - timings.toolTimeMs

      // Print timing summary
      console.log(
        magenta(
          `\n  Timing: ${(challengeTime / 1000).toFixed(1)}s total | ` +
          `${(timings.toolTimeMs / 1000).toFixed(1)}s tools (${timings.toolCalls} calls) | ` +
          `${(thinkingTime / 1000).toFixed(1)}s model thinking`
        )
      )

      if (!message || !message.parts) {
        console.log(yellow("  No response from model"))
        challengeResults.push({ step: expectedStep, timeMs: challengeTime, tools: timings.toolCalls, success: false })
        consecutiveErrors++
        if (consecutiveErrors >= 3) {
          console.log(red("  3 consecutive errors. Skipping step."))
          consecutiveErrors = 0
          expectedStep++
        }
        continue
      }

      // ---- Verify page state via get-url tool ----
      const urlCheckSession = await client.session.create({ title: `URL check ${expectedStep}` })
      const { url: afterUrl, step: afterStep } = await checkCurrentUrl(client, urlCheckSession.data!.id)
      console.log(dim(`  Page URL: ${afterUrl}`))

      if (afterStep && afterStep > expectedStep) {
        // Success! Page advanced
        console.log(green(`  Step ${expectedStep} solved! Page now on step ${afterStep}`))
        challengeResults.push({ step: expectedStep, timeMs: challengeTime, tools: timings.toolCalls, success: true })
        consecutiveErrors = 0
        expectedStep = afterStep
      } else if (afterStep === expectedStep) {
        // Page didn't advance — code entry may have failed
        console.log(yellow(`  Still on step ${expectedStep} — may need retry`))
        challengeResults.push({ step: expectedStep, timeMs: challengeTime, tools: timings.toolCalls, success: false })
        consecutiveErrors++
        if (consecutiveErrors >= 3) {
          console.log(red("  3 consecutive failures. Skipping step."))
          consecutiveErrors = 0
          expectedStep++
        }
      } else {
        // Check for completion
        if (afterUrl.includes("congratulations") || afterUrl.includes("complete")) {
          console.log(green("\n=== All challenges completed! ==="))
          challengeResults.push({ step: expectedStep, timeMs: challengeTime, tools: timings.toolCalls, success: true })
          break
        }

        // afterStep is null or different — check if we got a body text about completion
        // We'll just assume forward progress if step is null
        if (!afterStep && !afterUrl) {
          console.log(yellow(`  Could not determine URL, assuming still on step ${expectedStep}`))
        } else {
          console.log(yellow(`  Unexpected URL after step ${expectedStep}: ${afterUrl}`))
        }
        challengeResults.push({ step: expectedStep, timeMs: challengeTime, tools: timings.toolCalls, success: false })
        consecutiveErrors++
        if (consecutiveErrors >= 3) {
          console.log(red("  3 consecutive issues. Skipping step."))
          consecutiveErrors = 0
          expectedStep++
        }
      }
    } catch (err: any) {
      const challengeTime = Date.now() - timings.challengeStart
      console.error(red(`  Error on step ${expectedStep}: ${err.message}`))
      challengeResults.push({ step: expectedStep, timeMs: challengeTime, tools: timings.toolCalls, success: false })
      consecutiveErrors++
      if (consecutiveErrors >= 3) {
        console.log(red("  3 consecutive errors. Skipping step."))
        consecutiveErrors = 0
        expectedStep++
      }
    }
  }

  // ---- Final summary ----
  const totalTime = Date.now() - totalStart
  console.log(bold("\n" + "=".repeat(60)))
  console.log(bold("FINAL SUMMARY"))
  console.log(bold("=".repeat(60)))
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`)
  console.log(`Challenges attempted: ${challengeResults.length}`)
  const successes = challengeResults.filter(r => r.success).length
  console.log(`Solved: ${successes}/${challengeResults.length}`)
  console.log(`Avg per challenge: ${challengeResults.length > 0 ? (challengeResults.reduce((s, r) => s + r.timeMs, 0) / challengeResults.length / 1000).toFixed(1) : 0}s`)
  console.log(`Avg tool calls: ${challengeResults.length > 0 ? (challengeResults.reduce((s, r) => s + r.tools, 0) / challengeResults.length).toFixed(1) : 0}`)
  console.log("")
  challengeResults.forEach((r) => {
    const icon = r.success ? green("OK") : red("FAIL")
    console.log(`  Step ${String(r.step).padStart(2)}: ${icon} ${(r.timeMs / 1000).toFixed(1)}s (${r.tools} tools)`)
  })

  console.log("\nDone. Browser left open for debugging. Press Ctrl+C to exit.")
}

main().catch((err) => {
  console.error("Fatal error:", err)
})
