/**
 * Tool: get_modal_buttons
 *
 * Finds all modals/dialogs/overlays on the page and returns their text content
 * along with any buttons inside them. Useful for identifying noisy popups that
 * need to be dismissed.
 */
import { tool } from "@opencode-ai/plugin"
import { getPage } from "./browser"

export default tool({
  description:
    "Get all buttons within modals, dialogs, and overlay popups on the current page, along with the text content of each modal. Use this to identify popups that need dismissing.",
  args: {},
  async execute() {
    const page = await getPage()

    const modals = await page.evaluate(() => {
      const results: Array<{
        selector: string
        textContent: string
        buttons: Array<{ text: string; selector: string }>
      }> = []

      // Common modal/dialog selectors
      const modalSelectors = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[aria-modal="true"]',
        ".modal",
        ".dialog",
        ".popup",
        ".overlay",
        '[class*="modal"]',
        '[class*="dialog"]',
        '[class*="popup"]',
        '[class*="overlay"]',
        '[class*="Modal"]',
        '[class*="Dialog"]',
        '[class*="Popup"]',
        '[class*="Overlay"]',
        '[id*="modal"]',
        '[id*="dialog"]',
        '[id*="popup"]',
        '[id*="overlay"]',
      ]

      const seen = new Set<Element>()

      for (const sel of modalSelectors) {
        const elements = document.querySelectorAll(sel)
        for (const el of elements) {
          if (seen.has(el)) continue
          // Only consider visible elements
          const style = window.getComputedStyle(el)
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            continue
          }
          seen.add(el)

          const buttons: Array<{ text: string; selector: string }> = []
          const btnElements = el.querySelectorAll(
            'button, [role="button"], a.btn, a.button, input[type="submit"], input[type="button"], [class*="close"], [class*="Close"], [class*="dismiss"], [aria-label="Close"], [aria-label="Dismiss"]'
          )

          btnElements.forEach((btn, idx) => {
            const text =
              (btn as HTMLElement).innerText?.trim() ||
              btn.getAttribute("aria-label") ||
              btn.getAttribute("title") ||
              `[button ${idx}]`

            // Build a unique selector for this button
            let btnSelector = ""
            if (btn.id) {
              btnSelector = `#${btn.id}`
            } else if (btn.getAttribute("aria-label")) {
              btnSelector = `[aria-label="${btn.getAttribute("aria-label")}"]`
            } else {
              // Use nth-of-type within the modal
              const tag = btn.tagName.toLowerCase()
              const siblings = el.querySelectorAll(tag)
              const sibIdx = Array.from(siblings).indexOf(btn)
              btnSelector = `${sel} ${tag}:nth-of-type(${sibIdx + 1})`
            }

            buttons.push({ text, selector: btnSelector })
          })

          results.push({
            selector: sel,
            textContent: (el as HTMLElement).innerText?.trim().substring(0, 500) || "",
            buttons,
          })
        }
      }

      return results
    })

    if (modals.length === 0) {
      return "No modals or popups found on the page."
    }

    return JSON.stringify(modals, null, 2)
  },
})
