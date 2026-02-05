/**
 * Agent Orchestrator — TanStack AI SDK
 *
 * Architecture:
 * - Single-process script: calls LLM directly via TanStack AI's chat() with tools
 * - Tools run in-process with a shared Playwright browser singleton
 * - No server/client split, no SSE, no sessions — just a direct agent loop
 * - Stream chunks used for real-time logging and state tracking
 *
 * Usage:
 *   npm run agent [-- [challenge-url] [--provider <id>] [--model <name>]]
 *   npm run agent:headed [-- [challenge-url] [--provider <id>] [--model <name>]]
 *
 * Examples:
 *   npm run agent:headed
 *   npm run agent:headed -- --provider openai --model gpt-4o
 *   npm run agent:headed -- https://example.com --provider anthropic --model claude-opus-4-6
 */
import { chat, maxIterations } from "@tanstack/ai"
import { anthropicText } from "@tanstack/ai-anthropic"
import { openaiText } from "@tanstack/ai-openai"
import { createOpenCodeAnthropicAdapter } from "./auth/opencode-adapter"
import { createOpenCodeOpenAIAdapter } from "./auth/opencode-openai-adapter"

// Tool imports
import { scanPageForCode } from "./tools/scan-page"
import { enterCode } from "./tools/enter-code"
import { evaluateJs, multiAction, clickElement, getPageHtml, pressKey, scroll, selectOption, checkCheckbox, hover } from "./tools/page"
import { dragAndDrop } from "./tools/drag-and-drop"
import { escalate } from "./tools/escalate"
import { getUrl } from "./tools/get-url"
import { getModalButtons } from "./tools/modal"
import { closeBrowser } from "./tools/browser"

// ---- CLI argument parsing ----
function parseArgs(argv: string[]): {
  url: string;
  provider: string;
  model: string;
  adapter: "auto" | "opencode" | "env";
  step: number | null;
  only: boolean;
  version: string;
  versionProvided: boolean;
  debugToolInputs: boolean;
  verbose: boolean;
  debugChunks: boolean;
  timeoutSeconds: number;
} {
  const args = argv.slice(2); // skip node + script
  let url = "";
  let provider = "anthropic";
let model = "claude-opus-4-6";
  let adapter: "auto" | "opencode" | "env" = "auto";
  let step: number | null = null;
  let only = false;
  let version = "2";
  let versionProvided = false;
  let debugToolInputs = false;
  let verbose = false;
  let debugChunks = false;
  let timeoutSeconds = 180;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && i + 1 < args.length) {
      provider = args[++i];
    } else if (args[i] === "--model" && i + 1 < args.length) {
      model = args[++i];
    } else if (args[i] === "--adapter" && i + 1 < args.length) {
      const value = args[++i] as "auto" | "opencode" | "env";
      if (value === "auto" || value === "opencode" || value === "env") {
        adapter = value;
      }
    } else if (args[i] === "--step" && i + 1 < args.length) {
      step = parseInt(args[++i], 10);
    } else if (args[i] === "--only") {
      only = true;
    } else if (args[i] === "--version" && i + 1 < args.length) {
      version = args[++i];
      versionProvided = true;
    } else if (args[i] === "--debug-tool-inputs") {
      debugToolInputs = true;
    } else if (args[i] === "--verbose") {
      verbose = true;
    } else if (args[i] === "--debug-chunks") {
      debugChunks = true;
    } else if (args[i] === "--timeout-seconds" && i + 1 < args.length) {
      const parsedTimeout = parseInt(args[++i], 10);
      if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) {
        timeoutSeconds = parsedTimeout;
      }
    } else if (!args[i].startsWith("--")) {
      url = args[i];
    }
  }

  // --only implies --step must be set; if --step is set, --only is the default
  if (step !== null) {
    only = true;
  }

  return {
    url: url || "https://serene-frangipane-7fd25b.netlify.app/",
    provider,
    model,
    adapter,
    step,
    only,
    version,
    versionProvided,
    debugToolInputs,
    verbose,
    debugChunks,
    timeoutSeconds,
  };
}

const parsed = parseArgs(process.argv);
let CHALLENGE_URL = parsed.url;
const MAX_CHALLENGES = 35;
const TARGET_STEP = parsed.step;

const MODEL_LADDER = [
  {
    providerID: parsed.provider,
    modelID: parsed.model,
  },
];

function getModelForAttempt(attempt: number): {
  providerID: string;
  modelID: string;
} {
  const idx = Math.min(attempt, MODEL_LADDER.length - 1);
  return MODEL_LADDER[idx];
}

const MAX_ATTEMPTS = MODEL_LADDER.length;

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
Before taking any action, read the page instructions and constraints (e.g. "enter ANY 6 characters", "exactly 6", "click Reveal"). Prioritize these over hints, encoded strings, or decoys.
If you see a form instruction, follow it literally before trying to decode or derive anything.

### Failure reset
If two consecutive attempts fail (wrong code or no progress): STOP. Re-read the instructions and scan for high-signal guidance (labels, placeholders, warning callouts).
Then take the simplest compliant action from the instructions (e.g. "type any 6 characters" + "click Reveal").

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

function looksLikeErrorOutput(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // Tool results are now JSON objects; check for error field
  if (t.startsWith("{")) {
    try {
      const parsed = JSON.parse(t);
      return !!parsed?.error || !!parsed?.message;
    } catch {
      return false;
    }
  }
  if (t.startsWith("Error:")) return true;
  return false;
}

/** Extract a human-readable string from a tool result (which is now always JSON) */
function extractOutputText(outputStr: string): string {
  try {
    const parsed = JSON.parse(outputStr);
    if (parsed?.output) return parsed.output;
    if (parsed?.result) return typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
    if (parsed?.error) return `Error: ${parsed.error}`;
    return outputStr;
  } catch {
    return outputStr;
  }
}

function formatToolOutput(toolName: string, outputStr: string): string {
  // Tool results are JSON; extract the text content for display
  const text = extractOutputText(outputStr);

  if (looksLikeErrorOutput(outputStr)) {
    return text;
  }

  if (toolName === "scan_page_for_code") {
    // Check for completion status
    try {
      const parsed = JSON.parse(outputStr);
      if (parsed?.status === "COMPLETED") return `STATUS: COMPLETED — ${parsed.message || "All challenges finished!"}`;
    } catch {}
    // Fall through to line-based extraction from the output field
    const lines = text.split("\n");
    const picked: string[] = [];
    for (const line of lines) {
      if (
        line.startsWith("URL:") ||
        line.startsWith("Popups dismissed:") ||
        line.startsWith("Auto:") ||
        line.includes("STATUS: COMPLETED")
      ) {
        picked.push(line);
      }
      if (line.trim() === "CODE CANDIDATES:" && picked.length > 0) {
        picked.push(line);
      }
      if (picked.length >= 6) break;
    }
    if (picked.length > 0) return picked.join("\n");
  }

  if (toolName === "enter_code") {
    try {
      const parsed = JSON.parse(outputStr);
      if (parsed?.status === "OK") return `OK: "${parsed.code}" | ${parsed.newUrl} | urlChanged=${parsed.urlChanged}`;
    } catch {}
  }

  return truncate(text, 220);
}

/** Extract a brief summary from tool output for the challenge timeline */
function briefToolSummary(toolName: string, outputStr: string): string {
  try {
    const parsed = typeof outputStr === "string" ? JSON.parse(outputStr) : outputStr;
    if (parsed?.error) return `error: ${truncate(parsed.error, 60)}`;
    if (toolName === "scan_page_for_code") {
      if (parsed?.status === "COMPLETED") return "COMPLETED";
      const text = parsed?.output || "";
      const codeMatch = text.match(/CODE CANDIDATES:\n\s+\[([^\]]+)\]\s+(\S+)/);
      if (codeMatch) return `found: ${codeMatch[2]}`;
      if (text.includes("No code candidates")) return "no codes found";
      return "scanned";
    }
    if (toolName === "enter_code") {
      if (parsed?.status === "OK") return `submitted "${parsed.code}" → step ${getStepFromUrl(parsed.newUrl) || "?"}`;
      return "submitted";
    }
    if (toolName === "escalate") return `escalate: ${parsed?.reason || "?"}`;
    if (toolName === "get_url") return parsed?.url || "got url";
    if (parsed?.result) return truncate(String(parsed.result), 60);
    if (parsed?.output) return truncate(String(parsed.output), 60);
  } catch {}
  return truncate(outputStr, 60);
}

/** Extract step number from URL like /step5?version=2 */
function getStepFromUrl(url: string): number | null {
  const match = url.match(/\/step(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Create adapter for a provider/model combo.
 *  adapterMode:
 *  - auto: try OpenCode auth first, then env key fallback
 *  - opencode: require OpenCode auth path
 *  - env: require env key path */
async function createAdapter(
  providerID: string,
  modelID: string,
  adapterMode: "auto" | "opencode" | "env",
) {
  if (providerID === "anthropic") {
    if (adapterMode === "env") {
      return anthropicText(modelID as any);
    }
    if (adapterMode === "opencode") {
      return await createOpenCodeAnthropicAdapter(modelID);
    }
    // auto
    try {
      return await createOpenCodeAnthropicAdapter(modelID);
    } catch {
      return anthropicText(modelID as any);
    }
  }
  if (providerID === "openai") {
    if (adapterMode === "env") {
      return openaiText(modelID as any)
    }
    if (adapterMode === "opencode") {
      return await createOpenCodeOpenAIAdapter(modelID)
    }
    // auto
    try {
      return await createOpenCodeOpenAIAdapter(modelID)
    } catch {
      return openaiText(modelID as any)
    }
  }
  // Fallback to anthropic
  return anthropicText(modelID as any);
}

// ---- Tool sets ----
// Tools for opus (no escalate)
const TOOLS_OPUS = [
  scanPageForCode,
  enterCode,
  evaluateJs,
  multiAction,
  dragAndDrop,
  getUrl,
];

// Tools for haiku/lighter models (with escalate)
const TOOLS_WITH_ESCALATE = [
  scanPageForCode,
  enterCode,
  evaluateJs,
  multiAction,
  dragAndDrop,
  getUrl,
  escalate,
];

// ---- Timing & Observability ----
interface ToolCallRecord {
  name: string;
  durationMs: number;
  success: boolean;
  /** Brief outcome, e.g. "code: FEYPRM" or "error: no input found" */
  summary: string;
}

interface ThinkingRecord {
  afterTool: string | null;
  durationMs: number;
}

interface ChallengeTimings {
  challengeStart: number;
  toolCalls: number;
  toolTimeMs: number;
  /** URL captured from enter_code tool output */
  lastEnterCodeUrl: string | null;
  /** Whether the agent called the escalate tool */
  escalateRequested: boolean;
  /** Track tool call start times by name */
  currentToolStart: number | null;
  /** Per-tool call records for end-of-challenge summary */
  toolRecords: ToolCallRecord[];
  /** Thinking gap records */
  thinkingRecords: ThinkingRecord[];
}

function newTimings(): ChallengeTimings {
  return {
    challengeStart: Date.now(),
    toolCalls: 0,
    toolTimeMs: 0,
    lastEnterCodeUrl: null,
    escalateRequested: false,
    currentToolStart: null,
    toolRecords: [],
    thinkingRecords: [],
  };
}

async function main() {
  const totalStart = Date.now();
  console.log(bold("=== Adcock Challenge Agent (TanStack AI) ==="));
  console.log(`Challenge URL: ${CHALLENGE_URL}`);
  console.log(
    `Model ladder: ${MODEL_LADDER.map((m) => m.modelID).join(" → ")}`,
  );
  console.log(`Headed: ${process.env.HEADED === "true" ? "yes" : "no"}`);
  if (TARGET_STEP) {
    console.log(`Step: ${TARGET_STEP} (single step mode)`);
  }
  console.log(`Verbose: ${parsed.verbose ? "yes" : "no"}`);
  console.log(`Debug chunks: ${parsed.debugChunks ? "yes" : "no"}`);
  console.log(`Adapter mode: ${parsed.adapter}`);
  console.log(`Per-challenge timeout: ${parsed.timeoutSeconds}s`);
  // Check auth sources based on provider + adapter mode
  let hasOpenCodeAuth = false;
  const hasEnvAuth = parsed.provider === "openai"
    ? !!process.env.OPENAI_API_KEY
    : !!process.env.ANTHROPIC_API_KEY;

  if (parsed.provider === "openai") {
    try {
      const { loadOpenAIAuth } = await import("./auth/opencode-openai-adapter")
      const auth = await loadOpenAIAuth()
      hasOpenCodeAuth = true
      console.log(
        `Auth(OpenCode): OpenAI ${auth.type === "oauth" ? "OAuth" : "API key"} ${green("found")}` +
          (auth.type === "oauth" ? ` (expires: ${new Date((auth as any).expires).toLocaleTimeString()})` : ""),
      )
    } catch {
      console.log(`Auth(OpenCode): OpenAI ${red("missing")}`)
    }
    console.log(`Auth(env): OPENAI_API_KEY ${hasEnvAuth ? green("set") : red("missing")}`)
  } else {
    try {
      const { loadAnthropicAuth } = await import("./auth/opencode-auth");
      const auth = await loadAnthropicAuth();
      hasOpenCodeAuth = true;
      console.log(
        `Auth(OpenCode): Anthropic ${auth.type === "oauth" ? "OAuth" : "API key"} ${green("found")}` +
          (auth.type === "oauth" ? ` (expires: ${new Date((auth as any).expires).toLocaleTimeString()})` : ""),
      );
    } catch {
      console.log(`Auth(OpenCode): Anthropic ${red("missing")}`)
    }
    console.log(`Auth(env): ANTHROPIC_API_KEY ${hasEnvAuth ? green("set") : red("missing")}`)
  }
  if (parsed.debugToolInputs) {
    process.env.OPENCODE_DEBUG_TOOL_INPUTS = "true";
    console.log("Debug tool inputs: enabled");
  }
  if (parsed.adapter === "opencode" && !hasOpenCodeAuth) {
    console.error(red("Adapter mode is 'opencode' but OpenCode credentials were not found."))
    return
  }
  if (parsed.adapter === "env" && !hasEnvAuth) {
    const envVar = parsed.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
    console.error(red(`Adapter mode is 'env' but ${envVar} is missing.`))
    return
  }
  if (parsed.adapter === "auto" && !hasOpenCodeAuth && !hasEnvAuth) {
    if (parsed.provider === "openai") {
      console.error(red("No auth found. Connect OpenAI in OpenCode or set OPENAI_API_KEY."))
    } else {
      console.error(red("No auth found. Connect Anthropic in OpenCode or set ANTHROPIC_API_KEY."))
    }
    return
  }
  console.log("");

  // ---- Main challenge loop (URL-driven, no expectedStep counter) ----
  let lastKnownStep = TARGET_STEP || 1;
  let attemptForStep = 0;
  let isFirstChallenge = true;
  let totalRegressions = 0;
  const finalStep = TARGET_STEP ?? MAX_CHALLENGES;

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

  while (lastKnownStep <= finalStep) {
    const timings = newTimings();
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

    try {
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

      // Select prompt and tools based on model
      const isOpus =
        model.modelID === MODEL_LADDER[MODEL_LADDER.length - 1].modelID;
      const systemPrompt = isOpus ? SYSTEM_PROMPT_OPUS : SYSTEM_PROMPT_HAIKU;
      const tools = isOpus ? TOOLS_OPUS : TOOLS_WITH_ESCALATE;

      // Create the adapter (async — may load OpenCode OAuth credentials)
      const adapter = await createAdapter(model.providerID, model.modelID, parsed.adapter);

      console.log(
        dim(
          `  Model call: provider=${model.providerID} model=${model.modelID} tools=${tools.length} maxIterations=20`,
        ),
      );
      if (parsed.verbose) {
        console.log(dim(`  Instruction: ${truncate(instruction, 220)}`));
      }

      const abortController = new AbortController();
      const streamStart = Date.now();
      let chunkCount = 0;
      let firstChunkAt: number | null = null;
      let lastChunkAt = Date.now();
      let heartbeatPhase = "awaiting first chunk";
      const thinkingSegments: string[] = [];
      let lastToolEndedAt: number | null = null;
      let lastToolNameForGap: string | null = null;
      let currentToolName: string | null = null;
      const toolArgsById = new Map<string, string>();
      const toolNameById = new Map<string, string>();
      const toolStartById = new Map<string, number>();
      const seenRunFinished = new Set<string>();

      const timeoutHandle = setTimeout(() => {
        console.log(
          yellow(
            `\n  Challenge timeout after ${parsed.timeoutSeconds}s. Aborting model stream...`,
          ),
        );
        abortController.abort();
      }, parsed.timeoutSeconds * 1000);

      const heartbeatHandle = setInterval(() => {
        const now = Date.now();
        const elapsed = ((now - streamStart) / 1000).toFixed(1);
        const sinceLastChunk = ((now - lastChunkAt) / 1000).toFixed(1);
        console.log(
          dim(
            `  heartbeat: elapsed=${elapsed}s phase=${heartbeatPhase} chunks=${chunkCount} tools=${timings.toolCalls} lastChunkAgo=${sinceLastChunk}s`,
          ),
        );
      }, 10000);

      // Call TanStack AI chat() with streaming
      const stream = chat({
        adapter,
        messages: [{ role: "user" as const, content: instruction }],
        systemPrompts: [systemPrompt],
        tools,
        agentLoopStrategy: maxIterations(20),
        abortController,
      });

      console.log(dim("  Stream created. Waiting for first chunk..."));

      // Process stream chunks for logging + state extraction
      try {
        for await (const chunk of stream) {
          chunkCount++;
          if (!firstChunkAt) {
            firstChunkAt = Date.now();
            console.log(
              dim(
                `  First chunk received after ${((firstChunkAt - streamStart) / 1000).toFixed(2)}s`,
              ),
            );
          }
          lastChunkAt = Date.now();
          const chunkType = (chunk as any).type as string;
          heartbeatPhase = chunkType;
          if (parsed.debugChunks) {
            const preview = (() => {
              try {
                return JSON.stringify(chunk).slice(0, 800)
              } catch {
                return String(chunk)
              }
            })()
            console.log(dim(`  chunk[${chunkCount}] type=${chunkType} ${preview}`));
          }

          if (chunkType === "TEXT_MESSAGE_CONTENT") {
            if (parsed.verbose) {
              const delta = (chunk as any).delta || (chunk as any).content || "";
              if (delta) process.stdout.write(delta);
            }
          } else if (chunkType === "TOOL_CALL_START") {
            const toolCallId = (chunk as any).toolCallId as string;
            const toolName = ((chunk as any).toolName || "?") as string;
            const now = Date.now();

            if (lastToolEndedAt) {
              const gapMs = now - lastToolEndedAt;
              const gapSec = gapMs / 1000;
              if (gapSec >= 0.5) {
                const label = lastToolNameForGap ? `after:${lastToolNameForGap}` : "initial";
                const segment = `${label}:${gapSec.toFixed(1)}s`;
                thinkingSegments.push(segment);
                timings.thinkingRecords.push({ afterTool: lastToolNameForGap, durationMs: gapMs });
                console.log(`  ${dim(`[thinking ${gapSec.toFixed(1)}s] (${label})`)}`);
              }
            } else {
              const initialGapMs = now - streamStart;
              const initialGapSec = initialGapMs / 1000;
              if (initialGapSec >= 0.3) {
                const segment = `initial:${initialGapSec.toFixed(1)}s`;
                thinkingSegments.push(segment);
                timings.thinkingRecords.push({ afterTool: null, durationMs: initialGapMs });
                console.log(`  ${dim(`[thinking ${initialGapSec.toFixed(1)}s] (initial)`)}`);
              }
            }

            timings.toolCalls++;
            timings.currentToolStart = now;
            currentToolName = toolName;
            toolNameById.set(toolCallId, toolName);
            toolStartById.set(toolCallId, now);
            process.stdout.write(`\n${cyan(`[${toolName}]`)} ${dim("calling")} {}\n`);
          } else if (chunkType === "TOOL_CALL_ARGS") {
            const toolCallId = ((chunk as any).toolCallId || "") as string;
            const delta = ((chunk as any).delta || "") as string;
            if (!toolCallId) continue;
            const prev = toolArgsById.get(toolCallId) || "";
            const next = prev + delta;
            toolArgsById.set(toolCallId, next);
          } else if (chunkType === "TOOL_CALL_END") {
            const toolCallId = ((chunk as any).toolCallId || "") as string;
            const toolName = ((chunk as any).toolName || toolNameById.get(toolCallId) || "?") as string;
            const hasResult = (chunk as any).result !== undefined;
            const output = (chunk as any).result;
            const outputStr = hasResult
              ? (typeof output === "string" ? output : JSON.stringify(output))
              : "";

            const inputObj = (chunk as any).input;
            let parsedInput: any = inputObj;
            if (!parsedInput) {
              const rawArgs = toolArgsById.get(toolCallId) || "";
              if (rawArgs) {
                try {
                  parsedInput = JSON.parse(rawArgs);
                } catch {
                  parsedInput = {};
                }
              }
            }

            if (toolName === "page_evaluate_js" && parsedInput?.code) {
              process.stdout.write(
                `  ${dim(`[js] ${truncate(String(parsedInput.code).replace(/\s+/g, " "), 300)}`)}\n`,
              );
              if (parsed.debugToolInputs) {
                process.stdout.write(`  ${dim(`[js:raw] ${truncate(JSON.stringify(parsedInput), 500)}`)}\n`);
              }
            }

            // Detect escalation (now JSON: { action: "ESCALATE", reason: "..." })
            if (toolName === "escalate") {
              timings.escalateRequested = true;
            }

            // Detect completion page from scan_page_for_code (now JSON with status field)
            if (toolName === "scan_page_for_code") {
              try {
                const parsed = typeof output === "object" ? output : JSON.parse(outputStr);
                if (parsed?.status === "COMPLETED") {
                  timings.lastEnterCodeUrl = "completion";
                }
              } catch {
                // Fallback: check raw string
                if (outputStr.includes("COMPLETED")) {
                  timings.lastEnterCodeUrl = "completion";
                }
              }
            }

            // Capture URL from enter_code output (now JSON with newUrl field)
            let stepAdvanced = false;
            if (toolName === "enter_code") {
              try {
                const parsed = typeof output === "object" ? output : JSON.parse(outputStr);
                if (parsed?.newUrl) {
                  const newUrl = parsed.newUrl;
                  const newStep = getStepFromUrl(newUrl);
                  const currentStepFromUrl = getStepFromUrl(timings.lastEnterCodeUrl || "");
                  if (!currentStepFromUrl || (newStep && newStep > currentStepFromUrl)) {
                    timings.lastEnterCodeUrl = newUrl;
                    if (newStep && newStep > currentStep) {
                      stepAdvanced = true;
                    }
                  }
                }
              } catch {
                // Fallback: regex match
                const urlMatch = outputStr.match(/\|\s*(https?:\/\/[^\s]+)/);
                if (urlMatch) {
                  const newUrl = urlMatch[1];
                  const newStep = getStepFromUrl(newUrl);
                  const currentStepFromUrl = getStepFromUrl(timings.lastEnterCodeUrl || "");
                  if (!currentStepFromUrl || (newStep && newStep > currentStepFromUrl)) {
                    timings.lastEnterCodeUrl = newUrl;
                    if (newStep && newStep > currentStep) {
                      stepAdvanced = true;
                    }
                  }
                }
              }
            }

            if (hasResult) {
              const startedAt = toolStartById.get(toolCallId) || timings.currentToolStart || Date.now();
              const toolDuration = Date.now() - startedAt;
              timings.toolTimeMs += toolDuration;
              timings.currentToolStart = null;
              currentToolName = null;
              toolStartById.delete(toolCallId);

              const isError = looksLikeErrorOutput(outputStr);
              const brief = briefToolSummary(toolName, outputStr);
              timings.toolRecords.push({
                name: toolName,
                durationMs: toolDuration,
                success: !isError,
                summary: brief,
              });

              const durationStr = toolDuration >= 1000
                ? yellow(`${(toolDuration / 1000).toFixed(1)}s`)
                : green(`${(toolDuration / 1000).toFixed(1)}s`);
              process.stdout.write(
                `${cyan(`[${toolName}]`)} ${isError ? red("err") : green("done")} (${durationStr}) ${formatToolOutput(toolName, outputStr)}\n`,
              );

              lastToolEndedAt = Date.now();
              lastToolNameForGap = toolName;
            }

            // Abort the stream immediately after enter_code advances the step.
            // The outer loop will start a fresh chat() for the next challenge,
            // keeping context small and giving each step its own summary/timeout.
            if (stepAdvanced) {
              console.log(dim(`  Step advanced — ending chat to start fresh for next challenge`));
              abortController.abort();
            }
          } else if (chunkType === "RUN_FINISHED") {
            const usage = (chunk as any).usage;
            const runId = (chunk as any).runId || "unknown";
            const inTok = usage?.promptTokens;
            const outTok = usage?.completionTokens;
            const key = `${runId}:${inTok ?? "?"}:${outTok ?? "?"}`;
            if (!seenRunFinished.has(key)) {
              seenRunFinished.add(key);
              if (typeof inTok === "number" && typeof outTok === "number") {
                console.log(`${dim(`--- step (in:${inTok} out:${outTok}) ---`)}`);
              }
            }
          } else if (chunkType === "tool-result") {
            const toolName = (chunk as any).name || (chunk as any).toolName || "?";
            const output = (chunk as any).output ?? (chunk as any).result ?? "";
            const outputStr = typeof output === "string" ? output : JSON.stringify(output);

            if (!timings.currentToolStart && !parsed.debugChunks) {
              continue;
            }

            const toolDuration = timings.currentToolStart
              ? Date.now() - timings.currentToolStart
              : 0;
            timings.toolTimeMs += toolDuration;
            timings.currentToolStart = null;
            currentToolName = null;

            // Detect escalation (now JSON: { action: "ESCALATE", reason: "..." })
            if (toolName === "escalate") {
              timings.escalateRequested = true;
            }

            // Detect completion page from scan_page_for_code (now JSON with status field)
            if (toolName === "scan_page_for_code") {
              try {
                const parsedOutput = typeof output === "object" ? output : JSON.parse(outputStr);
                if (parsedOutput?.status === "COMPLETED") {
                  timings.lastEnterCodeUrl = "completion";
                }
              } catch {
                if (outputStr.includes("COMPLETED")) {
                  timings.lastEnterCodeUrl = "completion";
                }
              }
            }

            // Capture URL from enter_code output (now JSON with newUrl field)
            let stepAdvanced2 = false;
            if (toolName === "enter_code") {
              try {
                const parsedOutput = typeof output === "object" ? output : JSON.parse(outputStr);
                if (parsedOutput?.newUrl) {
                  const newUrl = parsedOutput.newUrl;
                  const newStep = getStepFromUrl(newUrl);
                  const currentStepFromUrl = getStepFromUrl(timings.lastEnterCodeUrl || "");
                  if (!currentStepFromUrl || (newStep && newStep > currentStepFromUrl)) {
                    timings.lastEnterCodeUrl = newUrl;
                    if (newStep && newStep > currentStep) {
                      stepAdvanced2 = true;
                    }
                  }
                }
              } catch {
                const urlMatch = outputStr.match(/\|\s*(https?:\/\/[^\s]+)/);
                if (urlMatch) {
                  const newUrl = urlMatch[1];
                  const newStep = getStepFromUrl(newUrl);
                  const currentStepFromUrl = getStepFromUrl(timings.lastEnterCodeUrl || "");
                  if (!currentStepFromUrl || (newStep && newStep > currentStepFromUrl)) {
                    timings.lastEnterCodeUrl = newUrl;
                    if (newStep && newStep > currentStep) {
                      stepAdvanced2 = true;
                    }
                  }
                }
              }
            }

            const isError = looksLikeErrorOutput(outputStr);
            const brief = briefToolSummary(toolName, outputStr);
            timings.toolRecords.push({
              name: toolName,
              durationMs: toolDuration,
              success: !isError,
              summary: brief,
            });

            const isDebug =
              (toolName === "page_evaluate_js" || toolName === "drag_and_drop") &&
              parsed.debugToolInputs;
            const outputDisplay = isDebug ? outputStr : formatToolOutput(toolName, outputStr);
            const durationStr2 = toolDuration >= 1000
              ? yellow(`${(toolDuration / 1000).toFixed(1)}s`)
              : green(`${(toolDuration / 1000).toFixed(1)}s`);
            process.stdout.write(
              `${cyan(`[${toolName}]`)} ${isError ? red("err") : green("done")} (${durationStr2}) ${dim(outputDisplay)}\n`,
            );
            lastToolEndedAt = Date.now();
            lastToolNameForGap = currentToolName || toolName;

            // Abort the stream immediately after enter_code advances the step.
            if (stepAdvanced2) {
              console.log(dim(`  Step advanced — ending chat to start fresh for next challenge`));
              abortController.abort();
            }
          } else if (chunkType === "thinking") {
            // Could log thinking segments here if desired
          } else if (chunkType === "RUN_ERROR") {
            const err = (chunk as any).error;
            const errorMsg = err?.message || (chunk as any).message || "unknown error";
            process.stdout.write(`\n${red("[error]")} ${errorMsg}\n`);
          } else if (chunkType === "error") {
            const errorMsg = (chunk as any).error || (chunk as any).message || "unknown error";
            process.stdout.write(`\n${red("[error]")} ${errorMsg}\n`);
          }
        }
      } finally {
        clearTimeout(timeoutHandle);
        clearInterval(heartbeatHandle);
      }
      // Capture final thinking gap (between last tool and stream end)
      if (lastToolEndedAt) {
        const finalGapMs = Date.now() - lastToolEndedAt;
        if (finalGapMs >= 300) {
          timings.thinkingRecords.push({ afterTool: lastToolNameForGap, durationMs: finalGapMs });
        }
      }

      const challengeTime = Date.now() - timings.challengeStart;
      const totalThinkingMs = timings.thinkingRecords.reduce((s, r) => s + r.durationMs, 0);

      // ---- Challenge Summary ----
      console.log("");
      console.log(bold(`  Challenge ${currentStep} Summary`));
      console.log(dim(`  ${"─".repeat(50)}`));
      console.log(
        `  ${bold("Total:")} ${bold((challengeTime / 1000).toFixed(1) + "s")}  │  ` +
          `${cyan("Tools:")} ${(timings.toolTimeMs / 1000).toFixed(1)}s (${timings.toolCalls} calls)  │  ` +
          `${magenta("Thinking:")} ${(totalThinkingMs / 1000).toFixed(1)}s`,
      );

      // Tool timeline — interleave thinking gaps and tool calls chronologically
      if (timings.toolRecords.length > 0) {
        console.log(dim(`  ${"─".repeat(50)}`));
        let thinkIdx = 0;
        for (let i = 0; i < timings.toolRecords.length; i++) {
          // Show thinking gap(s) that occurred before this tool call
          while (thinkIdx < timings.thinkingRecords.length && thinkIdx <= i) {
            const think = timings.thinkingRecords[thinkIdx];
            if (think.durationMs >= 300) {
              console.log(dim(`    ${magenta("⋯")} thinking ${(think.durationMs / 1000).toFixed(1)}s`));
            }
            thinkIdx++;
            break; // one thinking gap per tool
          }
          const rec = timings.toolRecords[i];
          const durStr = rec.durationMs >= 3000
            ? red(`${(rec.durationMs / 1000).toFixed(1)}s`)
            : rec.durationMs >= 1000
              ? yellow(`${(rec.durationMs / 1000).toFixed(1)}s`)
              : green(`${(rec.durationMs / 1000).toFixed(1)}s`);
          const statusIcon = rec.success ? green("✓") : red("✗");
          console.log(
            `    ${statusIcon} ${cyan(rec.name)} ${durStr} ${dim("→")} ${rec.summary}`,
          );
        }
        // Show any remaining thinking gaps (e.g. final gap after last tool)
        while (thinkIdx < timings.thinkingRecords.length) {
          const think = timings.thinkingRecords[thinkIdx];
          if (think.durationMs >= 300) {
            console.log(dim(`    ${magenta("⋯")} thinking ${(think.durationMs / 1000).toFixed(1)}s`));
          }
          thinkIdx++;
        }
      }
      console.log(dim(`  ${"─".repeat(50)}`));

      // Handle escalation
      if (timings.escalateRequested && !timings.lastEnterCodeUrl) {
        console.log(
          yellow(`  Escalate requested — will retry with stronger model`),
        );
        attemptForStep++;
        if (attemptForStep >= MAX_ATTEMPTS) {
          console.log(
            red(`  All ${MAX_ATTEMPTS} models failed on step ${currentStep}. Skipping.`),
          );
          challengeResults.push({
            step: currentStep,
            timeMs: challengeTime,
            tools: timings.toolCalls,
            success: false,
            model: model.modelID,
          });
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

        // --only / --step: exit after solving the targeted step
        if (parsed.only) {
          break;
        }
      } else if (afterStep && afterStep < currentStep) {
        // Browser regressed
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
      } else {
        // Failed to advance
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

  await closeBrowser();
  console.log("\nDone. Browser closed. Exiting.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  closeBrowser().catch(() => {});
});
