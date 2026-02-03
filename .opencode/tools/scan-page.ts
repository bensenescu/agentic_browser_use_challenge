/**
 * Tool: scan_page (Phase 2+4 mega-tool)
 *
 * Combines page reading + code scanning + popup dismissal + AUTO-SOLVE into ONE tool call.
 * Auto-detects common challenge patterns (scroll, wait, click reveal, click N times, hover)
 * and executes them automatically before returning results.
 *
 * Returns: page content, found codes, auto-actions taken, and current URL.
 */
import { tool } from "@opencode-ai/plugin"
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
    ]
    for (const p of pats) {
      let m
      while ((m = p.exec(body)) !== null) add("pattern", m[1] || m[0])
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

/** Read minimal page content */
async function readPage(page: any): Promise<{ url: string; title: string; html: string; bodyText: string }> {
  return await page.evaluate(() => {
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
      html: html.substring(0, 2500),
      bodyText: document.body?.innerText?.substring(0, 2000) || "",
    }
  })
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
      // Scroll to absolute target position (handles both up and down)
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

// --- Main tool ---

export default tool({
  description:
    "ALL-IN-ONE: Dismiss popups, read page, scan for codes, AND auto-solve common patterns (scroll, wait, click reveal, click N times, hover). Use as FIRST tool call on every challenge.",
  args: {
    url: tool.schema
      .string()
      .optional()
      .describe("URL to navigate to before scanning. Only used for initial navigation."),
    noAuto: tool.schema
      .boolean()
      .optional()
      .describe("Set true to skip auto-solve (just read + scan)."),
  },
  async execute(args) {
    const page = await getPage()

    // Navigate if URL provided (first challenge only)
    if (args.url) {
      await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 15000 })
      await page.waitForTimeout(1500)

      // Click START button if present
      try {
        const startBtn = page.locator('button:has-text("START")')
        if (await startBtn.isVisible({ timeout: 2000 })) {
          await startBtn.click()
          await page.waitForTimeout(1500)
        }
      } catch {}
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

    // 5. Build compact output
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

    // Always include HTML — model needs it to figure out interactions when auto-solve misses
    // But trim more aggressively if we found a strong code candidate
    const hasStrongCode = codes.some(c =>
      c.src.startsWith("el:code") || c.src.startsWith("el:kbd") || c.src.startsWith("el:mark") ||
      c.src === "pattern" || c.src.startsWith("el:[data-code") || c.src.startsWith("el:[data-secret") ||
      c.src.startsWith("el:[data-answer")
    )
    parts.push(`\nHTML:\n${hasStrongCode ? content.html.substring(0, 800) : content.html}`)

    return parts.join("\n")
  },
})
