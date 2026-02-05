/**
 * Tool: get_url
 *
 * Returns the current page URL. Used by the orchestrator to verify
 * the page state after each challenge.
 */
import { toolDefinition } from "@tanstack/ai"
import { z } from "zod"
import { getPage } from "./browser"

const getUrlDef = toolDefinition({
  name: "get_url",
  description: "Get the current page URL and basic page info.",
  inputSchema: z.object({}),
})

export const getUrl = getUrlDef.server(async () => {
  const page = await getPage()
  const url = page.url()
  const title = await page.title()
  return JSON.stringify({ url, title })
})
