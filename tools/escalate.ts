/**
 * Tool: escalate
 *
 * Called by the agent when it determines the current challenge is too complex
 * for the current model. The orchestrator watches for this tool call and aborts
 * the session, escalating to a stronger model.
 */
import { Type } from "@sinclair/typebox"
import { sharedState } from "./shared-state.js"

export const escalateSchema = Type.Object({
  reason: Type.String({
    description: "Brief description of why escalation is needed (e.g., 'drag-and-drop with React synthetic events', 'canvas gesture drawing')",
  }),
})

export const escalateTool = {
  name: "escalate",
  label: "Escalate",
  description:
    "IMMEDIATELY escalate complex challenges to a stronger model. Call this right after scan_page_for_code for: drag-and-drop, canvas/gestures, iframe/shadow DOM, memory/remember, timed hover, timing/capture windows, split parts, math puzzles, puzzles/mazes, or any challenge that asks you to decode/encode/decrypt (e.g., base64/encoded strings). Do NOT escalate for keyboard sequences or multi-tab challenges.",
  parameters: escalateSchema,
  execute: async (
    _toolCallId: string,
    args: { reason: string },
    _signal?: AbortSignal,
    _onUpdate?: any,
    _ctx?: any,
  ) => {
    // Set shared state so the orchestrator can detect escalation
    sharedState.escalateRequested = true
    return {
      content: [{ type: "text" as const, text: `ESCALATE: ${args.reason}` }],
      details: {},
    }
  },
}
