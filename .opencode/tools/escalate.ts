/**
 * Tool: escalate
 *
 * Called by the agent when it determines the current challenge is too complex
 * for the current model. The orchestrator watches for this tool call and aborts
 * the session, escalating to a stronger model.
 *
 * The agent should call this IMMEDIATELY after scan_page_for_code (as the very next tool call)
 * for complex challenges: drag-and-drop, canvas/gestures, iframe/shadow DOM, memory,
 * timed hover, timing/capture windows, split parts, math puzzles, puzzles/mazes.
 * Do NOT escalate for keyboard sequences or multi-tab (just do them).
 *
 * Returns a message confirming escalation was requested — the orchestrator
 * will abort the session before the agent can take further action.
 */
import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "IMMEDIATELY escalate complex challenges to a stronger model. Call this right after scan_page_for_code for: drag-and-drop, canvas/gestures, iframe/shadow DOM, memory/remember, timed hover, timing/capture windows, split parts, math puzzles, puzzles/mazes. Do NOT escalate for keyboard sequences or multi-tab challenges.",
  args: {
    reason: tool.schema
      .string()
      .describe("Brief description of why escalation is needed (e.g., 'drag-and-drop with React synthetic events', 'canvas gesture drawing')"),
  },
  async execute(args) {
    // The orchestrator detects this tool call via the event stream and aborts the session.
    // This return value is just for completeness — the agent will be terminated.
    return `ESCALATE: ${args.reason}`
  },
})
