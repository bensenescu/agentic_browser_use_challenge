/**
 * Agent Orchestrator — Optimized for speed
 *
 * Architecture:
 * - Tools own the browser (Playwright runs inside OpenCode's Bun-based plugin system)
 * - agent.ts does NOT use Playwright — it orchestrates via tool calls only
 * - First challenge: scan_page_for_code gets url param to navigate + click START
 * - Subsequent challenges: page is already on the right step
 * - URL verification via get_url tool call
 * - New session per challenge (context isolation)
 *
 * Usage:
 *   npm run agent [-- [challenge-url] [--provider <id>] [--model <name>]]
 *   npm run agent:headed [-- [challenge-url] [--provider <id>] [--model <name>]]
 *
 * Examples:
 *   npm run agent:headed
 *   npm run agent:headed -- --provider openai --model gpt-4o
 *   npm run agent:headed -- https://example.com --provider anthropic --model claude-sonnet-4-5
 */
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";
import { createServer } from "node:net";

// ---- CLI argument parsing ----
function parseArgs(argv: string[]): {
  url: string;
  provider: string;
  model: string;
  step: number | null;
  version: string;
  versionProvided: boolean;
  debugToolInputs: boolean;
} {
  const args = argv.slice(2); // skip node + script
  let url = "";
  let provider = "anthropic";
  let model = "claude-sonnet-4-5";
  let step: number | null = null;
  let version = "2";
  let versionProvided = false;
  let debugToolInputs = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && i + 1 < args.length) {
      provider = args[++i];
    } else if (args[i] === "--model" && i + 1 < args.length) {
      model = args[++i];
    } else if (args[i] === "--step" && i + 1 < args.length) {
      step = parseInt(args[++i], 10);
    } else if (args[i] === "--version" && i + 1 < args.length) {
      version = args[++i];
      versionProvided = true;
    } else if (args[i] === "--debug-tool-inputs") {
      debugToolInputs = true;
    } else if (!args[i].startsWith("--")) {
      url = args[i];
    }
  }

  return {
    url: url || "https://serene-frangipane-7fd25b.netlify.app/",
    provider,
    model,
    step,
    version,
    versionProvided,
    debugToolInputs,
  };
}

const parsed = parseArgs(process.argv);
let CHALLENGE_URL = parsed.url;
const MAX_CHALLENGES = 35;
const TARGET_STEP = parsed.step;

// Model ladder: claude-opus-4-6 only (1 attempt max)
const MODEL_LADDER = [
  { providerID: "anthropic", modelID: "claude-opus-4-6" },
];

function getModelForAttempt(attempt: number): {
  providerID: string;
  modelID: string;
} {
  const idx = Math.min(attempt, MODEL_LADDER.length - 1);
  return MODEL_LADDER[idx];
}

const MAX_ATTEMPTS = MODEL_LADDER.length;

// Tool whitelists — escalate disabled for opus
const TOOLS_BASE: Record<string, boolean> = {
  "*": false,
  scan_page_for_code: true,
  enter_code: true,
  get_url: true,
  page_evaluate_js: true,
  page_multi_action: true,
  drag_and_drop: true,
};
const TOOLS_WITH_ESCALATE: Record<string, boolean> = {
  ...TOOLS_BASE,
  escalate: true,
};
const TOOLS_WITHOUT_ESCALATE: Record<string, boolean> = {
  ...TOOLS_BASE,
  escalate: false,
};

// ---- System prompt building blocks ----

const PROMPT_HEADER = `You solve browser challenges. SPEED is critical — minimum tool calls.

## Happy path (most challenges): 2 tool calls
1. scan_page_for_code → reads current page + auto-scrolls/waits/clicks-reveal/hovers + finds codes
2. enter_code → enters code from CODE CANDIDATES and submits

## If scan_page_for_code didn't find the code:
- Read the PAGE CONTENT section in scan_page_for_code output to understand the challenge
- Do ONE interaction (page_multi_action or page_evaluate_js) then call scan_page_for_code again (with noAuto=true)
- Never chain multiple page_evaluate_js calls in the same step`;

const ESCALATION_SECTION = `
## ESCALATE IMMEDIATELY for these challenge types (right after scan_page_for_code):
Call the escalate tool as your VERY NEXT action after scan_page_for_code if the page contains ANY of these:
- "drag" + "canvas" or "draw" (drag on canvas) → escalate("drag-canvas challenge")
- "canvas" / "draw" / "gesture" / "stroke" → escalate("canvas/gesture challenge")
- "iframe" / "shadow DOM" / "shadow layer" / "nested layers" → escalate("iframe/shadow DOM challenge")
- "memory" / "remember" / "memorize" / "code will flash" → escalate("memory challenge")
- "hover" + "seconds" (timed hover) → escalate("timed hover challenge")
- "window will appear" / "capture" (timing window) → escalate("timing/capture challenge")
- "parts scattered" / "find N parts" → escalate("split parts challenge")
- Math equation with its own input + "Solve" button → escalate("math puzzle challenge")
- "puzzle" / "maze" → escalate("puzzle challenge")
- "decode" / "encoded" / "base64" / "decrypt" / "cipher" → escalate("decode/encoded challenge")
- Multi-step challenges ("Step 1/2/3", "Complete N actions", "Sequence Challenge", "N/4") → escalate("multi-step challenge")
Do NOT waste tool calls trying to solve these yourself. Escalate IMMEDIATELY.`;

const SHARED_PLAYBOOKS = `
### Instruction-first rule
Before taking any action, read the page instructions and constraints (e.g. “enter ANY 6 characters”, “exactly 6”, “click Reveal”). Prioritize these over hints, encoded strings, or decoys.
If you see a form instruction, follow it literally before trying to decode or derive anything.

### Failure reset
If two consecutive attempts fail (wrong code or no progress): STOP. Re-read the instructions and scan for high-signal guidance (labels, placeholders, warning callouts).
Then take the simplest compliant action from the instructions (e.g. “type any 6 characters” + “click Reveal”).

### Keyboard sequences
If the page shows key combinations (e.g. Control+A, Control+C, Control+V):
→ Call page_multi_action with press actions for EACH combo in order (e.g. "Control+a", "Control+c", "Control+v")
→ Then call scan_page_for_code with noAuto=true to find the revealed code.

### Multi-tab / tabbed challenges
If the page has tabs (Tab 1, Tab 2, etc.) that must all be visited:
→ Use page_evaluate_js to click each tab in sequence:
  const tabs = document.querySelectorAll('[role="tab"], button[class*="tab"]');
  for (const tab of tabs) { tab.click(); await new Promise(r => setTimeout(r, 300)); }
→ After visiting all tabs, look for a "Reveal Code" button and click it.
→ Then call scan_page_for_code with noAuto=true.

### Decoy buttons
The page may have multiple buttons — most are traps.
NEVER click: "Continue", "Next", "Go Forward", "Proceed", "Keep Going", "Skip"
Look for buttons that mention: "Reveal", "Real", "Remember", "Actual", "True", "Unlock", "Complete Challenge"

### Form validation / multi-step forms
If the page has multiple form fields (not just the code input):
→ Read the labels/placeholders to understand what's expected
→ Use page_multi_action (type/select/check) or page_evaluate_js to fill fields

### Timer / animation challenges
If the page has a countdown or animation that must complete:
→ Use page_evaluate_js to fast-forward or wait: await new Promise(r => setTimeout(r, <ms>))

### Drag and drop challenges
If the page says "drag" and has pieces + slots:
→ Use ONE drag_and_drop call with pairs array to fill ALL slots at once.
→ Pick any 6 pieces from the available list and map them to Slot 1 through Slot 6.
→ The tool returns filled count and revealed code — check output before scanning.
→ Example: drag_and_drop({ pairs: [{ sourceText: "A", targetText: "Slot 1" }, { sourceText: "B", targetText: "Slot 2" }, ...] })`;

const ADVANCED_PLAYBOOKS = `
### Math / puzzle challenges
If the page shows a math equation (e.g. "29 + 9 = ?") with its own input and "Solve" button:
→ Use page_evaluate_js to solve it in ONE call. The puzzle input is SEPARATE from the main code input.
→ Example JS:
  const eq = document.querySelector('h2, h3, [class*="text-3xl"], [class*="text-4xl"]');
  const text = eq?.innerText || '';
  const m = text.match(/(\\d+)\\s*([+\\-*/])\\s*(\\d+)/);
  if (m) {
    const ans = eval(m[1] + m[2] + m[3]);
    const input = document.querySelector('input[placeholder*="answer"], input[placeholder*="ans"], input[type="number"]');
    if (input) { const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; nativeSetter.call(input, String(ans)); input.dispatchEvent(new Event('input', {bubbles:true})); }
    const solveBtn = [...document.querySelectorAll('button')].find(b => /solve/i.test(b.innerText));
    solveBtn?.click();
  }
→ Then call scan_page_for_code with noAuto=true to find the revealed code.
→ IMPORTANT: Do NOT type the math answer into the main "Enter 6-character code" input.

### Memory challenges
If the page says "remember" or "memorize" a code, then shows a "I Remember" or similar button:
→ Click the button that says "I Remember", "Reveal Real Code", or similar (NOT decoy buttons).
→ Then call scan_page_for_code with noAuto=true to find the revealed code.

### Hover for duration
If the page says to hover over something for N seconds and auto-hover didn't reveal the code:
→ Call page_multi_action with hover + wait on the target element (waitMs = required duration)
→ Then call scan_page_for_code with noAuto=true to find the revealed code.
→ Alternatively, use page_evaluate_js to directly read the code from the DOM after triggering hover events.

### Timing / capture window challenges
If the page says "Window will appear soon" or has a "Capture" button:
→ Use page_evaluate_js to set up a MutationObserver that auto-clicks "Capture Now!" when the window appears:
  new MutationObserver((mutations, obs) => {
    const btn = [...document.querySelectorAll('button')].find(b => /capture now/i.test(b.innerText));
    if (btn) { btn.click(); obs.disconnect(); }
  }).observe(document.body, {childList: true, subtree: true});
→ Wait a few seconds, then call scan_page_for_code with noAuto=true.

### Split parts / hidden parts
If the page says "find N parts scattered on the page":
→ Do NOT guess the combined code until all parts are found.
→ Use page_evaluate_js to auto-click all scattered parts:
  1. Prefer clickable overlays: [class*="cursor-pointer"], [class*="pointer-events-auto"], [role="button"], button
  2. Include absolute/fixed elements that may be off-screen or visually hidden.
  3. Dispatch click events directly if elements are not visible.
→ After clicking, look for "All parts found" / checkmarks / progress N/N, then click any Reveal/Complete button.
→ Then call scan_page_for_code with noAuto=true.

### Sequence / multi-action challenges
If the page says "Sequence Challenge" or lists required actions (click/hover/type/scroll):
→ Use page_multi_action (single tool call) to perform all steps and click Complete/Reveal:
  actions: [
    { type: "click", text: "Click" },
    { type: "hover", text: "Hover" },
    { type: "type", selector: "input", value: "hello" },
    { type: "scroll", selector: "[class*='overflow'], [class*='scroll']" },
    { type: "click", text: "Complete" },
  ]
→ Then call scan_page_for_code with noAuto=true.

### Drag and drop (generalized, single-shot)
If the page mentions "drag" and has draggable pieces/slots:
→ Use ONE drag_and_drop call with ALL pairs to fill every slot at once.
→ The tool uses React handlers internally and handles timing between drops.
→ The tool returns filled count and any revealed code — check the output before scanning again.

Example for 6 slots with pieces ["Q","K","Z","C","T","V"]:
  drag_and_drop({
    pairs: [
      { sourceText: "Q", targetText: "Slot 1" },
      { sourceText: "K", targetText: "Slot 2" },
      { sourceText: "Z", targetText: "Slot 3" },
      { sourceText: "C", targetText: "Slot 4" },
      { sourceText: "T", targetText: "Slot 5" },
      { sourceText: "V", targetText: "Slot 6" }
    ]
  })

→ After the tool returns, check if it found the code in the output. If yes, enter_code directly.
→ If no code in output, call scan_page_for_code (noAuto=true).

### Canvas / gesture challenges
If the page requires drawing on a canvas or performing gestures:
→ Fast path: prefer React handlers and synthetic events over raw canvas drawing.
  1. Find the canvas and its React props (e.g. __reactProps$*). If onMouseDown/onMouseMove/onMouseUp exist, call them with event objects containing clientX/clientY computed from getBoundingClientRect().
  2. If handlers exist but calling them doesn't update state, dispatch real DOM MouseEvent/PointerEvent on the canvas (bubbling true) so React picks them up.
  3. Only if React handlers are missing, fall back to direct canvas drawing or fiber state manipulation.
→ After strokes/gestures are completed, look for "Reveal/Complete" buttons and click them, then scan_page_for_code with noAuto=true.

### iframe / shadow DOM / shadow layers
If the page mentions "Shadow DOM Challenge" or has nested "shadow levels":
→ Use page_multi_action to click through each "Shadow Level" and then click Reveal:
  actions: [
    { type: "click", text: "Shadow Level 1" },
    { type: "click", text: "Shadow Level 2" },
    { type: "click", text: "Shadow Level 3" },
    { type: "click", text: "Reveal" },
  ]
→ Then call scan_page_for_code with noAuto=true to find the revealed code.

If scan_page_for_code returns very little content, the challenge may be inside an iframe or real shadow DOM:
→ Use page_evaluate_js to access:
  document.querySelector('iframe')?.contentDocument?.body?.innerText
  or element.shadowRoot?.innerHTML
→ Extract the code from the inner content.`;

const RULES_HAIKU = `
## Available tools ONLY:
scan_page_for_code, enter_code, get_url, escalate, page_evaluate_js, page_multi_action, drag_and_drop

## CRITICAL RULES
- You can ONLY use the tools listed above. Do NOT call any other tool.
- Do NOT navigate away. The page is already on the correct step. Only pass navigate=true to scan_page_for_code when the instruction explicitly provides a URL for the first challenge.
- NEVER click decoy buttons: "Continue", "Next", "Go Forward", "Proceed", "Keep Going"
- If the page asks you to decode/encode/decrypt anything, call escalate immediately after scan_page_for_code.
- If the page is multi-step (sequence of actions, N/4 progress, "Complete N actions"), call escalate immediately after scan_page_for_code.
- If the page mentions "Sequence Challenge" or shows a Progress N/N indicator, call escalate immediately after scan_page_for_code without trying any actions.
- After entering the code, STOP. The orchestrator handles what comes next.
- Act immediately. No explanations needed.
- TOOL CALL BUDGET: You have at most 15 tool calls. If you haven't found the code after 10 calls, try your best guess with enter_code. A wrong answer is better than wasting calls — the orchestrator will escalate to a stronger model.`;

const RULES_OPUS = `
## Available tools ONLY:
scan_page_for_code, enter_code, get_url, page_evaluate_js, page_multi_action, drag_and_drop

## CRITICAL RULES
- You can ONLY use the tools listed above. Do NOT call any other tool.
- Do NOT navigate away. The page is already on the correct step. Only pass navigate=true to scan_page_for_code when the instruction explicitly provides a URL for the first challenge.
- The escalate tool is DISABLED in this session. Never call it.
- NEVER click decoy buttons: "Continue", "Next", "Go Forward", "Proceed", "Keep Going"
- Instruction priority: If the page says "enter ANY X characters" or "exactly X", do that literally. Do NOT infer or decode unless instructed.
- Action-priority: If completion state is reached (e.g. "Complete (4/4)", "All steps done", progress shows N/N), click the obvious primary CTA (Complete/Reveal/Continue Challenge) BEFORE further scanning or DOM/JS inspection.
- Reflection gate: After 2 failed code-retrieval attempts, STOP and re-read instructions. List available UI actions (buttons/links/inputs). Choose the simplest action that follows the instructions and try it next.
- Tool-selection heuristic: Prefer visible UI interactions (click/hover/scroll) over DOM/JS inspection unless no relevant UI action exists.
- Multi-step challenges: Prefer page_multi_action to perform all required actions in one tool call; only use page_evaluate_js if multi_action can't target the elements.
 - Single-shot rule: For interaction-heavy challenges (drag/drop, puzzles, timers), use exactly ONE page_evaluate_js call to perform all actions, then ONE scan_page_for_code (noAuto=true). Do not probe or loop with multiple JS calls.
 - Hard cap: If you already used page_evaluate_js once in this step, your next action must be scan_page_for_code (noAuto=true) or enter_code.
- After entering the code, STOP. The orchestrator handles what comes next.
- Act immediately. No explanations needed.
- TOOL CALL BUDGET: You have at most 20 tool calls. Use them wisely.`;

// Assembled prompts
const SYSTEM_PROMPT_HAIKU = [
  PROMPT_HEADER,
  ESCALATION_SECTION,
  "\n## Challenges you CAN solve (do NOT escalate):",
  SHARED_PLAYBOOKS,
  RULES_HAIKU,
].join("\n");

const SYSTEM_PROMPT_OPUS = [
  PROMPT_HEADER,
  "\n## Pattern playbooks (when auto-solve doesn't find the code):",
  SHARED_PLAYBOOKS,
  ADVANCED_PLAYBOOKS,
  RULES_OPUS,
].join("\n");

// ---- ANSI helpers ----
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

function truncate(s: string, max = 200): string {
  return s.length <= max ? s : s.substring(0, max) + "...";
}

function getToolInput(part: any, state: any): any {
  return (
    state?.input ??
    part?.input ??
    part?.args ??
    part?.arguments ??
    part?.tool?.input ??
    part?.tool?.arguments ??
    part?.tool?.args ??
    null
  );
}

function isEmptyInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return true;
  return Object.keys(input as Record<string, unknown>).length === 0;
}

async function getAvailablePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (err) => {
      server.close();
      if (preferred !== undefined) {
        resolve(getAvailablePort());
      } else {
        reject(err);
      }
    });
    server.listen(preferred ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ---- Timing & Observability ----
interface ThinkingSegment {
  phase: string; // e.g. "initial", "after:scan_page_for_code", "after:enter_code", "final"
  durationMs: number;
  afterToolOutput?: string; // truncated output of the tool that preceded this thinking gap
}

interface ChallengeTimings {
  challengeStart: number;
  toolCalls: number;
  toolTimeMs: number;
  lastEventTime: number;
  currentToolStart: number | null;
  /** URL captured from enter_code tool output during the event stream */
  lastEnterCodeUrl: string | null;
  /** Detailed thinking segments for observability */
  thinkingSegments: ThinkingSegment[];
  /** Track what the last completed tool was, for labeling thinking phases */
  lastCompletedTool: string | null;
  lastToolOutput: string | null;
  /** Whether we've seen the first tool call yet */
  seenFirstTool: boolean;
  /** Whether the agent called the escalate tool */
  escalateRequested: boolean;
}

function newTimings(): ChallengeTimings {
  const now = Date.now();
  return {
    challengeStart: now,
    toolCalls: 0,
    toolTimeMs: 0,
    lastEventTime: now,
    currentToolStart: null,
    lastEnterCodeUrl: null,
    thinkingSegments: [],
    lastCompletedTool: null,
    lastToolOutput: null,
    seenFirstTool: false,
    escalateRequested: false,
  };
}

/** Extract step number from URL like /step5?version=2 */
function getStepFromUrl(url: string): number | null {
  const match = url.match(/\/step(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function main() {
  const totalStart = Date.now();
  console.log(bold("=== Adcock Challenge Agent ==="));
  console.log(`Challenge URL: ${CHALLENGE_URL}`);
  console.log(
    `Model ladder: ${MODEL_LADDER.map((m) => m.modelID).join(" → ")}`,
  );
  console.log(`Headed: ${process.env.HEADED === "true" ? "yes" : "no"}`);
  if (parsed.debugToolInputs) {
    process.env.OPENCODE_DEBUG_TOOL_INPUTS = "true";
    console.log("Debug tool inputs: enabled");
  }
  console.log("");

  // ---- Connect to existing OpenCode server, or start a new one ----
  const defaultModel = MODEL_LADDER[0];
  let client!: ReturnType<typeof createOpencodeClient>;
  const opencodePort = await getAvailablePort();
  const playwrightPort = await getAvailablePort();
  process.env.OPENCODE_PLAYWRIGHT_PORT = String(playwrightPort);

  console.log(
    `Starting OpenCode server on port ${opencodePort} (Playwright: ${playwrightPort})...`,
  );
  const { client: newClient } = await createOpencode({
    port: opencodePort,
    config: {
      model: `${defaultModel.providerID}/${defaultModel.modelID}`,
    },
  });
  client = newClient;
  const health = await client.global.health();
  console.log(
    `Server healthy: ${health.data?.healthy}, version: ${health.data?.version}`,
  );

  // Timing state (shared with event handler)
  let timings = newTimings();

  // Subscribe to event stream
  console.log("Subscribing to event stream...\n");
  const events = await client.event.subscribe();

  const loggedToolInputs = new Set<string>();
  const logToolInputFromMessage = async (
    sessionID: string,
    messageID: string,
    callID: string,
  ) => {
    try {
      const msg = await client.session.message({ sessionID, messageID });
      const parts = (msg.data as any)?.parts as Array<any> | undefined;
      const toolPart = parts?.find(
        (p) => p?.type === "tool" && p?.callID === callID,
      );
      const stateInput = toolPart?.state?.input;
      if (stateInput && !isEmptyInput(stateInput)) {
        const code = typeof stateInput.code === "string" ? stateInput.code : null;
        if (code) {
          process.stdout.write(dim(`  [js:full] ${code}\n`));
        } else {
          process.stdout.write(dim(`  [js:full] ${JSON.stringify(stateInput)}\n`));
        }
      } else {
        process.stdout.write(dim("  [js:full] <input empty in message>\n"));
      }
    } catch (err: any) {
      process.stdout.write(
        dim(`  [js:full] <failed to fetch message: ${err.message}>\n`),
      );
    }
  };

  const eventLoop = (async () => {
    try {
      for await (const event of events.stream) {
        const evt = event as any;
        const type = evt?.type as string | undefined;
        const now = Date.now();

        if (type === "message.part.updated") {
          const part = evt.properties?.part;
          const delta = evt.properties?.delta;
          if (!part) continue;

          // Track thinking gaps with phase labels
          const gap = now - timings.lastEventTime;
          if (gap > 1500 && timings.currentToolStart === null) {
            const phase = !timings.seenFirstTool
              ? "initial"
              : timings.lastCompletedTool
                ? `after:${timings.lastCompletedTool}`
                : "thinking";
            const segment: ThinkingSegment = {
              phase,
              durationMs: gap,
              afterToolOutput: timings.lastToolOutput
                ? truncate(timings.lastToolOutput, 80)
                : undefined,
            };
            timings.thinkingSegments.push(segment);
            process.stdout.write(
              dim(
                `  [thinking ${(gap / 1000).toFixed(1)}s] ${dim(`(${phase})`)}\n`,
              ),
            );
          }
          timings.lastEventTime = now;

          if (part.type === "text") {
            if (delta) process.stdout.write(delta);
          } else if (part.type === "tool") {
            const state = part.state;
            const toolName = part.tool || "?";
            if (state?.status === "pending") {
              timings.currentToolStart = now;
              timings.toolCalls++;
              timings.seenFirstTool = true;
              const input = getToolInput(part, state) as
                | { code?: string; script?: string; source?: string; js?: string }
                | string
                | null;
              process.stdout.write(
                `\n${cyan(`[${toolName}]`)} ${dim("calling")}${input ? " " + dim(truncate(JSON.stringify(input), 100)) : ""}\n`,
              );
              if (
                toolName === "page_evaluate_js" &&
                input &&
                typeof input === "object" &&
                input.code
              ) {
                process.stdout.write(
                  dim(
                    `  [js] ${truncate(input.code.replace(/\s+/g, " "), 300)}\n`,
                  ),
                );
              } else if (toolName === "page_evaluate_js" && typeof input === "string") {
                process.stdout.write(
                  dim(`  [js] ${truncate(input.replace(/\s+/g, " "), 300)}\n`),
                );
              } else if (toolName === "page_evaluate_js" && input) {
                const jsCandidate =
                  typeof input === "object"
                    ? input.script || input.source || input.js
                    : null;
                if (typeof jsCandidate === "string") {
                  process.stdout.write(
                    dim(
                      `  [js] ${truncate(jsCandidate.replace(/\s+/g, " "), 300)}\n`,
                    ),
                  );
                } else {
                  process.stdout.write(dim("  [js] <input not found in event>\n"));
                  process.stdout.write(
                    dim(
                      `  [js:raw] ${truncate(JSON.stringify(part), 600)}\n`,
                    ),
                  );
                }
              }
            } else if (state?.status === "completed") {
              const toolDuration = timings.currentToolStart
                ? now - timings.currentToolStart
                : 0;
              timings.toolTimeMs += toolDuration;
              timings.currentToolStart = null;
              const output = state.output ?? state.result ?? "";
              const outputStr =
                typeof output === "string" ? output : JSON.stringify(output);
              timings.lastCompletedTool = toolName;
              timings.lastToolOutput = outputStr;

              // Detect escalation request from the escalate tool
              if (toolName === "escalate") {
                timings.escalateRequested = true;
              }

              // Detect completion page from scan_page_for_code
              if (toolName === "scan_page_for_code") {
                if (outputStr.includes("STATUS: COMPLETED")) {
                  timings.lastEnterCodeUrl = "completion";
                }
              }

              // Capture URL from enter_code output: "OK: "CODE" | https://..."
              // Keep the highest step URL seen (not the last), because the LLM
              // may enter multiple codes — a correct one that advances the page,
              // then a wrong one on the new page that "stays" on the old step URL.
              if (toolName === "enter_code") {
                const urlMatch = outputStr.match(/\|\s*(https?:\/\/[^\s]+)/);
                if (urlMatch) {
                  const newUrl = urlMatch[1];
                  const newStep = getStepFromUrl(newUrl);
                  const currentStep = getStepFromUrl(
                    timings.lastEnterCodeUrl || "",
                  );
                  if (!currentStep || (newStep && newStep > currentStep)) {
                    timings.lastEnterCodeUrl = newUrl;
                  }
                }
              }

              if (toolName === "page_evaluate_js" && !loggedToolInputs.has(part.callID)) {
                const inputState = state?.input;
                if (!inputState || isEmptyInput(inputState)) {
                  loggedToolInputs.add(part.callID);
                  void logToolInputFromMessage(part.sessionID, part.messageID, part.callID);
                }
              }

              const isEvalDebug =
                toolName === "page_evaluate_js" && parsed.debugToolInputs;
              const isDragDebug =
                toolName === "drag_and_drop" && parsed.debugToolInputs;
              const outputDisplay = isEvalDebug || isDragDebug
                ? outputStr
                : truncate(outputStr, 150);
              process.stdout.write(
                `${cyan(`[${toolName}]`)} ${green("done")} ${dim(`(${(toolDuration / 1000).toFixed(1)}s)`)} ${dim(outputDisplay)}\n`,
              );
            } else if (state?.status === "error") {
              timings.currentToolStart = null;
              process.stdout.write(
                `${cyan(`[${toolName}]`)} ${red("error")} ${state.error || ""}\n`,
              );
            }
          } else if (part.type === "step-finish") {
            const tokens = part.tokens;
            if (tokens) {
              process.stdout.write(
                dim(`--- step (in:${tokens.input} out:${tokens.output}) ---\n`),
              );
            }
          }
        } else if (type === "session.error") {
          process.stdout.write(
            `\n${red("[error]")} ${(evt.properties as any)?.error || "?"}\n`,
          );
        }
      }
    } catch {
      // Stream closed
    }
  })();

  // ---- Main challenge loop (URL-driven, no expectedStep counter) ----
  let lastKnownStep = TARGET_STEP || 1; // Derived from browser URL — the source of truth
  let attemptForStep = 0; // 0-indexed: which model in the ladder to use
  let isFirstChallenge = true;
  let totalRegressions = 0; // Safety counter to prevent infinite regression loops

  // If a target step is specified, update the URL to point directly to it
  if (TARGET_STEP) {
    const baseUrl = CHALLENGE_URL.replace(/\/$/, "");
    CHALLENGE_URL = `${baseUrl}/step${TARGET_STEP}?version=${parsed.version}`;
  } else if (parsed.versionProvided) {
    try {
      const urlObj = new URL(CHALLENGE_URL);
      if (!urlObj.searchParams.has("version")) {
        urlObj.searchParams.set("version", parsed.version);
        CHALLENGE_URL = urlObj.toString();
      }
    } catch {}
  }

  const challengeResults: Array<{
    step: number;
    timeMs: number;
    tools: number;
    success: boolean;
    model: string;
  }> = [];

  while (lastKnownStep <= MAX_CHALLENGES) {
    timings = newTimings();
    const currentStep = lastKnownStep;
    const model = getModelForAttempt(attemptForStep);

    if (attemptForStep === 0) {
      console.log(
        bold(`\n${"=".repeat(20)} Challenge ${currentStep} ${"=".repeat(20)}`),
      );
    } else {
      console.log(
        yellow(
          `\n  Attempt ${attemptForStep + 1}/${MAX_ATTEMPTS} — escalating to ${bold(model.modelID)}`,
        ),
      );
    }

    // --- Abort-on-escalate state (declared outside try so catch can access) ---
    let abortedForEscalate = false;
    let escalateWatcherDone = false;

    try {
      // Fresh session per challenge (context isolation)
      const sessionResult = await client.session.create({
        title: `Step ${currentStep} (attempt ${attemptForStep + 1}, ${model.modelID})`,
      });
      const sessionId = sessionResult.data!.id;

      // Build instruction — first challenge gets URL, subsequent ones don't
      let instruction: string;
      if (isFirstChallenge) {
        if (TARGET_STEP) {
          instruction = `Navigate to the challenge step. Call scan_page_for_code with url="${CHALLENGE_URL}" and navigate=true. Then find the code and call enter_code to submit it. STOP after entering the code.`;
        } else {
          instruction = `Navigate to the challenge and solve it. Call scan_page_for_code with url="${CHALLENGE_URL}" and navigate=true to open the page (it will auto-click START). Then find the code and call enter_code to submit it. STOP after entering the code.`;
        }
        isFirstChallenge = false;
      } else {
        instruction = `Solve this challenge step. Call scan_page_for_code to read the page and find the code, then call enter_code to submit it. Do NOT navigate away. STOP after entering the code.`;
      }

      // Select prompt and tools based on model — haiku gets escalate tool, opus gets full playbooks
      const isOpus =
        model.modelID === MODEL_LADDER[MODEL_LADDER.length - 1].modelID;
      const systemPrompt = isOpus ? SYSTEM_PROMPT_OPUS : SYSTEM_PROMPT_HAIKU;
      const tools = isOpus ? TOOLS_WITHOUT_ESCALATE : TOOLS_WITH_ESCALATE;

      const promptPromise = client.session.prompt({
        sessionID: sessionId,
        model,
        system: systemPrompt,
        tools,
        parts: [{ type: "text" as const, text: instruction }],
      });

      // Watch for escalate tool call on non-opus models — abort and switch to opus
      if (model.modelID !== MODEL_LADDER[MODEL_LADDER.length - 1].modelID) {
        (async () => {
          while (!escalateWatcherDone) {
            await new Promise((r) => setTimeout(r, 200));

            if (timings.escalateRequested && !timings.lastEnterCodeUrl) {
              abortedForEscalate = true;
              console.log(
                yellow(
                  `\n  Escalate requested — aborting ${model.modelID}, escalating to opus`,
                ),
              );
              try {
                await client.session.abort({ sessionID: sessionId });
              } catch (e: any) {
                console.log(dim(`  abort() error (non-fatal): ${e.message}`));
              }
              return;
            }

            if (timings.lastEnterCodeUrl) return;
          }
        })();
      }

      const result = await promptPromise.finally(() => {
        escalateWatcherDone = true;
      });

      // If we aborted for escalation, skip to opus
      if (abortedForEscalate) {
        attemptForStep = 1;
        continue;
      }

      const message = result.data as any;
      const challengeTime = Date.now() - timings.challengeStart;
      const thinkingTime = challengeTime - timings.toolTimeMs;

      // Print timing summary
      console.log(
        magenta(
          `\n  Timing: ${(challengeTime / 1000).toFixed(1)}s total | ` +
            `${(timings.toolTimeMs / 1000).toFixed(1)}s tools (${timings.toolCalls} calls) | ` +
            `${(thinkingTime / 1000).toFixed(1)}s model thinking` +
            ` | ${model.modelID}`,
        ),
      );

      if (timings.thinkingSegments.length > 0) {
        const segments = timings.thinkingSegments
          .map((s) => `${s.phase}:${(s.durationMs / 1000).toFixed(1)}s`)
          .join(", ");
        console.log(dim(`  Thinking breakdown: [${segments}]`));
        for (const seg of timings.thinkingSegments) {
          if (seg.durationMs > 5000) {
            console.log(
              yellow(
                `  SLOW thinking: ${(seg.durationMs / 1000).toFixed(1)}s in "${seg.phase}"${seg.afterToolOutput ? ` after: ${dim(seg.afterToolOutput)}` : ""}`,
              ),
            );
          }
        }
      }

      if (!message || !message.parts) {
        console.log(yellow("  No response from model"));
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: false,
          model: model.modelID,
        });
        attemptForStep++;
        if (attemptForStep >= MAX_ATTEMPTS) {
          console.log(
            red(
              `  All ${MAX_ATTEMPTS} models failed on step ${currentStep}. Skipping.`,
            ),
          );
          attemptForStep = 0;
          lastKnownStep = currentStep + 1;
        }
        continue;
      }

      // ---- Determine outcome from browser URL (source of truth) ----
      const afterUrl = timings.lastEnterCodeUrl || "";
      const afterStep = afterUrl ? getStepFromUrl(afterUrl) : null;

      if (afterUrl) {
        console.log(dim(`  Page URL: ${afterUrl}`));
      }

      // Check for completion page
      if (
        afterUrl === "completion" ||
        afterUrl.includes("congratulations") ||
        afterUrl.includes("complete")
      ) {
        console.log(green("\n=== All challenges completed! ==="));
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: true,
          model: model.modelID,
        });
        break;
      }

      if (afterStep && afterStep > currentStep) {
        // Success — page advanced
        console.log(
          green(
            `  Step ${currentStep} solved! Page now on step ${afterStep}${attemptForStep > 0 ? ` (needed ${model.modelID})` : ""}`,
          ),
        );
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: true,
          model: model.modelID,
        });
        lastKnownStep = afterStep;
        attemptForStep = 0;
      } else if (afterStep && afterStep < currentStep) {
        // Browser regressed (page reloaded, navigated away, etc.) — reset to actual position
        totalRegressions++;
        console.log(
          yellow(
            `  Browser regressed to step ${afterStep} (was on step ${currentStep}). Resetting to step ${afterStep}.`,
          ),
        );
        lastKnownStep = afterStep;
        attemptForStep = 0;
        if (totalRegressions > 10) {
          console.log(red("  Too many regressions. Stopping."));
          break;
        }
        // Don't record as failure — just continue from new position
      } else {
        // afterStep === currentStep OR no URL captured → failed to advance
        if (!afterStep && !afterUrl) {
          console.log(
            yellow(`  No URL captured — assuming still on step ${currentStep}`),
          );
        } else {
          console.log(
            yellow(`  Still on step ${currentStep} — ${model.modelID} failed`),
          );
        }
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: false,
          model: model.modelID,
        });
        attemptForStep++;
        if (attemptForStep >= MAX_ATTEMPTS) {
          console.log(
            red(
              `  All ${MAX_ATTEMPTS} models failed on step ${currentStep}. Skipping.`,
            ),
          );
          attemptForStep = 0;
          lastKnownStep = currentStep + 1;
        }
      }
    } catch (err: any) {
      // If we aborted for escalation, the prompt throws — handle it gracefully
      if (
        abortedForEscalate ||
        (timings.escalateRequested &&
          attemptForStep === 0 &&
          !timings.lastEnterCodeUrl)
      ) {
        console.log(yellow(`  Aborted ${model.modelID} — escalating to opus`));
        attemptForStep = 1;
        continue;
      }

      const challengeTime = Date.now() - timings.challengeStart;
      const errorModel = getModelForAttempt(attemptForStep);
      console.error(
        red(
          `  Error on step ${currentStep} (${errorModel.modelID}): ${err.message}`,
        ),
      );
      challengeResults.push({
        step: currentStep,
        timeMs: challengeTime,
        tools: timings.toolCalls,
        success: false,
        model: errorModel.modelID,
      });
      attemptForStep++;
      if (attemptForStep >= MAX_ATTEMPTS) {
        console.log(
          red(
            `  All ${MAX_ATTEMPTS} models failed on step ${currentStep}. Skipping.`,
          ),
        );
        attemptForStep = 0;
        lastKnownStep = currentStep + 1;
      }
    }
  }

  // ---- Final summary ----
  const totalTime = Date.now() - totalStart;
  console.log(bold("\n" + "=".repeat(60)));
  console.log(bold("FINAL SUMMARY"));
  console.log(bold("=".repeat(60)));
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(
    `Model ladder: ${MODEL_LADDER.map((m) => m.modelID).join(" → ")}`,
  );

  // Count unique steps attempted (not individual attempts)
  const stepsAttempted = new Set(challengeResults.map((r) => r.step)).size;
  const successes = challengeResults.filter((r) => r.success).length;
  const escalations = challengeResults.filter(
    (r) => r.success && r.model !== MODEL_LADDER[0].modelID,
  ).length;
  console.log(`Steps attempted: ${stepsAttempted}`);
  console.log(`Solved: ${successes}/${stepsAttempted}`);
  if (escalations > 0) {
    console.log(
      `Escalations needed: ${escalations} (solved by stronger model)`,
    );
  }
  console.log(
    `Total attempts: ${challengeResults.length} (${challengeResults.length - stepsAttempted} retries)`,
  );
  console.log(
    `Avg per step: ${stepsAttempted > 0 ? (totalTime / stepsAttempted / 1000).toFixed(1) : 0}s`,
  );
  console.log(
    `Avg tool calls: ${challengeResults.length > 0 ? (challengeResults.reduce((s, r) => s + r.tools, 0) / challengeResults.length).toFixed(1) : 0}`,
  );
  console.log("");

  // Group results by step for display
  const stepMap = new Map<number, typeof challengeResults>();
  for (const r of challengeResults) {
    if (!stepMap.has(r.step)) stepMap.set(r.step, []);
    stepMap.get(r.step)!.push(r);
  }
  for (const [step, attempts] of stepMap) {
    const success = attempts.find((a) => a.success);
    if (success) {
      const escalation =
        attempts.length > 1
          ? dim(
              ` (${attempts.length} attempts: ${attempts.map((a) => a.model.replace("claude-", "")).join(" → ")})`,
            )
          : "";
      console.log(
        `  Step ${String(step).padStart(2)}: ${green("OK")} ${(success.timeMs / 1000).toFixed(1)}s (${success.tools} tools, ${success.model})${escalation}`,
      );
    } else {
      const models = attempts
        .map((a) => a.model.replace("claude-", ""))
        .join(", ");
      console.log(
        `  Step ${String(step).padStart(2)}: ${red("FAIL")} (${attempts.length} attempts: ${models})`,
      );
    }
  }

  console.log("\nDone. Browser left open for debugging. Press Ctrl+C to exit.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
});
