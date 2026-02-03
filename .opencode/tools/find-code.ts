/**
 * Tool: find_code
 *
 * Scans the current page for anything that looks like a code, passphrase,
 * secret key, or challenge answer. Returns a compact list of top candidates.
 */
import { tool } from "@opencode-ai/plugin"
import { getPage } from "./browser"

export default tool({
  description:
    "Deep-scan the page for hidden codes: data attributes, hidden elements, HTML comments, regex patterns. Returns top candidates only.",
  args: {
    hint: tool.schema
      .string()
      .optional()
      .describe("Optional hint (e.g. 'alphanumeric', '6 digits', 'starts with KEY-')."),
  },
  async execute(args) {
    const page = await getPage()

    const results = await page.evaluate((hint: string | undefined) => {
      const codes: Array<{ src: string; val: string }> = []
      const seen = new Set<string>()

      const add = (src: string, val: string) => {
        val = val.trim()
        if (val && val.length >= 2 && val.length < 150 && !seen.has(val)) {
          seen.add(val)
          codes.push({ src, val })
        }
      }

      // 1. Code-like elements
      const sels = [
        "code", "pre", "kbd", "mark",
        '[data-code]', '[data-secret]', '[data-key]', '[data-answer]', '[data-value]',
        '[class*="code"]', '[class*="secret"]', '[class*="key"]', '[class*="answer"]',
        '[class*="highlight"]',
      ]
      for (const sel of sels) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            add(`el:${sel}`, (el as HTMLElement).innerText || "")
            // data-* attrs
            for (const a of el.attributes) {
              if (a.name.startsWith("data-") && a.value) add(`attr:${a.name}`, a.value)
            }
          }
        } catch {}
      }

      // 2. ALL data-* attributes on the page (not just code-like elements)
      for (const el of document.querySelectorAll("*")) {
        for (const a of el.attributes) {
          if (a.name.startsWith("data-") && a.value && a.value.length >= 3 && a.value.length < 100) {
            add(`attr:${a.name}`, a.value)
          }
        }
      }

      // 3. Hidden/invisible leaf elements
      for (const el of document.querySelectorAll("*")) {
        if (el.children.length > 0) continue
        const s = window.getComputedStyle(el)
        if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0" ||
            el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
          add("hidden", (el as HTMLElement).innerText || (el as HTMLElement).textContent || "")
        }
      }

      // 4. Regex patterns in body text
      const body = document.body?.innerText || ""
      const pats = [
        /\b(?:code|key|secret|pass(?:phrase)?|answer|token)\s*[:=]\s*["']?([A-Za-z0-9\-_!@#$%^&*]{3,50})["']?/gi,
        /\b([A-Z0-9]{2,8}[-][A-Z0-9]{2,8}(?:[-][A-Z0-9]{2,8})*)\b/g,
      ]
      for (const p of pats) {
        let m
        while ((m = p.exec(body)) !== null) {
          add("pattern", m[1] || m[0])
        }
      }

      return codes
    }, args.hint)

    // 5. HTML comments from raw source
    const raw = await page.content()
    const commentRe = /<!--([\s\S]*?)-->/g
    let m
    while ((m = commentRe.exec(raw)) !== null) {
      const c = m[1].trim()
      if (c.length > 1 && c.length < 200) {
        results.push({ src: "comment", val: c })
      }
    }

    if (results.length === 0) {
      return "No codes found."
    }

    // Return compact format — max 20 candidates
    return results
      .slice(0, 20)
      .map((r) => `[${r.src}] ${r.val}`)
      .join("\n")
  },
})
