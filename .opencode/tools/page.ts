/**
 * Page interaction tools.
 * Navigation is handled by the orchestrator — NOT the model.
 * Popup dismissal is handled by scan_page_for_code and enter_code.
 */
import { tool } from "@opencode-ai/plugin"
import { getPage } from "./browser"

export const click_element = tool({
  description:
    "Click an element on the page by CSS selector or text content.",
  args: {
    selector: tool.schema
      .string()
      .optional()
      .describe("CSS selector of the element to click."),
    text: tool.schema
      .string()
      .optional()
      .describe("Visible text of the element to click. Provide either selector or text."),
  },
  async execute(args) {
    const page = await getPage()
    try {
      if (args.selector) {
        await page.click(args.selector, { timeout: 5000 })
        return `Clicked: ${args.selector}`
      } else if (args.text) {
        await page.getByText(args.text, { exact: false }).first().click({ timeout: 5000 })
        return `Clicked text: ${args.text}`
      }
      return "Error: provide selector or text"
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const get_page_html = tool({
  description:
    "Search raw HTML source for specific patterns. Returns matching lines with context. Use when scan_page_for_code isn't enough — e.g. to find JS variables, obfuscated strings, or deeply nested attributes.",
  args: {
    pattern: tool.schema
      .string()
      .optional()
      .describe("Optional regex pattern to search for in the HTML. If omitted, returns a condensed extract of interesting parts (data attrs, hidden elements, script content, meta tags)."),
  },
  async execute(args) {
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
      if (matches.length === 0) return `No matches for pattern: ${args.pattern}`
      return matches.map((m, i) => `[${i + 1}] ...${m}...`).join("\n")
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

    if (parts.length === 0) return "No interesting patterns found in raw HTML."
    return parts.join("\n\n").substring(0, 4000)
  },
})

export const press_key = tool({
  description: "Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc).",
  args: {
    key: tool.schema.string().describe("Key name, e.g. 'Enter', 'Tab', 'Escape'."),
  },
  async execute(args) {
    const page = await getPage()
    try {
      await page.keyboard.press(args.key)
      return `Pressed: ${args.key}`
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const scroll = tool({
  description:
    "Scroll the page by a given amount of pixels (positive = down, negative = up), or scroll to a specific CSS selector. Returns the new scroll position.",
  args: {
    pixels: tool.schema
      .number()
      .optional()
      .describe("Pixels to scroll (positive=down, negative=up). Default 500."),
    selector: tool.schema
      .string()
      .optional()
      .describe("CSS selector to scroll into view."),
    toBottom: tool.schema
      .boolean()
      .optional()
      .describe("If true, scroll all the way to the bottom of the page."),
  },
  async execute(args) {
    const page = await getPage()

    if (args.selector) {
      try {
        await page.locator(args.selector).first().scrollIntoViewIfNeeded({ timeout: 5000 })
        await page.waitForTimeout(500)
        const pos = await page.evaluate(() => ({
          y: window.scrollY,
          max: document.documentElement.scrollHeight - window.innerHeight,
        }))
        return `Scrolled to "${args.selector}". Position: ${pos.y}px / ${pos.max}px`
      } catch (e: any) {
        return `Error scrolling to selector: ${e.message}`
      }
    }

    if (args.toBottom) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await page.waitForTimeout(500)
      const pos = await page.evaluate(() => ({
        y: window.scrollY,
        max: document.documentElement.scrollHeight - window.innerHeight,
      }))
      return `Scrolled to bottom. Position: ${pos.y}px / ${pos.max}px`
    }

    const amount = args.pixels ?? 500
    await page.evaluate((px: number) => window.scrollBy(0, px), amount)
    await page.waitForTimeout(500)
    const pos = await page.evaluate(() => ({
      y: window.scrollY,
      max: document.documentElement.scrollHeight - window.innerHeight,
    }))
    return `Scrolled ${amount}px. Position: ${pos.y}px / ${pos.max}px`
  },
})

export const evaluate_js = tool({
  description:
    "Execute arbitrary JavaScript in the page context and return the result. Use for complex interactions, reading computed styles, triggering events, or extracting data that other tools can't reach.",
  args: {
    code: tool.schema
      .string()
      .describe(
        "JavaScript code to evaluate in the browser page context. Must be a single expression or IIFE. Return a value to see the result."
      ),
  },
  async execute(args) {
    const page = await getPage()
    try {
      const result = await page.evaluate(args.code)
      if (result === undefined || result === null) return "Result: null/undefined"
      const str = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      return str.substring(0, 4000)
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const select_option = tool({
  description:
    "Select an option from a <select> dropdown by value, label, or index.",
  args: {
    selector: tool.schema.string().describe("CSS selector of the <select> element."),
    value: tool.schema
      .string()
      .optional()
      .describe("Option value attribute to select."),
    label: tool.schema
      .string()
      .optional()
      .describe("Visible text of the option to select."),
    index: tool.schema
      .number()
      .optional()
      .describe("Zero-based index of the option to select."),
  },
  async execute(args) {
    const page = await getPage()
    try {
      if (args.value !== undefined) {
        await page.selectOption(args.selector, { value: args.value })
        return `Selected value "${args.value}" in ${args.selector}`
      } else if (args.label !== undefined) {
        await page.selectOption(args.selector, { label: args.label })
        return `Selected label "${args.label}" in ${args.selector}`
      } else if (args.index !== undefined) {
        await page.selectOption(args.selector, { index: args.index })
        return `Selected index ${args.index} in ${args.selector}`
      }
      return "Error: provide value, label, or index"
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const check_checkbox = tool({
  description: "Check or uncheck a checkbox or radio button.",
  args: {
    selector: tool.schema.string().describe("CSS selector of the checkbox or radio button."),
    checked: tool.schema.boolean().optional().describe("Set to true (check) or false (uncheck). Default: true."),
  },
  async execute(args) {
    const page = await getPage()
    try {
      if (args.checked === false) {
        await page.uncheck(args.selector, { timeout: 3000 })
        return `Unchecked: ${args.selector}`
      } else {
        await page.check(args.selector, { timeout: 3000 })
        return `Checked: ${args.selector}`
      }
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})

export const hover = tool({
  description: "Hover over an element on the page. Some content appears only on hover.",
  args: {
    selector: tool.schema.string().optional().describe("CSS selector of element to hover over."),
    text: tool.schema.string().optional().describe("Visible text to hover over."),
  },
  async execute(args) {
    const page = await getPage()
    try {
      if (args.selector) {
        await page.hover(args.selector, { timeout: 5000 })
        return `Hovered: ${args.selector}`
      } else if (args.text) {
        await page.getByText(args.text, { exact: false }).first().hover({ timeout: 5000 })
        return `Hovered text: ${args.text}`
      }
      return "Error: provide selector or text"
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  },
})
