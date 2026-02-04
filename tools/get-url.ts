/**
 * Tool: get_url
 *
 * Returns the current page URL. Used by the orchestrator to verify
 * the page state after each challenge without needing Playwright directly.
 */
import { Type } from "@sinclair/typebox"
import { getPage } from "./browser.js"

export const getUrlSchema = Type.Object({})

export const getUrlTool = {
  name: "get_url",
  label: "Get URL",
  description: "Get the current page URL and basic page info.",
  parameters: getUrlSchema,
  execute: async (
    _toolCallId: string,
    _args: Record<string, never>,
    _signal?: AbortSignal,
    _onUpdate?: any,
    _ctx?: any,
  ) => {
    const page = await getPage()
    const url = page.url()
    const title = await page.title()
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ url, title }) }],
      details: {},
    }
  },
}
