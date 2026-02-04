/**
 * Page interaction tools (evaluate_js and multi_action).
 * These are the only page tools exposed to the agent via the tool whitelist.
 */
import { Type } from "@sinclair/typebox"
import { getPage } from "./browser.js"

// --- page_evaluate_js ---

export const evaluateJsSchema = Type.Object({
  code: Type.String({
    description:
      "JavaScript to evaluate in the browser page context. Must be a single expression or IIFE. Do NOT use top-level await; wrap async code in (async () => { ...; return value })().",
  }),
})

export const evaluateJsTool = {
  name: "page_evaluate_js",
  label: "Evaluate JS",
  description:
    "Execute arbitrary JavaScript in the page context and return the result. Use for complex interactions, reading computed styles, triggering events, or extracting data that other tools can't reach. Note: top-level await is NOT supported — wrap async code in an async IIFE: (async () => { /* await ... */ return value })().",
  parameters: evaluateJsSchema,
  execute: async (
    _toolCallId: string,
    args: { code: string },
    _signal?: AbortSignal,
    _onUpdate?: any,
    _ctx?: any,
  ) => {
    const page = await getPage()
    try {
      const result = await page.evaluate(args.code)
      if (result === undefined || result === null) {
        return { content: [{ type: "text" as const, text: "Result: null/undefined" }], details: {} }
      }
      const str = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: "text" as const, text: str.substring(0, 4000) }], details: {} }
    } catch (e: any) {
      const msg = e?.message || String(e)
      if (msg.includes("await is only valid") || msg.includes("Unexpected reserved word")) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${msg}. Hint: top-level await isn't supported. Wrap async code like (async () => { /* await ... */ return value })().`,
          }],
          details: {},
        }
      }
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], details: {} }
    }
  },
}

// --- page_multi_action ---

const actionSchema = Type.Object({
  type: Type.Union([
    Type.Literal("click"),
    Type.Literal("hover"),
    Type.Literal("type"),
    Type.Literal("press"),
    Type.Literal("scroll"),
    Type.Literal("select"),
    Type.Literal("check"),
    Type.Literal("wait"),
  ], { description: "Action type." }),
  selector: Type.Optional(Type.String({ description: "CSS selector of target element." })),
  text: Type.Optional(Type.String({ description: "Visible text of target element." })),
  placeholder: Type.Optional(Type.String({ description: "Input placeholder text." })),
  value: Type.Optional(Type.String({ description: "Value to type or select." })),
  label: Type.Optional(Type.String({ description: "Select option label." })),
  index: Type.Optional(Type.Number({ description: "Select option index (zero-based)." })),
  key: Type.Optional(Type.String({ description: "Keyboard key for press action." })),
  pixels: Type.Optional(Type.Number({ description: "Pixels to scroll (positive=down)." })),
  toBottom: Type.Optional(Type.Boolean({ description: "Scroll to bottom of page." })),
  checked: Type.Optional(Type.Boolean({ description: "Set checkbox checked state." })),
  waitMs: Type.Optional(Type.Number({ description: "Wait time after this action (ms)." })),
})

export const multiActionSchema = Type.Object({
  actions: Type.Array(actionSchema, {
    description: "Ordered list of actions to run.",
  }),
})

export const multiActionTool = {
  name: "page_multi_action",
  label: "Multi Action",
  description:
    "Execute multiple page actions in order (click, hover, type, press, scroll, select, check, wait).",
  parameters: multiActionSchema,
  execute: async (
    _toolCallId: string,
    args: { actions: Array<Record<string, any>> },
    _signal?: AbortSignal,
    _onUpdate?: any,
    _ctx?: any,
  ) => {
    const page = await getPage()
    const results: string[] = []

    for (const action of args.actions || []) {
      try {
        switch (action.type) {
          case "click": {
            if (action.selector) {
              await page.click(action.selector, { timeout: 5000 })
              results.push(`click:${action.selector}`)
            } else if (action.text) {
              await page.getByText(action.text, { exact: false }).first().click({ timeout: 5000 })
              results.push(`click:text:${action.text}`)
            } else {
              results.push("click:missing-target")
            }
            break
          }
          case "hover": {
            if (action.selector) {
              await page.hover(action.selector, { timeout: 5000 })
              results.push(`hover:${action.selector}`)
            } else if (action.text) {
              await page.getByText(action.text, { exact: false }).first().hover({ timeout: 5000 })
              results.push(`hover:text:${action.text}`)
            } else {
              results.push("hover:missing-target")
            }
            break
          }
          case "type": {
            let locator
            if (action.selector) {
              locator = page.locator(action.selector).first()
            } else if (action.placeholder) {
              locator = page.getByPlaceholder(action.placeholder).first()
            } else if (action.text) {
              locator = page.getByText(action.text, { exact: false }).first()
            } else {
              locator = page.locator("input, textarea").first()
            }
            const val = action.value ?? action.text ?? ""
            await locator.fill(val)
            results.push(`type:${val.substring(0, 40)}`)
            break
          }
          case "press": {
            if (action.key) {
              await page.keyboard.press(action.key)
              results.push(`press:${action.key}`)
            } else {
              results.push("press:missing-key")
            }
            break
          }
          case "scroll": {
            if (action.selector) {
              await page.evaluate(
                ({ sel, px }: { sel: string; px?: number }) => {
                  const el = document.querySelector(sel) as HTMLElement | null
                  if (!el) return false
                  const delta = typeof px === "number" ? px : el.scrollHeight
                  if ("scrollTop" in el) el.scrollTop += delta
                  return true
                },
                { sel: action.selector, px: action.pixels }
              )
              results.push(`scroll:${action.selector}`)
            } else if (action.toBottom) {
              await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
              results.push("scroll:bottom")
            } else {
              const amount = action.pixels ?? 500
              await page.evaluate((px: number) => window.scrollBy(0, px), amount)
              results.push(`scroll:${amount}`)
            }
            break
          }
          case "select": {
            if (action.selector) {
              if (action.value !== undefined) {
                await page.selectOption(action.selector, { value: action.value })
                results.push(`select:value:${action.value}`)
              } else if (action.label !== undefined) {
                await page.selectOption(action.selector, { label: action.label })
                results.push(`select:label:${action.label}`)
              } else if (action.index !== undefined) {
                await page.selectOption(action.selector, { index: action.index })
                results.push(`select:index:${action.index}`)
              } else {
                results.push("select:missing-option")
              }
            } else {
              results.push("select:missing-selector")
            }
            break
          }
          case "check": {
            if (action.selector) {
              if (action.checked === false) {
                await page.uncheck(action.selector, { timeout: 3000 })
                results.push(`uncheck:${action.selector}`)
              } else {
                await page.check(action.selector, { timeout: 3000 })
                results.push(`check:${action.selector}`)
              }
            } else {
              results.push("check:missing-selector")
            }
            break
          }
          case "wait": {
            const ms = action.waitMs ?? 500
            await page.waitForTimeout(ms)
            results.push(`wait:${ms}ms`)
            break
          }
          default:
            results.push(`unknown:${(action as any).type}`)
        }

        if (action.waitMs && action.type !== "wait") {
          await page.waitForTimeout(action.waitMs)
        }
      } catch (e: any) {
        results.push(`error:${action.type}:${e.message}`)
      }
    }

    return {
      content: [{ type: "text" as const, text: results.join(" | ") }],
      details: {},
    }
  },
}
