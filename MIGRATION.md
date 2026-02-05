# OpenCode SDK Ejection & Architecture Migration

## Agent Instructions

### How to pick up tasks
1. Read this file to find tasks with status `[ ]` (not started) or `[~]` (in progress)
2. Tasks within the same **Phase** can be worked on in parallel unless they have explicit dependencies noted
3. Tasks across phases are sequential — complete all tasks in Phase N before starting Phase N+1
4. When picking up a task, change its status to `[~]` and note which agent is working on it
5. When completing a task, change its status to `[x]` and note any follow-up issues discovered

### Status legend
- `[ ]` — Not started
- `[~]` — In progress
- `[x]` — Complete
- `[-]` — Cancelled / not needed

### Parallelism rules
- **Within a phase**: All tasks at the same indent level can be parallelized unless marked with `DEPENDS ON: <task-id>`
- **Across phases**: Strictly sequential (Phase 1 must complete before Phase 2 starts)
- **Sub-tasks**: Sub-tasks within a single task are sequential (top to bottom)

### Before starting any task
1. Read the relevant source files listed in the task
2. Check if any other tasks have been completed that affect your task
3. Run `git status` to check for uncommitted changes from other agents

### After completing any task
1. Update this file with status `[x]`
2. Note any issues, decisions, or follow-up tasks discovered
3. Run type-check (`npx tsc --noEmit`) on any modified files
4. Commit your changes with a descriptive message

---

## Current Architecture (What We're Replacing)

```
agent.ts (Node/tsx) ──SSE──> OpenCode Server ──dispatch──> Bun Plugin Runtime ──> Playwright
     │                            │                              │
     │ parses string output       │ manages sessions             │ tools defined via
     │ via regex                  │ routes tool calls             │ @opencode-ai/plugin tool()
     │                            │ event streaming               │
     └────────────────────────────┴──────────────────────────────┘
```

### Problems with current architecture
- Extra process boundary adds latency on every tool call
- Orchestrator can't access Playwright directly (URL checking, screenshots, conditional waits)
- Tool outputs are untyped strings parsed with regex — fragile
- 42 instances of `any` because OpenCode SDK events aren't typed
- OpenCode's session management adds overhead we don't need (fresh session per challenge)
- `.opencode/` plugin directory, `opencode.json`, and Bun dependency exist solely for this SDK

## Target Architecture

```
agent.ts (Node/tsx)
     │
     ├── src/anthropic.ts        — Direct Claude API wrapper (messages.create with tools)
     ├── src/tools/index.ts      — Tool registry: name → handler mapping + Anthropic tool definitions
     ├── src/tools/types.ts      — Shared types (ToolResult<T>, ToolContext, etc.)
     ├── src/tools/browser.ts    — Playwright singleton (migrated from .opencode/tools/browser.ts)
     ├── src/tools/scan.ts       — scan_page_for_code (migrated, returns typed object)
     ├── src/tools/enter-code.ts — enter_code (migrated, returns typed object)
     ├── src/tools/page.ts       — page_evaluate_js, page_multi_action, etc. (migrated)
     ├── src/tools/drag-drop.ts  — drag_and_drop (migrated)
     ├── src/tools/dismiss.ts    — dismissPopups helper (migrated)
     ├── src/prompts.ts          — System prompts (extracted from agent.ts)
     ├── src/cli.ts              — CLI argument parsing (extracted from agent.ts)
     └── src/logging.ts          — ANSI helpers + timing (extracted from agent.ts)
```

### Key design changes
- **No IPC**: Orchestrator calls tool functions directly in the same process
- **Typed tool protocol**: Tools return `ToolResult<T>` objects, not strings
- **Direct Playwright access**: Orchestrator can call `page.url()`, take screenshots, use `waitForURL()`
- **Anthropic SDK**: Use `@anthropic-ai/sdk` with `messages.create()` + tool_use blocks
- **Single process**: Everything runs in one Node.js process via tsx

---

## Phase 0: Preparation

### P0-1: Install new dependencies, keep old ones temporarily
- `[ ]` **Add `@anthropic-ai/sdk`** to package.json
- `[ ]` **Add `zod`** for tool schema validation (optional, decide during planning)
- Files: `package.json`
- Notes: Don't remove OpenCode deps yet — old code should still work until migration is complete

### P0-2: Create directory structure
- `[ ]` Create `src/` directory and empty placeholder files per target architecture
- `[ ]` Create `src/tools/` subdirectory
- Files: new `src/` tree

---

## Phase 1: Type Foundation & Tool Migration (Parallelizable)

All tasks in this phase can be worked in parallel. They share only the type definitions from P1-1.

### P1-1: Define shared types and tool registry interface
- `[ ]` Create `src/tools/types.ts` with:
  - `ToolResult<T>` — generic typed return from tools: `{ success: boolean; data: T; error?: string }`
  - `ScanResult` — typed return from scan_page_for_code: `{ url, title, codes, autoActions, markdown, bodyText, isCompletion }`
  - `EnterCodeResult` — typed return from enter_code: `{ success, beforeUrl, afterUrl, urlChanged, feedback }`
  - `PageActionResult` — typed return from page tools
  - `DragDropResult` — typed return from drag_and_drop
  - `ToolContext` — shared context passed to all tools: `{ page: Page }` (Playwright Page type, not `any`)
- `[ ]` Create `src/tools/index.ts` with:
  - Tool name → handler mapping type
  - Anthropic tool definition array (the JSON schema objects sent to the API)
  - `executeTool(name, args, context)` dispatch function
- Source files to reference:
  - `.opencode/tools/scan_page_for_code.ts` (lines 307-327 for current schema)
  - `.opencode/tools/enter_code.ts` (lines 11-23 for current schema)
  - `.opencode/tools/page.ts` (all tool definitions)
  - `.opencode/tools/drag_and_drop.ts` (lines 27-80 for current schema)
- Notes: The Anthropic tool format uses `input_schema` with JSON Schema, not Zod. See https://docs.anthropic.com/en/docs/build-with-claude/tool-use

### P1-2: Migrate browser singleton
- `[ ]` Create `src/tools/browser.ts` — migrate from `.opencode/tools/browser.ts`
- Changes from current:
  - Export typed `Page` (not `any`)
  - Keep singleton pattern (it works well)
  - Add `closeBrowser()` to actually get called (currently defined but never used)
  - Consider accepting config (headed, viewport) as params instead of env vars
- Source: `.opencode/tools/browser.ts` (68 lines)
- DEPENDS ON: P1-1 (for ToolContext type)

### P1-3: Migrate dismiss helper
- `[ ]` Create `src/tools/dismiss.ts` — migrate from `.opencode/tools/dismiss-helper.ts`
- Changes from current:
  - Accept `Page` type instead of `any`
  - Return count of dismissed items (already does this)
  - Add minimal logging for dismissed items (debug mode)
- Source: `.opencode/tools/dismiss-helper.ts`
- DEPENDS ON: P1-2 (for getPage)

### P1-4: Migrate scan_page_for_code
- `[ ]` Create `src/tools/scan.ts` — migrate from `.opencode/tools/scan_page_for_code.ts`
- Changes from current:
  - Return `ScanResult` object instead of formatted string
  - Accept `Page` type instead of `any`
  - Merge the two `querySelectorAll("*")` loops into one pass (perf fix)
  - The string formatting for LLM consumption moves to `src/tools/index.ts` (tool results are serialized to strings for the Anthropic API at the dispatch layer)
  - Remove `tool()` wrapper, export as plain async function
- Source: `.opencode/tools/scan_page_for_code.ts` (454 lines)
- DEPENDS ON: P1-1, P1-2, P1-3

### P1-5: Migrate enter_code
- `[ ]` Create `src/tools/enter-code.ts` — migrate from `.opencode/tools/enter_code.ts`
- Changes from current:
  - Return `EnterCodeResult` object instead of formatted string
  - Accept `Page` type instead of `any`
  - Reduce dismissPopups calls from 3 to 1 (with conditional retry)
  - Replace `waitForTimeout(800)` after submit with `waitForURL` or `waitForNavigation`
  - Remove `tool()` wrapper
- Source: `.opencode/tools/enter_code.ts` (153 lines)
- DEPENDS ON: P1-1, P1-2, P1-3

### P1-6: Migrate page interaction tools
- `[ ]` Create `src/tools/page.ts` — migrate from `.opencode/tools/page.ts`
- Changes from current:
  - Only migrate tools that are actually in the whitelist: `page_evaluate_js`, `page_multi_action`
  - The others (`click_element`, `press_key`, `scroll`, `select_option`, `check_checkbox`, `hover`, `get_page_html`) are dead code in the current architecture (not whitelisted in `agent.ts:92-108`). Decide: migrate or drop?
  - Return typed results
  - Remove `tool()` wrapper
- Source: `.opencode/tools/page.ts` (457 lines)
- DEPENDS ON: P1-1, P1-2
- Decision needed: Which page tools to keep? Currently only `page_evaluate_js` and `page_multi_action` are whitelisted.

### P1-7: Migrate drag_and_drop
- `[ ]` Create `src/tools/drag-drop.ts` — migrate from `.opencode/tools/drag_and_drop.ts`
- Changes from current:
  - Return `DragDropResult` object
  - Accept `Page` type
  - Remove `tool()` wrapper
  - Keep multi-strategy approach (react → dataTransfer → mouse → dragTo)
- Source: `.opencode/tools/drag_and_drop.ts` (394 lines)
- DEPENDS ON: P1-1, P1-2, P1-3

---

## Phase 2: Anthropic SDK Integration

### P2-1: Create Anthropic API wrapper
- `[ ]` Create `src/anthropic.ts` with:
  - `createClient()` — initialize Anthropic client from env `ANTHROPIC_API_KEY`
  - `runToolLoop(client, messages, tools, system)` — the core message loop:
    1. Call `client.messages.create()` with tools
    2. If response has `tool_use` blocks, execute each tool via `executeTool()`
    3. Append tool results as `tool_result` blocks
    4. Repeat until response has `end_turn` stop reason or budget exhausted
    5. Return structured result with all messages, tool calls made, and timing
  - Tool call budget enforcement (currently 15-20 calls, configurable)
  - Model selection (support the MODEL_LADDER concept)
- Reference: Anthropic tool use docs — https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- Notes:
  - The Anthropic SDK handles streaming natively — decide if streaming is needed for observability
  - Tool results in the Anthropic API are `{ type: "tool_result", tool_use_id, content }` where content is a string
  - The tool dispatch layer (`src/tools/index.ts`) should serialize typed `ToolResult<T>` objects to strings for the API

### P2-2: Extract prompts to module
- `[ ]` Create `src/prompts.ts` — extract from `agent.ts` lines 112-338
- Contains:
  - `PROMPT_HEADER`
  - `ESCALATION_SECTION`
  - `SHARED_PLAYBOOKS`
  - `ADVANCED_PLAYBOOKS`
  - `RULES_HAIKU` / `RULES_OPUS`
  - `SYSTEM_PROMPT_HAIKU` / `SYSTEM_PROMPT_OPUS`
  - `buildInstruction(isFirst, url, targetStep)` function
- Changes from current:
  - Update tool names if any changed
  - Update rules about available tools to match new tool registry
  - Remove references to OpenCode-specific behavior
- Source: `agent.ts` lines 112-338

### P2-3: Extract CLI parsing and logging
- `[ ]` Create `src/cli.ts` — extract from `agent.ts` lines 24-69
- `[ ]` Create `src/logging.ts` — extract from `agent.ts` lines 340-368 (ANSI helpers) and timing infrastructure (lines 392-433)
- Changes from current:
  - Remove `--provider` flag (dead code — model is always from MODEL_LADDER)
  - Remove `--model` flag (same reason) — or repurpose to override MODEL_LADDER
  - Keep `--step`, `--version`, `--debug-tool-inputs`, positional URL arg
  - Clean up ANSI helpers (consider a tiny lib like `kleur` or keep inline)
- Source: `agent.ts` lines 24-69 and 340-433

---

## Phase 3: New Orchestrator

### P3-1: Rewrite the main challenge loop
- `[ ]` Rewrite `agent.ts` to use new modules:
  - Import from `src/anthropic.ts`, `src/tools/index.ts`, `src/prompts.ts`, `src/cli.ts`, `src/logging.ts`
  - **Direct Playwright access**: After each tool loop completes, check `page.url()` directly instead of parsing tool output strings
  - **Conditional waits**: Use `page.waitForURL()` instead of comparing regex-parsed strings
  - **Screenshot on failure**: On failed challenge, take `page.screenshot()` for debugging
  - Remove OpenCode SDK imports entirely
  - Remove port allocation logic (no longer needed — no separate server)
  - Remove SSE event stream handling (observability moves to the tool dispatch layer or streaming)
  - Keep: challenge loop structure, model ladder, timing/summary reporting, regression detection
- Source: `agent.ts` (entire file — 1050 lines, target ~400 lines)
- DEPENDS ON: P2-1, P2-2, P2-3, and all Phase 1 tasks

### P3-2: Add observability to tool dispatch
- `[ ]` In `src/tools/index.ts` or `src/anthropic.ts`, add:
  - Tool call logging (name, input summary, duration, output summary) — replaces the SSE event handler
  - Thinking gap detection (time between tool calls) — replaces the thinking segment tracking
  - Token usage tracking (Anthropic API returns usage in response)
  - Optional streaming for real-time output (Anthropic SDK supports `stream: true`)
- Source: `agent.ts` lines 514-684 (current event loop — to be replaced, not ported)
- DEPENDS ON: P3-1

### P3-3: Add cleanup and signal handling
- `[ ]` Add `process.on("SIGINT")` and `process.on("SIGTERM")` handlers
  - Close Playwright browser via `closeBrowser()`
  - Print partial summary if interrupted mid-run
- `[ ]` Ensure browser cleanup on normal exit too
- DEPENDS ON: P3-1

---

## Phase 4: Cleanup & Validation

### P4-1: Remove OpenCode artifacts
- `[ ]` Delete `.opencode/` directory entirely
- `[ ]` Delete `opencode.json`
- `[ ]` Remove `@opencode-ai/sdk` and `@opencode-ai/plugin` from `package.json`
- `[ ]` Remove Bun lockfile (`.opencode/bun.lock`) if not already deleted with directory
- `[ ]` Run `npm install` to clean up node_modules
- DEPENDS ON: P3-1 (new orchestrator fully working)

### P4-2: Type-check and fix
- `[ ]` Run `npx tsc --noEmit` and fix all type errors
- `[ ]` Verify zero `any` types remain (target: 0, current: 42)
- `[ ]` Update `tsconfig.json` if needed (add `src/` to includes)
- DEPENDS ON: P4-1

### P4-3: End-to-end validation
- `[ ]` Run `npm run agent:headed -- --step 1` and verify step 1 solves
- `[ ]` Run `npm run agent:headed -- --step 5` and verify step 5 solves
- `[ ]` Run full 30-challenge sweep and compare timing to baseline
- `[ ]` Document baseline vs. new timing in this file
- DEPENDS ON: P4-2

### P4-4: Update package.json scripts
- `[ ]` Verify `npm run agent` and `npm run agent:headed` still work
- `[ ]` Remove any OpenCode-specific scripts if present
- `[ ]` Consider adding `npm run agent:debug` for verbose output
- DEPENDS ON: P4-1

---

## Phase 5: Performance Optimizations (Post-Migration)

These are follow-up improvements enabled by the new architecture.

### P5-1: Replace fixed waits with conditional waits
- `[ ]` Replace all `waitForTimeout()` calls with appropriate Playwright waits:
  - After navigation: `waitForURL()` or `waitForLoadState()`
  - After click: `waitForSelector()` on expected result
  - After scroll: `waitForFunction(() => window.scrollY >= target)`
  - After submit: `waitForURL()` to detect page change
- Files: `src/tools/scan.ts`, `src/tools/enter-code.ts`, `src/tools/page.ts`
- Expected savings: 2-4s per challenge

### P5-2: Direct URL verification in orchestrator
- `[ ]` After tool loop completes, call `page.url()` directly instead of parsing tool output
- `[ ]` Remove regex parsing of enter_code output for URL extraction
- Files: `agent.ts`

### P5-3: Screenshot on failure
- `[ ]` On failed challenge, take `page.screenshot({ path: 'debug/step-N-fail.png' })`
- `[ ]` Create `debug/` directory for failure artifacts
- Files: `agent.ts`

### P5-4: Merge redundant DOM iterations
- `[ ]` In `scanForCodes()`, merge the two `querySelectorAll("*")` loops into a single pass
- `[ ]` In `readPage()` + `scanForCodes()`, reduce from 4 browser round-trips to 2
- Files: `src/tools/scan.ts`

### P5-5: Anthropic prompt caching
- `[ ]` Enable prompt caching for system prompts (they're identical across challenges)
- `[ ]` The system prompt is ~4000 tokens — caching saves re-processing on every challenge
- Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- Files: `src/anthropic.ts`

### P5-6: Clean up dead tools
- `[ ]` Decide which page tools to keep vs. drop:
  - Currently whitelisted: `page_evaluate_js`, `page_multi_action`
  - Currently dead: `click_element`, `press_key`, `scroll`, `select_option`, `check_checkbox`, `hover`, `get_page_html`, `get_modal_buttons`, `get_url`, `escalate`
  - `get_url` and `escalate` may be revived if model ladder is restored
- Files: `src/tools/page.ts`, `src/tools/index.ts`

---

## Decisions Log

Track architectural decisions here as they're made during implementation.

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D1 | ? | Whether to use Zod for tool input validation or rely on Anthropic's schema enforcement | |
| D2 | ? | Whether to use streaming (`stream: true`) for real-time observability or batch responses | |
| D3 | ? | Which dead tools to keep (see P5-6) | |
| D4 | ? | Whether to keep model ladder / escalation system or simplify to single model | |
| D5 | ? | Whether to add prompt caching from day 1 or defer to Phase 5 | |

---

## Timing Baseline

Record before/after timing here during P4-3 validation.

| Metric | Before (OpenCode) | After (Direct) | Delta |
|--------|-------------------|-----------------|-------|
| Avg per step | TBD | TBD | |
| Total 30 steps | TBD | TBD | |
| Avg tool calls/step | TBD | TBD | |
| IPC overhead/step | TBD | N/A | |
