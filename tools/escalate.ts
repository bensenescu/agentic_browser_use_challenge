/**
 * Tool: escalate
 *
 * Called by the agent when it determines the current challenge is too complex
 * for the current model. The orchestrator watches for this tool's output and
 * retries with a stronger model.
 */
import { toolDefinition } from "@tanstack/ai"
import { z } from "zod"

const escalateDef = toolDefinition({
  name: "escalate",
  description:
    "IMMEDIATELY escalate complex challenges to a stronger model. Call this right after scan_page_for_code for: drag-and-drop, canvas/gestures, iframe/shadow DOM, memory/remember, timed hover, timing/capture windows, split parts, math puzzles, puzzles/mazes, or any challenge that asks you to decode/encode/decrypt (e.g., base64/encoded strings). Do NOT escalate for keyboard sequences or multi-tab challenges.",
  inputSchema: z.object({
    reason: z.string().describe("Brief description of why escalation is needed (e.g., 'drag-and-drop with React synthetic events', 'canvas gesture drawing')"),
  }),
})

export const escalate = escalateDef.server(async (args) => {
  // The orchestrator detects this tool's output and retries with a stronger model.
  return JSON.stringify({ action: "ESCALATE", reason: args.reason })
})
