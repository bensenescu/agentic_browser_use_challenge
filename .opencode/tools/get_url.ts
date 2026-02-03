/**
 * Tool: get_url
 *
 * Returns the current page URL. Used by the orchestrator to verify
 * the page state after each challenge without needing Playwright directly.
 */
import { tool } from "@opencode-ai/plugin"
import { getPage } from "./browser"

export default tool({
  description: "Get the current page URL and basic page info.",
  args: {},
  async execute() {
    const page = await getPage()
    const url = page.url()
    const title = await page.title()
    return JSON.stringify({ url, title })
  },
})
