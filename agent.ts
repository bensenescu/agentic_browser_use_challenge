/**
 * Agent Orchestrator — Optimized for speed
 *
 * Architecture:
 * - Tools own the browser (Playwright runs inside OpenCode's Bun-based plugin system)
 * - agent.ts does NOT use Playwright — it orchestrates via tool calls only
 * - First challenge: scan_page_for_code gets url param to navigate + click START
 * - Subsequent challenges: page is already on the right step
 * - URL verification via get_url tool call
 * - New session per challenge (context isolation)
 *
 * Usage:
 *   npm run agent [-- [challenge-url] [--provider <id>] [--model <name>]]
 *   npm run agent:headed [-- [challenge-url] [--provider <id>] [--model <name>]]
 *
 * Examples:
 *   npm run agent:headed
 *   npm run agent:headed -- --provider openai --model gpt-4o
 *   npm run agent:headed -- https://example.com --provider anthropic --model claude-sonnet-4-5
 */
import { createOpencode } from "@opencode-ai/sdk/v2";

// ---- CLI argument parsing ----
function parseArgs(argv: string[]): {
  url: string;
  provider: string;
  model: string;
} {
  const args = argv.slice(2); // skip node + script
  let url = "";
  let provider = "anthropic";
  let model = "claude-sonnet-4-5";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && i + 1 < args.length) {
      provider = args[++i];
    } else if (args[i] === "--model" && i + 1 < args.length) {
      model = args[++i];
    } else if (!args[i].startsWith("--")) {
      url = args[i];
    }
  }

  return {
    url: url || "https://serene-frangipane-7fd25b.netlify.app/",
    provider,
    model,
  };
}

const parsed = parseArgs(process.argv);
const CHALLENGE_URL = parsed.url;
const MAX_CHALLENGES = 35;

// Model escalation: haiku → opus (2 attempts max)
const MODEL_LADDER = [
  { providerID: "anthropic", modelID: "claude-haiku-4-5" },
  { providerID: "anthropic", modelID: "claude-opus-4-5" },
];

function getModelForAttempt(attempt: number): {
  providerID: string;
  modelID: string;
} {
  const idx = Math.min(attempt, MODEL_LADDER.length - 1);
  return MODEL_LADDER[idx];
}

const MAX_ATTEMPTS = MODEL_LADDER.length;

// Tool whitelists — haiku gets escalate, opus does not
const TOOLS_BASE: Record<string, boolean> = {
  "*": false,
  scan_page_for_code: true,
  enter_code: true,
  get_url: true,
  page_click_element: true,
  page_scroll: true,
  page_hover: true,
  page_evaluate_js: true,
  page_select_option: true,
  page_check_checkbox: true,
  page_press_key: true,
  page_get_page_html: true,
};
const TOOLS_WITH_ESCALATE: Record<string, boolean> = {
  ...TOOLS_BASE,
  escalate: true,
};
const TOOLS_WITHOUT_ESCALATE: Record<string, boolean> = {
  ...TOOLS_BASE,
  escalate: false,
};

// ---- System prompt building blocks ----

const PROMPT_HEADER = `You solve browser challenges. SPEED is critical — minimum tool calls.

## Happy path (most challenges): 2 tool calls
1. scan_page_for_code → reads current page + auto-scrolls/waits/clicks-reveal/hovers + finds codes
2. enter_code → enters code from CODE CANDIDATES and submits

## If scan_page_for_code didn't find the code:
- Read the PAGE CONTENT section in scan_page_for_code output to understand the challenge
- Do ONE interaction (click/hover/scroll/evaluate_js) then call scan_page_for_code again (with noAuto=true)
- Or use page_get_page_html for raw HTML patterns`;

const ESCALATION_SECTION = `
## ESCALATE IMMEDIATELY for these challenge types (right after scan_page_for_code):
Call the escalate tool as your VERY NEXT action after scan_page_for_code if the page contains ANY of these:
- "drag" / "drop" / "draggable" / "slots" → escalate("drag-and-drop challenge")
- "canvas" / "draw" / "gesture" / "stroke" → escalate("canvas/gesture challenge")
- "iframe" / "shadow DOM" → escalate("iframe/shadow DOM challenge")
- "memory" / "remember" / "memorize" / "code will flash" → escalate("memory challenge")
- "hover" + "seconds" (timed hover) → escalate("timed hover challenge")
- "window will appear" / "capture" (timing window) → escalate("timing/capture challenge")
- "parts scattered" / "find N parts" → escalate("split parts challenge")
- Math equation with its own input + "Solve" button → escalate("math puzzle challenge")
- "puzzle" / "maze" → escalate("puzzle challenge")
- "decode" / "encoded" / "base64" / "decrypt" / "cipher" → escalate("decode/encoded challenge")
- Multi-step challenges ("Step 1/2/3", "Complete N actions", "Sequence Challenge", "N/4") → escalate("multi-step challenge")
Do NOT waste tool calls trying to solve these yourself. Escalate IMMEDIATELY.`;

const SHARED_PLAYBOOKS = `
### Instruction-first rule
Before taking any action, read the page instructions and constraints (e.g. “enter ANY 6 characters”, “exactly 6”, “click Reveal”). Prioritize these over hints, encoded strings, or decoys.
If you see a form instruction, follow it literally before trying to decode or derive anything.

### Failure reset
If two consecutive attempts fail (wrong code or no progress): STOP. Re-read the instructions and scan for high-signal guidance (labels, placeholders, warning callouts).
Then take the simplest compliant action from the instructions (e.g. “type any 6 characters” + “click Reveal”).

### Keyboard sequences
If the page shows key combinations (e.g. Control+A, Control+C, Control+V):
→ Call page_press_key for EACH combo in order (e.g. "Control+a", "Control+c", "Control+v")
→ Then call scan_page_for_code with noAuto=true to find the revealed code.

### Multi-tab / tabbed challenges
If the page has tabs (Tab 1, Tab 2, etc.) that must all be visited:
→ Use page_evaluate_js to click each tab in sequence:
  const tabs = document.querySelectorAll('[role="tab"], button[class*="tab"]');
  for (const tab of tabs) { tab.click(); await new Promise(r => setTimeout(r, 300)); }
→ After visiting all tabs, look for a "Reveal Code" button and click it.
→ Then call scan_page_for_code with noAuto=true.

### Decoy buttons
The page may have multiple buttons — most are traps.
NEVER click: "Continue", "Next", "Go Forward", "Proceed", "Keep Going", "Skip"
Look for buttons that mention: "Reveal", "Real", "Remember", "Actual", "True", "Unlock", "Complete Challenge"

### Form validation / multi-step forms
If the page has multiple form fields (not just the code input):
→ Read the labels/placeholders to understand what's expected
→ Use page_evaluate_js to fill fields, or page_select_option / page_check_checkbox as needed

### Timer / animation challenges
If the page has a countdown or animation that must complete:
→ Use page_evaluate_js to fast-forward or wait: await new Promise(r => setTimeout(r, <ms>))`;

const ADVANCED_PLAYBOOKS = `
### Math / puzzle challenges
If the page shows a math equation (e.g. "29 + 9 = ?") with its own input and "Solve" button:
→ Use page_evaluate_js to solve it in ONE call. The puzzle input is SEPARATE from the main code input.
→ Example JS:
  const eq = document.querySelector('h2, h3, [class*="text-3xl"], [class*="text-4xl"]');
  const text = eq?.innerText || '';
  const m = text.match(/(\\d+)\\s*([+\\-*/])\\s*(\\d+)/);
  if (m) {
    const ans = eval(m[1] + m[2] + m[3]);
    const input = document.querySelector('input[placeholder*="answer"], input[placeholder*="ans"], input[type="number"]');
    if (input) { const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; nativeSetter.call(input, String(ans)); input.dispatchEvent(new Event('input', {bubbles:true})); }
    const solveBtn = [...document.querySelectorAll('button')].find(b => /solve/i.test(b.innerText));
    solveBtn?.click();
  }
→ Then call scan_page_for_code with noAuto=true to find the revealed code.
→ IMPORTANT: Do NOT type the math answer into the main "Enter 6-character code" input.

### Memory challenges
If the page says "remember" or "memorize" a code, then shows a "I Remember" or similar button:
→ Click the button that says "I Remember", "Reveal Real Code", or similar (NOT decoy buttons).
→ Then call scan_page_for_code with noAuto=true to find the revealed code.

### Hover for duration
If the page says to hover over something for N seconds and auto-hover didn't reveal the code:
→ Call page_hover on the target element, then call page_evaluate_js with a sleep/wait for the required duration:
  await new Promise(r => setTimeout(r, <ms>))
→ Then call scan_page_for_code with noAuto=true to find the revealed code.
→ Alternatively, use page_evaluate_js to directly read the code from the DOM after triggering hover events.

### Timing / capture window challenges
If the page says "Window will appear soon" or has a "Capture" button:
→ Use page_evaluate_js to set up a MutationObserver that auto-clicks "Capture Now!" when the window appears:
  new MutationObserver((mutations, obs) => {
    const btn = [...document.querySelectorAll('button')].find(b => /capture now/i.test(b.innerText));
    if (btn) { btn.click(); obs.disconnect(); }
  }).observe(document.body, {childList: true, subtree: true});
→ Wait a few seconds, then call scan_page_for_code with noAuto=true.

### Split parts / hidden parts
If the page says "find N parts scattered on the page":
→ Do NOT guess the combined code until all parts are found.
→ Use page_evaluate_js to auto-click all scattered parts:
  1. Prefer clickable overlays: [class*="cursor-pointer"], [class*="pointer-events-auto"], [role="button"], button
  2. Include absolute/fixed elements that may be off-screen or visually hidden.
  3. Dispatch click events directly if elements are not visible.
→ After clicking, look for "All parts found" / checkmarks / progress N/N, then click any Reveal/Complete button.
→ Then call scan_page_for_code with noAuto=true.

### Drag and drop
If the page mentions "drag" and has draggable pieces/slots:
→ Use page_evaluate_js to solve it programmatically. Preferred strategy:
  1. Find React internals first. If the draggable pieces or slots have React props (e.g. __reactProps$*), call their handlers directly (onDragStart/onDragOver/onDrop) to move pieces.
  2. If React handlers are not available, fall back to standard drag events:
     dragstart on piece → dragover on zone → drop on zone → dragend on piece
     Use DataTransfer objects: new DataTransfer() with setData/getData
  3. If standard events still don't work, retry React fiber state manipulation to mark the puzzle complete.
→ Then call scan_page_for_code with noAuto=true to find the revealed code.

### Canvas / gesture challenges
If the page requires drawing on a canvas or performing gestures:
→ Fast path: prefer React handlers and synthetic events over raw canvas drawing.
  1. Find the canvas and its React props (e.g. __reactProps$*). If onMouseDown/onMouseMove/onMouseUp exist, call them with event objects containing clientX/clientY computed from getBoundingClientRect().
  2. If handlers exist but calling them doesn't update state, dispatch real DOM MouseEvent/PointerEvent on the canvas (bubbling true) so React picks them up.
  3. Only if React handlers are missing, fall back to direct canvas drawing or fiber state manipulation.
→ After strokes/gestures are completed, look for "Reveal/Complete" buttons and click them, then scan_page_for_code with noAuto=true.

### iframe / shadow DOM
If scan_page_for_code returns very little content, the challenge may be inside an iframe or shadow DOM:
→ Use page_evaluate_js to access:
  document.querySelector('iframe')?.contentDocument?.body?.innerText
  or element.shadowRoot?.innerHTML
→ Extract the code from the inner content.`;

const RULES_HAIKU = `
## Available tools ONLY:
scan_page_for_code, enter_code, get_url, escalate, page_click_element, page_scroll, page_hover, page_evaluate_js, page_select_option, page_check_checkbox, page_press_key, page_get_page_html

## CRITICAL RULES
- You can ONLY use the tools listed above. Do NOT call any other tool.
- Do NOT navigate away. The page is already on the correct step. Only pass navigate=true to scan_page_for_code when the instruction explicitly provides a URL for the first challenge.
- NEVER click decoy buttons: "Continue", "Next", "Go Forward", "Proceed", "Keep Going"
- If the page asks you to decode/encode/decrypt anything, call escalate immediately after scan_page_for_code.
- If the page is multi-step (sequence of actions, N/4 progress, "Complete N actions"), call escalate immediately after scan_page_for_code.
- After entering the code, STOP. The orchestrator handles what comes next.
- Act immediately. No explanations needed.
- TOOL CALL BUDGET: You have at most 15 tool calls. If you haven't found the code after 10 calls, try your best guess with enter_code. A wrong answer is better than wasting calls — the orchestrator will escalate to a stronger model.`;

const RULES_OPUS = `
## Available tools ONLY:
scan_page_for_code, enter_code, get_url, page_click_element, page_scroll, page_hover, page_evaluate_js, page_select_option, page_check_checkbox, page_press_key, page_get_page_html

## CRITICAL RULES
- You can ONLY use the tools listed above. Do NOT call any other tool.
- Do NOT navigate away. The page is already on the correct step. Only pass navigate=true to scan_page_for_code when the instruction explicitly provides a URL for the first challenge.
- The escalate tool is DISABLED in this session. Never call it.
- NEVER click decoy buttons: "Continue", "Next", "Go Forward", "Proceed", "Keep Going"
- Instruction priority: If the page says "enter ANY X characters" or "exactly X", do that literally. Do NOT infer or decode unless instructed.
- Action-priority: If completion state is reached (e.g. "Complete (4/4)", "All steps done", progress shows N/N), click the obvious primary CTA (Complete/Reveal/Continue Challenge) BEFORE further scanning or DOM/JS inspection.
- Reflection gate: After 2 failed code-retrieval attempts, STOP and re-read instructions. List available UI actions (buttons/links/inputs). Choose the simplest action that follows the instructions and try it next.
- Tool-selection heuristic: Prefer visible UI interactions (click/hover/scroll) over DOM/JS inspection unless no relevant UI action exists.
- Multi-step challenges: Prefer a single page_evaluate_js that completes all required actions in one script (click/hover/type/scroll) rather than sequential tool calls.
- After entering the code, STOP. The orchestrator handles what comes next.
- Act immediately. No explanations needed.
- TOOL CALL BUDGET: You have at most 20 tool calls. Use them wisely.`;

// Assembled prompts
const SYSTEM_PROMPT_HAIKU = [
  PROMPT_HEADER,
  ESCALATION_SECTION,
  "\n## Challenges you CAN solve (do NOT escalate):",
  SHARED_PLAYBOOKS,
  RULES_HAIKU,
].join("\n");

const SYSTEM_PROMPT_OPUS = [
  PROMPT_HEADER,
  "\n## Pattern playbooks (when auto-solve doesn't find the code):",
  SHARED_PLAYBOOKS,
  ADVANCED_PLAYBOOKS,
  RULES_OPUS,
].join("\n");

// ---- ANSI helpers ----
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

function truncate(s: string, max = 200): string {
  return s.length <= max ? s : s.substring(0, max) + "...";
}

// ---- Timing & Observability ----
interface ThinkingSegment {
  phase: string; // e.g. "initial", "after:scan_page_for_code", "after:enter_code", "final"
  durationMs: number;
  afterToolOutput?: string; // truncated output of the tool that preceded this thinking gap
}

interface ChallengeTimings {
  challengeStart: number;
  toolCalls: number;
  toolTimeMs: number;
  lastEventTime: number;
  currentToolStart: number | null;
  /** URL captured from enter_code tool output during the event stream */
  lastEnterCodeUrl: string | null;
  /** Detailed thinking segments for observability */
  thinkingSegments: ThinkingSegment[];
  /** Track what the last completed tool was, for labeling thinking phases */
  lastCompletedTool: string | null;
  lastToolOutput: string | null;
  /** Whether we've seen the first tool call yet */
  seenFirstTool: boolean;
  /** Whether the agent called the escalate tool */
  escalateRequested: boolean;
}

function newTimings(): ChallengeTimings {
  const now = Date.now();
  return {
    challengeStart: now,
    toolCalls: 0,
    toolTimeMs: 0,
    lastEventTime: now,
    currentToolStart: null,
    lastEnterCodeUrl: null,
    thinkingSegments: [],
    lastCompletedTool: null,
    lastToolOutput: null,
    seenFirstTool: false,
    escalateRequested: false,
  };
}

/** Extract step number from URL like /step5?version=2 */
function getStepFromUrl(url: string): number | null {
  const match = url.match(/\/step(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function main() {
  const totalStart = Date.now();
  console.log(bold("=== Adcock Challenge Agent ==="));
  console.log(`Challenge URL: ${CHALLENGE_URL}`);
  console.log(
    `Model ladder: ${MODEL_LADDER.map((m) => m.modelID).join(" → ")}`,
  );
  console.log(`Headed: ${process.env.HEADED === "true" ? "yes" : "no"}`);
  console.log("");

  // ---- Start OpenCode server ----
  console.log("Starting OpenCode server...");
  const defaultModel = MODEL_LADDER[0];
  const { client } = await createOpencode({
    config: {
      model: `${defaultModel.providerID}/${defaultModel.modelID}`,
    },
  });

  const health = await client.global.health();
  console.log(
    `Server healthy: ${health.data?.healthy}, version: ${health.data?.version}`,
  );

  // Timing state (shared with event handler)
  let timings = newTimings();

  // Subscribe to event stream
  console.log("Subscribing to event stream...\n");
  const events = await client.event.subscribe();

  const eventLoop = (async () => {
    try {
      for await (const event of events.stream) {
        const evt = event as any;
        const type = evt?.type as string | undefined;
        const now = Date.now();

        if (type === "message.part.updated") {
          const part = evt.properties?.part;
          const delta = evt.properties?.delta;
          if (!part) continue;

          // Track thinking gaps with phase labels
          const gap = now - timings.lastEventTime;
          if (gap > 1500 && timings.currentToolStart === null) {
            const phase = !timings.seenFirstTool
              ? "initial"
              : timings.lastCompletedTool
                ? `after:${timings.lastCompletedTool}`
                : "thinking";
            const segment: ThinkingSegment = {
              phase,
              durationMs: gap,
              afterToolOutput: timings.lastToolOutput
                ? truncate(timings.lastToolOutput, 80)
                : undefined,
            };
            timings.thinkingSegments.push(segment);
            process.stdout.write(
              dim(
                `  [thinking ${(gap / 1000).toFixed(1)}s] ${dim(`(${phase})`)}\n`,
              ),
            );
          }
          timings.lastEventTime = now;

          if (part.type === "text") {
            if (delta) process.stdout.write(delta);
          } else if (part.type === "tool") {
            const state = part.state;
            const toolName = part.tool || "?";
            if (state?.status === "pending") {
              timings.currentToolStart = now;
              timings.toolCalls++;
              timings.seenFirstTool = true;
              process.stdout.write(
                `\n${cyan(`[${toolName}]`)} ${dim("calling")}${state.input ? " " + dim(truncate(JSON.stringify(state.input), 100)) : ""}\n`,
              );
            } else if (state?.status === "completed") {
              const toolDuration = timings.currentToolStart
                ? now - timings.currentToolStart
                : 0;
              timings.toolTimeMs += toolDuration;
              timings.currentToolStart = null;
              const output = state.output ?? state.result ?? "";
              const outputStr =
                typeof output === "string" ? output : JSON.stringify(output);
              timings.lastCompletedTool = toolName;
              timings.lastToolOutput = outputStr;

              // Detect escalation request from the escalate tool
              if (toolName === "escalate") {
                timings.escalateRequested = true;
              }

              // Detect completion page from scan_page_for_code
              if (toolName === "scan_page_for_code") {
                if (outputStr.includes("STATUS: COMPLETED")) {
                  timings.lastEnterCodeUrl = "completion";
                }
              }

              // Capture URL from enter_code output: "OK: "CODE" | https://..."
              // Keep the highest step URL seen (not the last), because the LLM
              // may enter multiple codes — a correct one that advances the page,
              // then a wrong one on the new page that "stays" on the old step URL.
              if (toolName === "enter_code") {
                const urlMatch = outputStr.match(/\|\s*(https?:\/\/[^\s]+)/);
                if (urlMatch) {
                  const newUrl = urlMatch[1];
                  const newStep = getStepFromUrl(newUrl);
                  const currentStep = getStepFromUrl(
                    timings.lastEnterCodeUrl || "",
                  );
                  if (!currentStep || (newStep && newStep > currentStep)) {
                    timings.lastEnterCodeUrl = newUrl;
                  }
                }
              }

              process.stdout.write(
                `${cyan(`[${toolName}]`)} ${green("done")} ${dim(`(${(toolDuration / 1000).toFixed(1)}s)`)} ${dim(truncate(outputStr, 150))}\n`,
              );
            } else if (state?.status === "error") {
              timings.currentToolStart = null;
              process.stdout.write(
                `${cyan(`[${toolName}]`)} ${red("error")} ${state.error || ""}\n`,
              );
            }
          } else if (part.type === "step-finish") {
            const tokens = part.tokens;
            if (tokens) {
              process.stdout.write(
                dim(`--- step (in:${tokens.input} out:${tokens.output}) ---\n`),
              );
            }
          }
        } else if (type === "session.error") {
          process.stdout.write(
            `\n${red("[error]")} ${(evt.properties as any)?.error || "?"}\n`,
          );
        }
      }
    } catch {
      // Stream closed
    }
  })();

  // ---- Main challenge loop (URL-driven, no expectedStep counter) ----
  let lastKnownStep = 1; // Derived from browser URL — the source of truth
  let attemptForStep = 0; // 0-indexed: which model in the ladder to use
  let isFirstChallenge = true;
  let totalRegressions = 0; // Safety counter to prevent infinite regression loops
  const challengeResults: Array<{
    step: number;
    timeMs: number;
    tools: number;
    success: boolean;
    model: string;
  }> = [];

  while (lastKnownStep <= MAX_CHALLENGES) {
    timings = newTimings();
    const currentStep = lastKnownStep;
    const model = getModelForAttempt(attemptForStep);

    if (attemptForStep === 0) {
      console.log(
        bold(`\n${"=".repeat(20)} Challenge ${currentStep} ${"=".repeat(20)}`),
      );
    } else {
      console.log(
        yellow(
          `\n  Attempt ${attemptForStep + 1}/${MAX_ATTEMPTS} — escalating to ${bold(model.modelID)}`,
        ),
      );
    }

    // --- Abort-on-escalate state (declared outside try so catch can access) ---
    let abortedForEscalate = false;
    let escalateWatcherDone = false;

    try {
      // Fresh session per challenge (context isolation)
      const sessionResult = await client.session.create({
        title: `Step ${currentStep} (attempt ${attemptForStep + 1}, ${model.modelID})`,
      });
      const sessionId = sessionResult.data!.id;

      // Build instruction — first challenge gets URL, subsequent ones don't
      let instruction: string;
      if (isFirstChallenge) {
        instruction = `Navigate to the challenge and solve it. Call scan_page_for_code with url="${CHALLENGE_URL}" and navigate=true to open the page (it will auto-click START). Then find the code and call enter_code to submit it. STOP after entering the code.`;
        isFirstChallenge = false;
      } else {
        instruction = `Solve this challenge step. Call scan_page_for_code to read the page and find the code, then call enter_code to submit it. Do NOT navigate away. STOP after entering the code.`;
      }

      // Select prompt and tools based on model — haiku gets escalate tool, opus gets full playbooks
      const isOpus =
        model.modelID === MODEL_LADDER[MODEL_LADDER.length - 1].modelID;
      const systemPrompt = isOpus ? SYSTEM_PROMPT_OPUS : SYSTEM_PROMPT_HAIKU;
      const tools = isOpus ? TOOLS_WITHOUT_ESCALATE : TOOLS_WITH_ESCALATE;

      const promptPromise = client.session.prompt({
        sessionID: sessionId,
        model,
        system: systemPrompt,
        tools,
        parts: [{ type: "text" as const, text: instruction }],
      });

      // Watch for escalate tool call on non-opus models — abort and switch to opus
      if (model.modelID !== MODEL_LADDER[MODEL_LADDER.length - 1].modelID) {
        (async () => {
          while (!escalateWatcherDone) {
            await new Promise((r) => setTimeout(r, 200));

            if (timings.escalateRequested && !timings.lastEnterCodeUrl) {
              abortedForEscalate = true;
              console.log(
                yellow(
                  `\n  Escalate requested — aborting ${model.modelID}, escalating to opus`,
                ),
              );
              try {
                await client.session.abort({ sessionID: sessionId });
              } catch (e: any) {
                console.log(dim(`  abort() error (non-fatal): ${e.message}`));
              }
              return;
            }

            if (timings.lastEnterCodeUrl) return;
          }
        })();
      }

      const result = await promptPromise.finally(() => {
        escalateWatcherDone = true;
      });

      // If we aborted for escalation, skip to opus
      if (abortedForEscalate) {
        attemptForStep = 1;
        continue;
      }

      const message = result.data as any;
      const challengeTime = Date.now() - timings.challengeStart;
      const thinkingTime = challengeTime - timings.toolTimeMs;

      // Print timing summary
      console.log(
        magenta(
          `\n  Timing: ${(challengeTime / 1000).toFixed(1)}s total | ` +
            `${(timings.toolTimeMs / 1000).toFixed(1)}s tools (${timings.toolCalls} calls) | ` +
            `${(thinkingTime / 1000).toFixed(1)}s model thinking` +
            ` | ${model.modelID}`,
        ),
      );

      if (timings.thinkingSegments.length > 0) {
        const segments = timings.thinkingSegments
          .map((s) => `${s.phase}:${(s.durationMs / 1000).toFixed(1)}s`)
          .join(", ");
        console.log(dim(`  Thinking breakdown: [${segments}]`));
        for (const seg of timings.thinkingSegments) {
          if (seg.durationMs > 5000) {
            console.log(
              yellow(
                `  SLOW thinking: ${(seg.durationMs / 1000).toFixed(1)}s in "${seg.phase}"${seg.afterToolOutput ? ` after: ${dim(seg.afterToolOutput)}` : ""}`,
              ),
            );
          }
        }
      }

      if (!message || !message.parts) {
        console.log(yellow("  No response from model"));
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: false,
          model: model.modelID,
        });
        attemptForStep++;
        if (attemptForStep >= MAX_ATTEMPTS) {
          console.log(
            red(
              `  All ${MAX_ATTEMPTS} models failed on step ${currentStep}. Skipping.`,
            ),
          );
          attemptForStep = 0;
          lastKnownStep = currentStep + 1;
        }
        continue;
      }

      // ---- Determine outcome from browser URL (source of truth) ----
      const afterUrl = timings.lastEnterCodeUrl || "";
      const afterStep = afterUrl ? getStepFromUrl(afterUrl) : null;

      if (afterUrl) {
        console.log(dim(`  Page URL: ${afterUrl}`));
      }

      // Check for completion page
      if (
        afterUrl === "completion" ||
        afterUrl.includes("congratulations") ||
        afterUrl.includes("complete")
      ) {
        console.log(green("\n=== All challenges completed! ==="));
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: true,
          model: model.modelID,
        });
        break;
      }

      if (afterStep && afterStep > currentStep) {
        // Success — page advanced
        console.log(
          green(
            `  Step ${currentStep} solved! Page now on step ${afterStep}${attemptForStep > 0 ? ` (needed ${model.modelID})` : ""}`,
          ),
        );
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: true,
          model: model.modelID,
        });
        lastKnownStep = afterStep;
        attemptForStep = 0;
      } else if (afterStep && afterStep < currentStep) {
        // Browser regressed (page reloaded, navigated away, etc.) — reset to actual position
        totalRegressions++;
        console.log(
          yellow(
            `  Browser regressed to step ${afterStep} (was on step ${currentStep}). Resetting to step ${afterStep}.`,
          ),
        );
        lastKnownStep = afterStep;
        attemptForStep = 0;
        if (totalRegressions > 10) {
          console.log(red("  Too many regressions. Stopping."));
          break;
        }
        // Don't record as failure — just continue from new position
      } else {
        // afterStep === currentStep OR no URL captured → failed to advance
        if (!afterStep && !afterUrl) {
          console.log(
            yellow(`  No URL captured — assuming still on step ${currentStep}`),
          );
        } else {
          console.log(
            yellow(`  Still on step ${currentStep} — ${model.modelID} failed`),
          );
        }
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: false,
          model: model.modelID,
        });
        attemptForStep++;
        if (attemptForStep >= MAX_ATTEMPTS) {
          console.log(
            red(
              `  All ${MAX_ATTEMPTS} models failed on step ${currentStep}. Skipping.`,
            ),
          );
          attemptForStep = 0;
          lastKnownStep = currentStep + 1;
        }
      }
    } catch (err: any) {
      // If we aborted for escalation, the prompt throws — handle it gracefully
      if (
        abortedForEscalate ||
        (timings.escalateRequested &&
          attemptForStep === 0 &&
          !timings.lastEnterCodeUrl)
      ) {
        console.log(yellow(`  Aborted ${model.modelID} — escalating to opus`));
        attemptForStep = 1;
        continue;
      }

      const challengeTime = Date.now() - timings.challengeStart;
      const errorModel = getModelForAttempt(attemptForStep);
      console.error(
        red(
          `  Error on step ${currentStep} (${errorModel.modelID}): ${err.message}`,
        ),
      );
      challengeResults.push({
        step: currentStep,
        timeMs: challengeTime,
        tools: timings.toolCalls,
        success: false,
        model: errorModel.modelID,
      });
      attemptForStep++;
      if (attemptForStep >= MAX_ATTEMPTS) {
        console.log(
          red(
            `  All ${MAX_ATTEMPTS} models failed on step ${currentStep}. Skipping.`,
          ),
        );
        attemptForStep = 0;
        lastKnownStep = currentStep + 1;
      }
    }
  }

  // ---- Final summary ----
  const totalTime = Date.now() - totalStart;
  console.log(bold("\n" + "=".repeat(60)));
  console.log(bold("FINAL SUMMARY"));
  console.log(bold("=".repeat(60)));
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(
    `Model ladder: ${MODEL_LADDER.map((m) => m.modelID).join(" → ")}`,
  );

  // Count unique steps attempted (not individual attempts)
  const stepsAttempted = new Set(challengeResults.map((r) => r.step)).size;
  const successes = challengeResults.filter((r) => r.success).length;
  const escalations = challengeResults.filter(
    (r) => r.success && r.model !== MODEL_LADDER[0].modelID,
  ).length;
  console.log(`Steps attempted: ${stepsAttempted}`);
  console.log(`Solved: ${successes}/${stepsAttempted}`);
  if (escalations > 0) {
    console.log(
      `Escalations needed: ${escalations} (solved by stronger model)`,
    );
  }
  console.log(
    `Total attempts: ${challengeResults.length} (${challengeResults.length - stepsAttempted} retries)`,
  );
  console.log(
    `Avg per step: ${stepsAttempted > 0 ? (totalTime / stepsAttempted / 1000).toFixed(1) : 0}s`,
  );
  console.log(
    `Avg tool calls: ${challengeResults.length > 0 ? (challengeResults.reduce((s, r) => s + r.tools, 0) / challengeResults.length).toFixed(1) : 0}`,
  );
  console.log("");

  // Group results by step for display
  const stepMap = new Map<number, typeof challengeResults>();
  for (const r of challengeResults) {
    if (!stepMap.has(r.step)) stepMap.set(r.step, []);
    stepMap.get(r.step)!.push(r);
  }
  for (const [step, attempts] of stepMap) {
    const success = attempts.find((a) => a.success);
    if (success) {
      const escalation =
        attempts.length > 1
          ? dim(
              ` (${attempts.length} attempts: ${attempts.map((a) => a.model.replace("claude-", "")).join(" → ")})`,
            )
          : "";
      console.log(
        `  Step ${String(step).padStart(2)}: ${green("OK")} ${(success.timeMs / 1000).toFixed(1)}s (${success.tools} tools, ${success.model})${escalation}`,
      );
    } else {
      const models = attempts
        .map((a) => a.model.replace("claude-", ""))
        .join(", ");
      console.log(
        `  Step ${String(step).padStart(2)}: ${red("FAIL")} (${attempts.length} attempts: ${models})`,
      );
    }
  }

  console.log("\nDone. Browser left open for debugging. Press Ctrl+C to exit.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
});
