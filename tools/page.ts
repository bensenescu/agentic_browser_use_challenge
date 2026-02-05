/**
 * Page interaction tools.
 * Navigation is handled by the orchestrator — NOT the model.
 * Popup dismissal is handled by scan_page_for_code and enter_code.
 */
import { toolDefinition } from "@tanstack/ai"
import { z } from "zod"
import { getPage } from "./browser"

// --- click_element ---

const clickElementDef = toolDefinition({
  name: "page_click_element",
  description:
    "Click an element on the page by CSS selector or text content.",
  inputSchema: z.object({
    selector: z.string().optional().describe("CSS selector of the element to click."),
    text: z.string().optional().describe("Visible text of the element to click. Provide either selector or text."),
  }),
})

export const clickElement = clickElementDef.server(async (args) => {
  const page = await getPage()
  try {
    if (args.selector) {
      await page.click(args.selector, { timeout: 5000 })
      return JSON.stringify({ result: `Clicked: ${args.selector}` })
    } else if (args.text) {
      await page.getByText(args.text, { exact: false }).first().click({ timeout: 5000 })
      return JSON.stringify({ result: `Clicked text: ${args.text}` })
    }
    return JSON.stringify({ error: "provide selector or text" })
  } catch (e: any) {
    return JSON.stringify({ error: e.message })
  }
})

// --- get_page_html ---

const getPageHtmlDef = toolDefinition({
  name: "page_get_page_html",
  description:
    "Search raw HTML source for specific patterns. Returns matching lines with context. Use when scan_page_for_code isn't enough — e.g. to find JS variables, obfuscated strings, or deeply nested attributes.",
  inputSchema: z.object({
    pattern: z.string().optional().describe("Optional regex pattern to search for in the HTML. If omitted, returns a condensed extract of interesting parts (data attrs, hidden elements, script content, meta tags)."),
  }),
})

export const getPageHtml = getPageHtmlDef.server(async (args) => {
  const page = await getPage()
  const html = await page.content()

  if (args.pattern) {
    const re = new RegExp(args.pattern, "gi")
    const matches: string[] = []
    let m
    while ((m = re.exec(html)) !== null && matches.length < 20) {
      const start = Math.max(0, m.index - 80)
      const end = Math.min(html.length, m.index + m[0].length + 80)
      matches.push(html.substring(start, end).replace(/\n/g, " ").trim())
    }
    if (matches.length === 0) return JSON.stringify({ output: `No matches for pattern: ${args.pattern}` })
    return JSON.stringify({ output: matches.map((m, i) => `[${i + 1}] ...${m}...`).join("\n") })
  }

  // No pattern: extract interesting parts
  const parts: string[] = []

  // All data-* attributes
  const dataRe = /data-[\w-]+="[^"]*"/gi
  const dataAttrs = new Set<string>()
  let dataM
  while ((dataM = dataRe.exec(html)) !== null && dataAttrs.size < 30) {
    dataAttrs.add(dataM[0])
  }
  if (dataAttrs.size > 0) parts.push("DATA ATTRS:\n" + Array.from(dataAttrs).join("\n"))

  // Hidden elements
  const hiddenRe = /<[^>]*(hidden|display:\s*none|visibility:\s*hidden|aria-hidden="true")[^>]*>([^<]*)</gi
  let hidM
  const hiddens: string[] = []
  while ((hidM = hiddenRe.exec(html)) !== null && hiddens.length < 15) {
    const text = hidM[2]?.trim()
    if (text) hiddens.push(text)
  }
  if (hiddens.length > 0) parts.push("HIDDEN TEXT:\n" + hiddens.join("\n"))

  // HTML comments
  const commentRe = /<!--([\s\S]*?)-->/g
  let cM
  const comments: string[] = []
  while ((cM = commentRe.exec(html)) !== null && comments.length < 10) {
    const c = cM[1].trim()
    if (c.length > 0 && c.length < 300) comments.push(c)
  }
  if (comments.length > 0) parts.push("COMMENTS:\n" + comments.join("\n"))

  // Inline script content
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi
  let sM
  while ((sM = scriptRe.exec(html)) !== null) {
    const content = sM[1].trim()
    if (content.length > 0 && content.length < 500 && !content.includes("modulepreload")) {
      parts.push("SCRIPT:\n" + content.substring(0, 500))
    }
  }

  if (parts.length === 0) return JSON.stringify({ output: "No interesting patterns found in raw HTML." })
  return JSON.stringify({ output: parts.join("\n\n").substring(0, 4000) })
})

// --- press_key ---

const pressKeyDef = toolDefinition({
  name: "page_press_key",
  description: "Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc).",
  inputSchema: z.object({
    key: z.string().describe("Key name, e.g. 'Enter', 'Tab', 'Escape'."),
  }),
})

export const pressKey = pressKeyDef.server(async (args) => {
  const page = await getPage()
  try {
    await page.keyboard.press(args.key)
    return JSON.stringify({ result: `Pressed: ${args.key}` })
  } catch (e: any) {
    return JSON.stringify({ error: e.message })
  }
})

// --- scroll ---

const scrollDef = toolDefinition({
  name: "page_scroll",
  description:
    "Scroll the page by a given amount of pixels (positive = down, negative = up), or scroll to a specific CSS selector. Returns the new scroll position.",
  inputSchema: z.object({
    pixels: z.number().optional().describe("Pixels to scroll (positive=down, negative=up). Default 500."),
    selector: z.string().optional().describe("CSS selector to scroll into view."),
    toBottom: z.boolean().optional().describe("If true, scroll all the way to the bottom of the page."),
  }),
})

export const scroll = scrollDef.server(async (args) => {
  const page = await getPage()

  if (args.selector) {
    try {
      await page.locator(args.selector).first().scrollIntoViewIfNeeded({ timeout: 5000 })
      await page.waitForTimeout(500)
      const pos = await page.evaluate(() => ({
        y: window.scrollY,
        max: document.documentElement.scrollHeight - window.innerHeight,
      }))
      return JSON.stringify({ result: `Scrolled to "${args.selector}". Position: ${pos.y}px / ${pos.max}px` })
    } catch (e: any) {
      return JSON.stringify({ error: `scrolling to selector: ${e.message}` })
    }
  }

  if (args.toBottom) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(500)
    const pos = await page.evaluate(() => ({
      y: window.scrollY,
      max: document.documentElement.scrollHeight - window.innerHeight,
    }))
    return JSON.stringify({ result: `Scrolled to bottom. Position: ${pos.y}px / ${pos.max}px` })
  }

  const amount = args.pixels ?? 500
  await page.evaluate((px: number) => window.scrollBy(0, px), amount)
  await page.waitForTimeout(500)
  const pos = await page.evaluate(() => ({
    y: window.scrollY,
    max: document.documentElement.scrollHeight - window.innerHeight,
  }))
  return JSON.stringify({ result: `Scrolled ${amount}px. Position: ${pos.y}px / ${pos.max}px` })
})

// --- evaluate_js ---

const evaluateJsDef = toolDefinition({
  name: "page_evaluate_js",
  description:
    "Execute arbitrary JavaScript in the page context and return the result. Use for complex interactions, reading computed styles, triggering events, or extracting data that other tools can't reach. Note: top-level await is NOT supported — wrap async code in an async IIFE: (async () => { /* await ... */ return value })().",
  inputSchema: z.object({
    code: z.string().describe(
      "JavaScript to evaluate in the browser page context. Must be a single expression or IIFE. Do NOT use top-level await; wrap async code in (async () => { ...; return value })()."
    ),
  }),
})

export const evaluateJs = evaluateJsDef.server(async (args) => {
  const page = await getPage()
  const debug = process.env.OPENCODE_DEBUG_TOOL_INPUTS === "true"
  const debugCode = debug ? args.code : undefined
  try {
    const result = await page.evaluate(args.code)
    if (result === undefined || result === null) {
      return JSON.stringify({ result: "null/undefined", ...(debugCode && { debugCode }) })
    }
    const str = typeof result === "string" ? result : JSON.stringify(result, null, 2)
    return JSON.stringify({ result: str, ...(debugCode && { debugCode }) })
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (msg.includes("await is only valid") || msg.includes("Unexpected reserved word")) {
      return JSON.stringify({ error: msg, hint: "top-level await isn't supported. Wrap async code like (async () => { /* await ... */ return value })().", ...(debugCode && { debugCode }) })
    }
    return JSON.stringify({ error: msg, ...(debugCode && { debugCode }) })
  }
})

// --- select_option ---

const selectOptionDef = toolDefinition({
  name: "page_select_option",
  description:
    "Select an option from a <select> dropdown by value, label, or index.",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector of the <select> element."),
    value: z.string().optional().describe("Option value attribute to select."),
    label: z.string().optional().describe("Visible text of the option to select."),
    index: z.number().optional().describe("Zero-based index of the option to select."),
  }),
})

export const selectOption = selectOptionDef.server(async (args) => {
  const page = await getPage()
  try {
    if (args.value !== undefined) {
      await page.selectOption(args.selector, { value: args.value })
      return JSON.stringify({ result: `Selected value "${args.value}" in ${args.selector}` })
    } else if (args.label !== undefined) {
      await page.selectOption(args.selector, { label: args.label })
      return JSON.stringify({ result: `Selected label "${args.label}" in ${args.selector}` })
    } else if (args.index !== undefined) {
      await page.selectOption(args.selector, { index: args.index })
      return JSON.stringify({ result: `Selected index ${args.index} in ${args.selector}` })
    }
    return JSON.stringify({ error: "provide value, label, or index" })
  } catch (e: any) {
    return JSON.stringify({ error: e.message })
  }
})

// --- check_checkbox ---

const checkCheckboxDef = toolDefinition({
  name: "page_check_checkbox",
  description: "Check or uncheck a checkbox or radio button.",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector of the checkbox or radio button."),
    checked: z.boolean().optional().describe("Set to true (check) or false (uncheck). Default: true."),
  }),
})

export const checkCheckbox = checkCheckboxDef.server(async (args) => {
  const page = await getPage()
  try {
    if (args.checked === false) {
      await page.uncheck(args.selector, { timeout: 3000 })
      return JSON.stringify({ result: `Unchecked: ${args.selector}` })
    } else {
      await page.check(args.selector, { timeout: 3000 })
      return JSON.stringify({ result: `Checked: ${args.selector}` })
    }
  } catch (e: any) {
    return JSON.stringify({ error: e.message })
  }
})

// --- hover ---

const hoverDef = toolDefinition({
  name: "page_hover",
  description: "Hover over an element on the page. Some content appears only on hover.",
  inputSchema: z.object({
    selector: z.string().optional().describe("CSS selector of element to hover over."),
    text: z.string().optional().describe("Visible text to hover over."),
  }),
})

export const hover = hoverDef.server(async (args) => {
  const page = await getPage()
  try {
    if (args.selector) {
      await page.hover(args.selector, { timeout: 5000 })
      return JSON.stringify({ result: `Hovered: ${args.selector}` })
    } else if (args.text) {
      await page.getByText(args.text, { exact: false }).first().hover({ timeout: 5000 })
      return JSON.stringify({ result: `Hovered text: ${args.text}` })
    }
    return JSON.stringify({ error: "provide selector or text" })
  } catch (e: any) {
    return JSON.stringify({ error: e.message })
  }
})

// --- multi_action ---

const multiActionDef = toolDefinition({
  name: "page_multi_action",
  description:
    "Execute multiple page actions in order (click, hover, type, press, scroll, select, check, wait).",
  inputSchema: z.object({
    actions: z.array(
      z.object({
        type: z.enum(["click", "hover", "type", "press", "scroll", "select", "check", "wait"]).describe("Action type."),
        selector: z.string().optional().describe("CSS selector of target element."),
        text: z.string().optional().describe("Visible text of target element."),
        placeholder: z.string().optional().describe("Input placeholder text."),
        value: z.string().optional().describe("Value to type or select."),
        label: z.string().optional().describe("Select option label."),
        index: z.number().optional().describe("Select option index (zero-based)."),
        key: z.string().optional().describe("Keyboard key for press action."),
        pixels: z.number().optional().describe("Pixels to scroll (positive=down)."),
        toBottom: z.boolean().optional().describe("Scroll to bottom of page."),
        checked: z.boolean().optional().describe("Set checkbox checked state."),
        waitMs: z.number().optional().describe("Wait time after this action (ms)."),
      })
    ).describe("Ordered list of actions to run."),
  }),
})

export const multiAction = multiActionDef.server(async (args) => {
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

  return JSON.stringify({ result: results.join(" | ") })
})
