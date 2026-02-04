/**
 * Shared state between tools and the orchestrator.
 *
 * Since pi runs tools in-process (unlike OpenCode's separate Bun process),
 * we can use module-level state to communicate between tools and agent.ts.
 */

export const sharedState = {
  /** URL captured from enter_code after submission */
  lastEnterCodeUrl: null as string | null,
  /** Whether the escalate tool was called */
  escalateRequested: false,
  /** Whether scan_page_for_code detected completion */
  completionDetected: false,

  /** Reset state for a new challenge attempt */
  reset() {
    this.lastEnterCodeUrl = null
    this.escalateRequested = false
    this.completionDetected = false
  },
}
