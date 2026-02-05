/**
 * Tool: scan_page_for_code (Phase 2+4 mega-tool)
 *
 * Combines page reading + code scanning + popup dismissal + AUTO-SOLVE into ONE tool call.
 * Auto-detects common challenge patterns (scroll, wait, click reveal, click N times, hover)
 * and executes them automatically before returning results.
 *
 * Returns: page content, found codes, auto-actions taken, and current URL.
 */
import { toolDefinition } from "@tanstack/ai"
import { z } from "zod"
import { NodeHtmlMarkdown } from "node-html-markdown"
import { getPage } from "./browser"
import { dismissPopups } from "./dismiss-helper"

// Blacklist of data-* attribute names that are never codes
const DATA_ATTR_BLACKLIST = new Set([
  "data-state", "data-orientation", "data-side", "data-align",
  "data-radix-collection-item", "data-radix-popper-content-wrapper",
  "data-radix-focus-guard", "data-radix-portal",
  "data-slot", "data-testid", "data-reactid", "data-reactroot",
  "data-v", "data-n-head", "data-hid",
  "data-disabled", "data-highlighted", "data-placeholder",
  "data-dismiss", "data-toggle", "data-target", "data-bs-dismiss",
  "data-bs-toggle", "data-bs-target",
])

// Blacklist of values that are never codes
const VALUE_BLACKLIST = new Set([
  "unchecked", "checked", "true", "false", "open", "closed",
  "horizontal", "vertical", "left", "right", "top", "bottom",
  "start", "end", "center",
])

/** Scan page for code candidates */
async function scanForCodes(page: any): Promise<Array<{ src: string; val: string }>> {
  const codes = await page.evaluate((bl: { attrs: string[]; vals: string[] }) => {
    const found: Array<{ src: string; val: string }> = []
    const seen = new Set<string>()
    const attrBL = new Set(bl.attrs)
    const valBL = new Set(bl.vals)

    const add = (src: string, val: string) => {
      val = val.trim()
      if (!val || val.length < 2 || val.length >= 150 || seen.has(val)) return
      if (valBL.has(val.toLowerCase())) return
      seen.add(val)
      found.push({ src, val })
    }

    // Code-like elements (highest priority)
    for (const sel of ["code","pre","kbd","mark",'[data-code]','[data-secret]','[data-answer]','[data-value]']) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const text = (el as HTMLElement).innerText || ""
          if (text) add(`el:${sel}`, text)
          for (const a of el.attributes) {
            if (a.name.startsWith("data-") && a.value && !attrBL.has(a.name))
              add(`attr:${a.name}`, a.value)
          }
        }
      } catch {}
    }

    // Interesting data-* attrs only (skip blacklisted)
    for (const el of document.querySelectorAll("*")) {
      for (const a of el.attributes) {
        if (!a.name.startsWith("data-") || !a.value || a.value.length < 3 || a.value.length >= 100) continue
        if (attrBL.has(a.name)) continue
        add(`attr:${a.name}`, a.value)
      }
    }

    // Hidden leaf elements with actual text
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length > 0) continue
      const s = window.getComputedStyle(el)
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0" ||
          el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
        const text = (el as HTMLElement).innerText || (el as HTMLElement).textContent || ""
        if (text && text.length >= 3 && text.length < 100) add("hidden", text)
      }
    }

    // Regex patterns in visible body text
    const body = document.body?.innerText || ""
    const pats = [
      /\b(?:code|key|secret|pass(?:phrase)?|answer|token)\s*[:=]\s*["']?([A-Za-z0-9\-_!@#$%^&*]{3,50})["']?/gi,
      /\b([A-Z0-9]{2,8}[-][A-Z0-9]{2,8}(?:[-][A-Z0-9]{2,8})*)\b/g,
      // Standalone alphanumeric codes: 4-8 uppercase+digit combos that mix letters and numbers
      // Must have at least one letter AND one digit to avoid matching normal words/numbers
      /\b([A-Z0-9]{4,8})\b/g,
    ]
    // For the standalone pattern, filter to only codes with both letters and digits
    const standaloneFilter = (val: string) => /[A-Z]/.test(val) && /[0-9]/.test(val)
    for (let pi = 0; pi < pats.length; pi++) {
      const p = pats[pi]
      let m
      while ((m = p.exec(body)) !== null) {
        const val = m[1] || m[0]
        // For the standalone alphanumeric pattern (last one), require mixed letters+digits
        if (pi === pats.length - 1 && !standaloneFilter(val)) continue
        add("pattern", val)
      }
    }

    return found
  }, { attrs: [...DATA_ATTR_BLACKLIST], vals: [...VALUE_BLACKLIST] })

  // HTML comments from raw source
  const raw = await page.content()
  const commentRe = /<!--([\s\S]*?)-->/g
  let m
  while ((m = commentRe.exec(raw)) !== null) {
    const c = m[1].trim()
    if (c.length > 1 && c.length < 200 && !c.startsWith("[if ")) {
      codes.push({ src: "comment", val: c })
    }
  }

  return codes
}

/** Read minimal page content and convert to markdown */
async function readPage(page: any): Promise<{ url: string; title: string; markdown: string; bodyText: string }> {
  const raw = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement
    clone.querySelectorAll(
      "script, style, noscript, iframe, link, svg, path, img, picture, source, video, audio, canvas, meta"
    ).forEach((el) => el.remove())

    // Strip class/style attrs
    clone.querySelectorAll("*").forEach((el) => {
      el.removeAttribute("class")
      el.removeAttribute("style")
      const keep = new Set(["id","name","type","value","placeholder","href","role","aria-label","aria-hidden","disabled","hidden","for","checked","selected","data-code","data-secret","data-answer","data-value"])
      const toRemove: string[] = []
      for (const attr of el.attributes) {
        if (!keep.has(attr.name) && !attr.name.startsWith("data-")) toRemove.push(attr.name)
      }
      toRemove.forEach((a) => el.removeAttribute(a))
    })

    let html = clone.innerHTML.replace(/\n\s*\n/g, "\n").replace(/\s{2,}/g, " ").trim()
    return {
      url: window.location.href,
      title: document.title,
      html,
      bodyText: document.body?.innerText?.substring(0, 2000) || "",
    }
  })

  // Convert cleaned HTML to markdown on the Node side
  const markdown = NodeHtmlMarkdown.translate(raw.html)

  return {
    url: raw.url,
    title: raw.title,
    markdown,
    bodyText: raw.bodyText,
  }
}

// --- Auto-solve patterns ---

interface AutoAction {
  type: string
  detail: string
}

async function autoSolve(page: any, bodyText: string): Promise<AutoAction[]> {
  const actions: AutoAction[] = []
  const lower = bodyText.toLowerCase()

  // 1. Auto-scroll: "scroll down 500px" / "Scrolled: 0px / 500px" / "scroll to 800px"
  const scrollProgressMatch = lower.match(/scrolled[:\s]*(\d+)\s*px\s*\/\s*(\d+)\s*px/)
  const scrollInstructionMatch = lower.match(/scroll\s+(?:down\s+)?(?:to\s+)?(\d+)\s*px/i)
  if (scrollProgressMatch) {
    const current = parseInt(scrollProgressMatch[1], 10)
    const target = parseInt(scrollProgressMatch[2], 10)
    if (current !== target && target > 0 && target <= 10000) {
      await page.evaluate((px: number) => window.scrollTo(0, px), target)
      await page.waitForTimeout(500)
      actions.push({ type: "scroll", detail: `to ${target}px (was ${current}px)` })
    }
  } else if (scrollInstructionMatch) {
    const target = parseInt(scrollInstructionMatch[1], 10)
    if (target > 0 && target <= 10000) {
      await page.evaluate((px: number) => window.scrollTo(0, px), target)
      await page.waitForTimeout(500)
      actions.push({ type: "scroll", detail: `to ${target}px` })
    }
  }

  // 2. Auto-wait: "appear after waiting 4 seconds" / "after 6 seconds" / "wait 3 seconds"
  const waitMatch = lower.match(/(?:after\s+(?:waiting\s+)?|wait\s+|in\s+)(\d+)\s*second/i)
  if (waitMatch) {
    const waitSec = parseInt(waitMatch[1], 10)
    if (waitSec > 0 && waitSec <= 30) {
      await page.waitForTimeout(waitSec * 1000 + 500) // +500ms buffer
      actions.push({ type: "wait", detail: `${waitSec}s` })
    }
  }

  // 3. Auto-click reveal: buttons like "Reveal Code", "Show Code", "Click to Reveal"
  const revealClicked = await page.evaluate(() => {
    const revealPatterns = [
      /reveal\s*code/i, /show\s*code/i, /click\s*to\s*reveal/i,
      /reveal\s*the\s*code/i, /show\s*the\s*code/i, /get\s*code/i,
      /unlock\s*code/i, /generate\s*code/i, /reveal$/i,
    ]
    for (const btn of document.querySelectorAll("button, [role='button']")) {
      const el = btn as HTMLElement
      try {
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden") continue
      } catch { continue }
      const text = el.innerText?.trim() || ""
      if (revealPatterns.some(p => p.test(text))) {
        el.click()
        return text
      }
    }
    return null
  })
  if (revealClicked) {
    await page.waitForTimeout(800)
    actions.push({ type: "click-reveal", detail: revealClicked })
  }

  // 4. Auto-click N times: "click here 3 more times" / "click X more times to reveal"
  const clickNMatch = lower.match(/click\s+(?:here\s+)?(\d+)\s+more\s+time/i)
  if (clickNMatch) {
    const n = parseInt(clickNMatch[1], 10)
    if (n > 0 && n <= 20) {
      const clicked = await page.evaluate((times: number) => {
        // Find the element containing "more time" text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node
        let target: HTMLElement | null = null
        while ((node = walker.nextNode())) {
          if (node.textContent?.toLowerCase().includes("more time")) {
            // Walk up to find a clickable ancestor
            let el = node.parentElement
            while (el && el !== document.body) {
              const cls = (el.className || '').toString()
              if (cls.includes("cursor-pointer") || el.style.cursor === "pointer" ||
                  el.tagName === "BUTTON" || el.getAttribute("role") === "button" ||
                  el.onclick) {
                target = el
                break
              }
              el = el.parentElement
            }
            if (!target) target = node.parentElement
            break
          }
        }
        if (target) {
          for (let i = 0; i < times; i++) {
            target.click()
          }
          return times
        }
        return 0
      }, n)
      if (clicked > 0) {
        await page.waitForTimeout(500)
        actions.push({ type: "click-n", detail: `${clicked} times` })
      }
    }
  }

  // 5. Auto-hover: "hover over" / "hover on" / "mouse over"
  if (lower.includes("hover") || lower.includes("mouse over")) {
    // Use Playwright's real hover (dispatches proper events unlike JS-only)
    const hoverTarget = await page.evaluate(() => {
      const candidates = document.querySelectorAll('[data-hover], [class*="hover"], [class*="target"], .cursor-pointer, [class*="Hover"]')
      for (const el of candidates) {
        const htmlEl = el as HTMLElement
        try {
          const style = window.getComputedStyle(htmlEl)
          if (style.display === "none" || style.visibility === "hidden") continue
        } catch { continue }
        // Return a selector we can use with Playwright
        if (htmlEl.id) return `#${htmlEl.id}`
        const cls = htmlEl.className?.toString().split(" ")[0]
        if (cls) return `.${cls}`
        return null
      }
      return null
    })
    if (hoverTarget) {
      try {
        await page.hover(hoverTarget, { timeout: 2000 })
        await page.waitForTimeout(800)
        actions.push({ type: "hover", detail: hoverTarget })
      } catch {}
    }
  }

  return actions
}

// --- Tool definition ---

const scanPageDef = toolDefinition({
  name: "scan_page_for_code",
  description:
    "ALL-IN-ONE: Dismiss popups, read page, scan for codes, AND auto-solve common patterns (scroll, wait, click reveal, click N times, hover). Use as FIRST tool call on every challenge.",
  inputSchema: z.object({
    url: z.string().optional().describe("URL to navigate to before scanning. Navigation only occurs if navigate=true."),
    version: z.string().optional().describe("Optional version query param (used for step routes)."),
    navigate: z.boolean().optional().describe("Set true to allow Playwright navigation to url."),
    noAuto: z.boolean().optional().describe("Set true to skip auto-solve (just read + scan)."),
  }),
})

export const scanPageForCode = scanPageDef.server(async (args) => {
  const page = await getPage()

  // Navigate only when explicitly allowed (avoid losing in-page progress)
  const rawUrl = args.url?.trim()
  const hasUrl = !!rawUrl && rawUrl.toLowerCase() !== "placeholder"
  let requestedStep: number | null = null
  let requestedVersion: string | null = null
  let baseUrl: string | null = null

  const overrideVersion = args.version?.trim()

  if (hasUrl) {
    try {
      const urlObj = new URL(rawUrl!)
      const stepMatch = urlObj.pathname.match(/\/step(\d+)/)
      if (stepMatch) {
        requestedStep = parseInt(stepMatch[1], 10)
        requestedVersion =
          overrideVersion || urlObj.searchParams.get("version") || "2"
        baseUrl = `${urlObj.origin}/`
      }
    } catch {}
  }

  if (args.navigate && hasUrl) {
    let targetUrl = requestedStep && baseUrl ? baseUrl : rawUrl!
    if (!requestedStep && overrideVersion) {
      try {
        const targetObj = new URL(targetUrl)
        if (!targetObj.searchParams.has("version")) {
          targetObj.searchParams.set("version", overrideVersion)
        }
        targetUrl = targetObj.toString()
      } catch {}
    }
    const currentUrl = page.url()
    if (currentUrl !== targetUrl) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 })
      await page.waitForTimeout(1500)
    }

    if (!requestedStep) {
      // Click START button if present
      try {
        const startBtn = page.locator('button:has-text("START")')
        if (await startBtn.isVisible({ timeout: 2000 })) {
          await startBtn.click()
          await page.waitForTimeout(1500)
        }
      } catch {}
    } else if (requestedVersion) {
      // Client-side jump to step after React is ready
      await page.waitForTimeout(1000)
      await page.evaluate(
        ({ step, version }: { step: number; version: string }) => {
          const jump = (window as any).jumpTo
          if (typeof jump === "function") {
            jump(step)
            return
          }
          const path = `/step${step}?version=${version}`
          history.pushState(null, "", path)
          window.dispatchEvent(new PopStateEvent("popstate"))
        },
        { step: requestedStep, version: requestedVersion },
      )
      await page.waitForTimeout(1200)
    }
  }

  // 1. Dismiss popups
  const dismissed = await dismissPopups(page)

  // 3. Read page content + scan for codes
  let content = await readPage(page)
  let codes = await scanForCodes(page)

  // 4. Auto-solve common patterns
  let autoActions: AutoAction[] = []
  if (!args.noAuto) {
    autoActions = await autoSolve(page, content.bodyText)

    // If we took any auto-actions, re-scan for codes
    if (autoActions.length > 0) {
      await dismissPopups(page)
      content = await readPage(page)
      codes = await scanForCodes(page)
    }
  }

  // 5. Detect if this is a completion/congratulations page
  const lowerBody = content.bodyText.toLowerCase()
  const isCompletion = /congratulations|you\s+(did\s+it|completed|finished|won)|all\s+challenges?\s+(completed|done|solved)/.test(lowerBody)
  if (isCompletion) {
    return JSON.stringify({
      url: content.url,
      status: "COMPLETED",
      message: "All challenges finished!",
      pageContent: content.markdown.substring(0, 2000),
    })
  }

  // 6. Build compact output
  const parts: string[] = []
  parts.push(`URL: ${content.url}`)
  if (dismissed > 0) parts.push(`Popups dismissed: ${dismissed}`)

  if (autoActions.length > 0) {
    parts.push(`Auto: ${autoActions.map(a => `${a.type}(${a.detail})`).join(", ")}`)
  }

  if (codes.length > 0) {
    parts.push(`\nCODE CANDIDATES:`)
    codes.slice(0, 10).forEach((c) => parts.push(`  [${c.src}] ${c.val}`))
  } else {
    parts.push(`\nNo code candidates found.`)
  }

  // Always include page content — model needs it to figure out interactions when auto-solve misses
  // But trim more aggressively if we found a strong code candidate
  const hasStrongCode = codes.some(c =>
    c.src.startsWith("el:code") || c.src.startsWith("el:kbd") || c.src.startsWith("el:mark") ||
    c.src === "pattern" || c.src.startsWith("el:[data-code") || c.src.startsWith("el:[data-secret") ||
    c.src.startsWith("el:[data-answer")
  )
  parts.push(`\nPAGE CONTENT:\n${hasStrongCode ? content.markdown.substring(0, 2000) : content.markdown.substring(0, 6000)}`)

  return JSON.stringify({ output: parts.join("\n") })
})
