/**
 * Agent Orchestrator — Ported to pi SDK
 *
 * Architecture:
 * - Tools own the browser (Playwright runs in-process via pi's tool system)
 * - agent.ts orchestrates via pi's createAgentSession + tool calls
 * - First challenge: scan_page_for_code gets url param to navigate + click START
 * - Subsequent challenges: page is already on the right step
 * - URL verification via shared state (in-process communication)
 * - New session per challenge attempt (context isolation)
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
import { getModel } from "@mariozechner/pi-ai"
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent"
import {
  scanPageForCodeTool,
  enterCodeTool,
  getUrlTool,
  escalateTool,
  evaluateJsTool,
  multiActionTool,
  sharedState,
} from "./tools/index.js"

// ---- CLI argument parsing ----
function parseArgs(argv: string[]): {
  url: string;
  provider: string;
  model: string;
  step: number | null;
  version: string;
  versionProvided: boolean;
} {
  const args = argv.slice(2); // skip node + script
  let url = "";
  let provider = "anthropic";
  let model = "claude-sonnet-4-5";
  let step: number | null = null;
  let version = "2";
  let versionProvided = false;

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
  };
}

const parsed = parseArgs(process.argv);
let CHALLENGE_URL = parsed.url;
const MAX_CHALLENGES = 35;
const TARGET_STEP = parsed.step;

// Model escalation: haiku → opus (2 attempts max)
const MODEL_LADDER = [
  { provider: "anthropic", model: "claude-haiku-4-5" },
  { provider: "anthropic", model: "claude-opus-4-5" },
];

function getModelForAttempt(attempt: number) {
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
- Do ONE interaction (page_multi_action or page_evaluate_js) then call scan_page_for_code again (with noAuto=true)`;

const ESCALATION_SECTION = `
## ESCALATE IMMEDIATELY for these challenge types (right after scan_page_for_code):
Call the escalate tool as your VERY NEXT action after scan_page_for_code if the page contains ANY of these:
- "drag" / "drop" / "draggable" / "slots" → escalate("drag-and-drop challenge")
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
→ Use page_evaluate_js to fast-forward or wait: await new Promise(r => setTimeout(r, <ms>))`;

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

### Drag and drop
If the page mentions "drag" and has draggable pieces/slots:
→ Use page_evaluate_js to solve it programmatically. Preferred strategy:
  1. Find React internals first. If the draggable pieces or slots have React props (e.g. __reactProps$*), call their handlers directly (onDragStart/onDragOver/onDrop) to move pieces.
  2. If React handlers are not available, fall back to standard drag events:
     dragstart on piece → dragover on zone → drop on zone → dragend on piece
     Use DataTransfer objects: new DataTransfer() with setData/getData
  3. If standard events still don't work, retry React fiber state manipulation to mark the puzzle complete.
→ Then call scan_page_for_code with noAuto=true to find the revealed code.

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
scan_page_for_code, enter_code, get_url, escalate, page_evaluate_js, page_multi_action

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
scan_page_for_code, enter_code, get_url, page_evaluate_js, page_multi_action

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

// Tool sets — haiku gets escalate, opus does not
const TOOLS_WITH_ESCALATE = [
  scanPageForCodeTool,
  enterCodeTool,
  getUrlTool,
  escalateTool,
  evaluateJsTool,
  multiActionTool,
];

const TOOLS_WITHOUT_ESCALATE = [
  scanPageForCodeTool,
  enterCodeTool,
  getUrlTool,
  evaluateJsTool,
  multiActionTool,
];

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

// ---- Timing & Observability ----
interface ThinkingSegment {
  phase: string;
  durationMs: number;
  afterToolOutput?: string;
}

interface ChallengeTimings {
  challengeStart: number;
  toolCalls: number;
  toolTimeMs: number;
  lastEventTime: number;
  currentToolStart: number | null;
  thinkingSegments: ThinkingSegment[];
  lastCompletedTool: string | null;
  lastToolOutput: string | null;
  seenFirstTool: boolean;
}

function newTimings(): ChallengeTimings {
  const now = Date.now();
  return {
    challengeStart: now,
    toolCalls: 0,
    toolTimeMs: 0,
    lastEventTime: now,
    currentToolStart: null,
    thinkingSegments: [],
    lastCompletedTool: null,
    lastToolOutput: null,
    seenFirstTool: false,
  };
}

/** Extract step number from URL like /step5?version=2 */
function getStepFromUrl(url: string): number | null {
  const match = url.match(/\/step(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function main() {
  const totalStart = Date.now();
  console.log(bold("=== Adcock Challenge Agent (pi) ==="));
  console.log(`Challenge URL: ${CHALLENGE_URL}`);
  console.log(
    `Model ladder: ${MODEL_LADDER.map((m) => m.model).join(" → ")}`,
  );
  console.log(`Headed: ${process.env.HEADED === "true" ? "yes" : "no"}`);
  console.log("");

  // ---- Set up pi auth and model registry ----
  const authStorage = new AuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);

  // Timing state
  let timings = newTimings();

  // ---- Main challenge loop (URL-driven) ----
  let lastKnownStep = TARGET_STEP || 1;
  let attemptForStep = 0;
  let isFirstChallenge = true;
  let totalRegressions = 0;

  // If a target step is specified, update the URL
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
    sharedState.reset();
    const currentStep = lastKnownStep;
    const modelConfig = getModelForAttempt(attemptForStep);

    if (attemptForStep === 0) {
      console.log(
        bold(`\n${"=".repeat(20)} Challenge ${currentStep} ${"=".repeat(20)}`),
      );
    } else {
      console.log(
        yellow(
          `\n  Attempt ${attemptForStep + 1}/${MAX_ATTEMPTS} — escalating to ${bold(modelConfig.model)}`,
        ),
      );
    }

    let abortedForEscalate = false;

    try {
      // Resolve the model
      const piModel = getModel(modelConfig.provider as any, modelConfig.model as any);
      if (!piModel) {
        console.log(red(`  Model not found: ${modelConfig.provider}/${modelConfig.model}`));
        attemptForStep++;
        if (attemptForStep >= MAX_ATTEMPTS) {
          attemptForStep = 0;
          lastKnownStep = currentStep + 1;
        }
        continue;
      }

      // Build instruction
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
      const isOpus = modelConfig.model === MODEL_LADDER[MODEL_LADDER.length - 1].model;
      const systemPrompt = isOpus ? SYSTEM_PROMPT_OPUS : SYSTEM_PROMPT_HAIKU;
      const tools = isOpus ? TOOLS_WITHOUT_ESCALATE : TOOLS_WITH_ESCALATE;

      // Create a fresh pi session for this challenge attempt
      const loader = new DefaultResourceLoader({
        systemPromptOverride: () => systemPrompt,
      });
      await loader.reload();

      const { session } = await createAgentSession({
        model: piModel,
        thinkingLevel: "off",
        tools: [],           // No default coding tools
        customTools: tools,   // Only our browser tools
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 3 },
        }),
        authStorage,
        modelRegistry,
      });

      // Subscribe to events for monitoring
      const unsubscribe = session.subscribe((event: any) => {
        const now = Date.now();

        switch (event.type) {
          case "message_update": {
            const assistantEvent = event.assistantMessageEvent;
            if (!assistantEvent) break;

            // Track thinking gaps
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
                dim(`  [thinking ${(gap / 1000).toFixed(1)}s] ${dim(`(${phase})`)}\n`),
              );
            }
            timings.lastEventTime = now;

            if (assistantEvent.type === "text_delta") {
              process.stdout.write(assistantEvent.delta || "");
            }
            break;
          }

          case "tool_execution_start": {
            const toolName = event.toolName || "?";
            timings.currentToolStart = now;
            timings.toolCalls++;
            timings.seenFirstTool = true;
            timings.lastEventTime = now;

            const inputStr = event.input ? truncate(JSON.stringify(event.input), 100) : "";
            process.stdout.write(
              `\n${cyan(`[${toolName}]`)} ${dim("calling")}${inputStr ? " " + dim(inputStr) : ""}\n`,
            );
            break;
          }

          case "tool_execution_end": {
            const toolName = event.toolName || "?";
            const toolDuration = timings.currentToolStart
              ? now - timings.currentToolStart
              : 0;
            timings.toolTimeMs += toolDuration;
            timings.currentToolStart = null;
            timings.lastEventTime = now;

            // Extract output text
            let outputStr = "";
            if (event.result) {
              if (typeof event.result === "string") {
                outputStr = event.result;
              } else if (event.result.content) {
                outputStr = event.result.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n");
              } else {
                outputStr = JSON.stringify(event.result);
              }
            }

            timings.lastCompletedTool = toolName;
            timings.lastToolOutput = outputStr;

            const status = event.isError ? red("error") : green("done");
            process.stdout.write(
              `${cyan(`[${toolName}]`)} ${status} ${dim(`(${(toolDuration / 1000).toFixed(1)}s)`)} ${dim(truncate(outputStr, 150))}\n`,
            );

            // Check for escalation (via shared state, since tools run in-process)
            if (sharedState.escalateRequested && !isOpus && !sharedState.lastEnterCodeUrl) {
              abortedForEscalate = true;
              console.log(
                yellow(`\n  Escalate requested — aborting ${modelConfig.model}, escalating to opus`),
              );
              session.abort().catch(() => {});
            }
            break;
          }
        }
      });

      // Run the prompt
      await session.prompt(instruction);

      // Cleanup
      unsubscribe();
      session.dispose();

      // If aborted for escalation, skip to opus
      if (abortedForEscalate) {
        attemptForStep = 1;
        continue;
      }

      const challengeTime = Date.now() - timings.challengeStart;
      const thinkingTime = challengeTime - timings.toolTimeMs;

      // Print timing summary
      console.log(
        magenta(
          `\n  Timing: ${(challengeTime / 1000).toFixed(1)}s total | ` +
            `${(timings.toolTimeMs / 1000).toFixed(1)}s tools (${timings.toolCalls} calls) | ` +
            `${(thinkingTime / 1000).toFixed(1)}s model thinking` +
            ` | ${modelConfig.model}`,
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

      // ---- Determine outcome from shared state (source of truth) ----
      const afterUrl = sharedState.lastEnterCodeUrl || "";
      const afterStep = afterUrl ? getStepFromUrl(afterUrl) : null;

      if (afterUrl) {
        console.log(dim(`  Page URL: ${afterUrl}`));
      }

      // Check for completion page
      if (
        sharedState.completionDetected ||
        afterUrl.includes("congratulations") ||
        afterUrl.includes("complete")
      ) {
        console.log(green("\n=== All challenges completed! ==="));
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: true,
          model: modelConfig.model,
        });
        break;
      }

      if (afterStep && afterStep > currentStep) {
        // Success — page advanced
        console.log(
          green(
            `  Step ${currentStep} solved! Page now on step ${afterStep}${attemptForStep > 0 ? ` (needed ${modelConfig.model})` : ""}`,
          ),
        );
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: true,
          model: modelConfig.model,
        });
        lastKnownStep = afterStep;
        attemptForStep = 0;
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
            yellow(`  Still on step ${currentStep} — ${modelConfig.model} failed`),
          );
        }
        challengeResults.push({
          step: currentStep,
          timeMs: challengeTime,
          tools: timings.toolCalls,
          success: false,
          model: modelConfig.model,
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
      // If we aborted for escalation, handle gracefully
      if (
        abortedForEscalate ||
        (sharedState.escalateRequested &&
          attemptForStep === 0 &&
          !sharedState.lastEnterCodeUrl)
      ) {
        console.log(yellow(`  Aborted ${modelConfig.model} — escalating to opus`));
        attemptForStep = 1;
        continue;
      }

      const challengeTime = Date.now() - timings.challengeStart;
      const errorModel = getModelForAttempt(attemptForStep);
      console.error(
        red(
          `  Error on step ${currentStep} (${errorModel.model}): ${err.message}`,
        ),
      );
      challengeResults.push({
        step: currentStep,
        timeMs: challengeTime,
        tools: timings.toolCalls,
        success: false,
        model: errorModel.model,
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
    `Model ladder: ${MODEL_LADDER.map((m) => m.model).join(" → ")}`,
  );

  const stepsAttempted = new Set(challengeResults.map((r) => r.step)).size;
  const successes = challengeResults.filter((r) => r.success).length;
  const escalations = challengeResults.filter(
    (r) => r.success && r.model !== MODEL_LADDER[0].model,
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
