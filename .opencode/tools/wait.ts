/**
 * Tool: wait
 *
 * Last-resort tool. Waits briefly then re-scans for codes.
 * Only use this after all other approaches have failed.
 * Never wait more than 1 second unless you have strong evidence
 * that a longer delay is required.
 */
import { tool } from "@opencode-ai/plugin"
import { getPage } from "./browser"
import { dismissPopups } from "./dismiss-helper"

export default tool({
  description:
    "LAST RESORT: Wait then re-scan for codes. Only use this if you cannot figure out any other way to unlock the code. Never wait more than 1 second unless you have strong evidence a longer delay is needed.",
  args: {
    seconds: tool.schema
      .number()
      .optional()
      .describe("Seconds to wait. Defaults to 1. Never exceed 1 unless absolutely certain."),
  },
  async execute(args) {
    const page = await getPage()
    const secs = Math.max(1, Math.min(30, Math.round(args.seconds ?? 1)))

    await page.waitForTimeout(secs * 1000 + 500) // +500ms buffer

    // Dismiss any popups that appeared during the wait
    const dismissed = await dismissPopups(page)

    // Scan for codes after waiting
    const codes = await page.evaluate(() => {
      const found: Array<{ src: string; val: string }> = []
      const seen = new Set<string>()

      const add = (src: string, val: string) => {
        val = val.trim()
        if (!val || val.length < 2 || val.length >= 150 || seen.has(val)) return
        seen.add(val)
        found.push({ src, val })
      }

      // Code-like elements
      for (const sel of ["code", "pre", "kbd", "mark", "[data-code]", "[data-secret]", "[data-answer]", "[data-value]"]) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            const text = (el as HTMLElement).innerText || ""
            if (text) add(`el:${sel}`, text)
          }
        } catch {}
      }

      // Hidden elements that may now be visible
      for (const el of document.querySelectorAll("*")) {
        if (el.children.length > 0) continue
        const text = (el as HTMLElement).innerText || (el as HTMLElement).textContent || ""
        if (text && text.length >= 3 && text.length < 100) {
          if (/^[A-Z0-9]{4,8}$/.test(text.trim()) && /[A-Z]/.test(text) && /[0-9]/.test(text)) {
            add("post-wait", text)
          }
        }
      }

      // Regex patterns in body text
      const body = document.body?.innerText || ""
      const pats = [
        /\b(?:code|key|secret|answer|token)\s*[:=]\s*["']?([A-Za-z0-9\-_!@#$%^&*]{3,50})["']?/gi,
        /\b([A-Z0-9]{2,8}[-][A-Z0-9]{2,8}(?:[-][A-Z0-9]{2,8})*)\b/g,
        /\b([A-Z0-9]{4,8})\b/g,
      ]
      const standaloneFilter = (val: string) => /[A-Z]/.test(val) && /[0-9]/.test(val)
      for (let pi = 0; pi < pats.length; pi++) {
        const p = pats[pi]
        let m
        while ((m = p.exec(body)) !== null) {
          const val = m[1] || m[0]
          if (pi === pats.length - 1 && !standaloneFilter(val)) continue
          add("pattern", val)
        }
      }

      return found
    })

    const parts: string[] = []
    parts.push(`Waited ${secs}s.`)
    if (dismissed > 0) parts.push(`Popups dismissed: ${dismissed}`)

    if (codes.length > 0) {
      parts.push(`\nCODE CANDIDATES:`)
      codes.slice(0, 10).forEach((c: { src: string; val: string }) => parts.push(`  [${c.src}] ${c.val}`))
    } else {
      parts.push(`\nNo code candidates found after waiting.`)
    }

    return parts.join("\n")
  },
})
