/**
 * Tool: enter_code
 *
 * Enters a code/passphrase/answer into an input field and submits it.
 * Auto-dismisses popups before interacting, then finds the input field.
 */
import { Type } from "@sinclair/typebox"
import { getPage } from "./browser.js"
import { dismissPopups } from "./dismiss-helper.js"
import { sharedState } from "./shared-state.js"

export const enterCodeSchema = Type.Object({
  code: Type.String({ description: "The code to enter." }),
  inputSelector: Type.Optional(Type.String({ description: "CSS selector for input. Auto-detects if omitted." })),
  submitSelector: Type.Optional(Type.String({ description: "CSS selector for submit button. Auto-detects if omitted." })),
})

export const enterCodeTool = {
  name: "enter_code",
  label: "Enter Code",
  description:
    "Enter a code into the input field and submit. Auto-dismisses popups first. Auto-finds input and submit button.",
  parameters: enterCodeSchema,
  execute: async (
    _toolCallId: string,
    args: { code: string; inputSelector?: string; submitSelector?: string },
    _signal?: AbortSignal,
    _onUpdate?: any,
    _ctx?: any,
  ) => {
    const page = await getPage()

    const beforeUrl = page.url()

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
      return {
        content: [{ type: "text" as const, text: "Error: no input field found." }],
        details: {},
      }
    }

    // Fill the input
    try {
      const input = page.locator(inputSelector).first()
      await input.click({ timeout: 2000 })
      await input.fill("")
      await input.fill(args.code)
    } catch (e: any) {
      await dismissPopups(page)
      try {
        const input = page.locator(inputSelector).first()
        await input.click({ timeout: 2000 })
        await input.fill("")
        await input.fill(args.code)
      } catch (e2: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e2.message}` }],
          details: {},
        }
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

    const urlChanged = feedback.url !== beforeUrl

    // Update shared state so orchestrator can detect URL changes
    if (urlChanged) {
      sharedState.lastEnterCodeUrl = feedback.url
    }

    if (!urlChanged) {
      return {
        content: [{ type: "text" as const, text: "Error: submission did not advance; please take a step back to deduce why." }],
        details: {},
      }
    }

    const result = `OK: "${args.code}" | ${feedback.url} | urlChanged=true | prev=${beforeUrl}\n${feedback.body}`
    return {
      content: [{ type: "text" as const, text: result }],
      details: {},
    }
  },
}
