# Agent Architecture Notes

## Tool Return Values MUST Be Valid JSON Strings

**All tool `.server()` handlers must return `JSON.stringify({...})` — never plain strings.**

The TanStack AI SDK's `executeToolCalls` function (in `@tanstack/ai/src/activities/chat/tools/tool-calls.ts`)
calls `JSON.parse(result)` on every string result returned by a tool:

```ts
result: typeof result === 'string' ? JSON.parse(result) : result || null,
```

If a tool returns a plain string like `"Clicked: #foo"` or `"URL: https://..."`, `JSON.parse`
throws `SyntaxError: JSON Parse error: Unexpected identifier`. The error is caught and silently
replaced with `{ error: "JSON Parse error: ..." }`, which means the **actual tool output is lost**
and the LLM sees an error instead of the real result.

### Correct pattern

```ts
export const myTool = myToolDef.server(async (args) => {
  // GOOD: always return JSON.stringify
  return JSON.stringify({ result: "some value" })
  return JSON.stringify({ error: "something went wrong" })
  return JSON.stringify({ url: "https://...", title: "Page Title" })
})
```

### Incorrect pattern

```ts
export const myTool = myToolDef.server(async (args) => {
  // BAD: plain strings will fail JSON.parse in the SDK
  return "Clicked: #foo"
  return `Error: ${e.message}`
  return `OK: "${code}" | ${url}`
})
```

### Conventions used in this codebase

- Success with text: `JSON.stringify({ result: "..." })` or `JSON.stringify({ output: "..." })`
- Structured success: `JSON.stringify({ url: "...", title: "...", status: "OK" })`
- Errors: `JSON.stringify({ error: "description" })`
- The `agent.ts` orchestrator uses `extractOutputText()` to pull readable text from these JSON
  results for logging and state tracking.

## Authentication: OpenCode OAuth Adapter

The agent supports two authentication methods for Anthropic (tried in order):

1. **OpenCode OAuth** (`auth/opencode-auth.ts` + `auth/opencode-adapter.ts`)
   - Reads credentials from `~/.local/share/opencode/auth.json`
   - Supports both `type: "api"` (API key) and `type: "oauth"` (Bearer token)
   - Auto-refreshes expired OAuth tokens via `POST https://console.anthropic.com/v1/oauth/token`
   - Uses a custom `fetch` wrapper (not just SDK headers) because Anthropic's server requires:
     - `Authorization: Bearer <token>` (instead of `x-api-key`)
     - `anthropic-beta: oauth-2025-04-20,interleaved-thinking-2025-05-14`
     - `user-agent: claude-cli/2.1.2 (external, cli)`
     - System prompt as an **array** with the first element being exactly:
       `"You are Claude Code, Anthropic's official CLI for Claude."`
     - Removal of `x-api-key` and `x-stainless-*` headers
     - `?beta=true` appended to `/v1/messages` URL

2. **`ANTHROPIC_API_KEY` env var** — Falls back to the standard `anthropicText()` adapter.
