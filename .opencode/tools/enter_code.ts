/**
 * Tool: enter_code
 *
 * Enters a code/passphrase/answer into an input field and submits it.
 * Auto-dismisses popups before interacting, then finds the input field.
 */
import { tool } from "@opencode-ai/plugin"
import { getPage } from "./browser"
import { dismissPopups } from "./dismiss-helper"

export default tool({
  description:
    "Enter a code into the input field and submit. Auto-dismisses popups first. Auto-finds input and submit button.",
  args: {
    code: tool.schema.string().describe("The code to enter."),
    inputSelector: tool.schema
      .string()
      .optional()
      .describe("CSS selector for input. Auto-detects if omitted."),
    submitSelector: tool.schema
      .string()
      .optional()
      .describe("CSS selector for submit button. Auto-detects if omitted."),
  },
  async execute(args) {
    const page = await getPage()

    // Dismiss popups FIRST so input is accessible
    await dismissPopups(page)

    // Find the input field
    let inputSelector = args.inputSelector
    if (!inputSelector) {
      const candidateSelectors = [
        'input[placeholder*="code"]',
        'input[placeholder*="answer"]',
        'input[placeholder*="enter"]',
        'input[name*="code"]',
        'input[name*="answer"]',
        'input[id*="code"]',
        'input[id*="answer"]',
        'input[type="text"]',
        'input[type="password"]',
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])',
        "textarea",
      ]

      for (const sel of candidateSelectors) {
        try {
          const el = page.locator(sel).first()
          if (await el.isVisible({ timeout: 400 })) {
            inputSelector = sel
            break
          }
        } catch {}
      }
    }

    if (!inputSelector) {
      // One more dismiss attempt then retry
      await dismissPopups(page)
      for (const sel of ['input[type="text"]', 'input:not([type="hidden"])']) {
        try {
          const el = page.locator(sel).first()
          if (await el.isVisible({ timeout: 500 })) {
            inputSelector = sel
            break
          }
        } catch {}
      }
    }

    if (!inputSelector) {
      return "Error: no input field found."
    }

    // Fill the input
    try {
      const input = page.locator(inputSelector).first()
      await input.click({ timeout: 2000 })
      await input.fill("")
      await input.fill(args.code)
    } catch (e: any) {
      // If click failed, try dismissing again
      await dismissPopups(page)
      try {
        const input = page.locator(inputSelector).first()
        await input.click({ timeout: 2000 })
        await input.fill("")
        await input.fill(args.code)
      } catch (e2: any) {
        return `Error: ${e2.message}`
      }
    }

    // Submit
    let submitted = false

    if (args.submitSelector) {
      try {
        await page.click(args.submitSelector, { timeout: 2000 })
        submitted = true
      } catch {}
    }

    if (!submitted) {
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Enter")',
        'button:has-text("Go")',
        'button:has-text("Verify")',
        'button:has-text("Check")',
      ]

      for (const sel of submitSelectors) {
        try {
          const el = page.locator(sel).first()
          if (await el.isVisible({ timeout: 250 })) {
            await el.click({ timeout: 1500 })
            submitted = true
            break
          }
        } catch {}
      }
    }

    if (!submitted) {
      await page.keyboard.press("Enter").catch(() => {})
    }

    // Wait for page reaction
    await page.waitForTimeout(800)

    // Compact feedback
    const feedback = await page.evaluate(() => {
      const body = document.body?.innerText?.trim().substring(0, 300) || ""
      return { url: window.location.href, body }
    })

    return `OK: "${args.code}" | ${feedback.url}\n${feedback.body}`
  },
})
