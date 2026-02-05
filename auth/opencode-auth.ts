/**
 * OpenCode OAuth credential loader for Anthropic.
 *
 * Reads tokens from OpenCode's auth.json, auto-refreshes when expired,
 * and provides a configured Anthropic SDK client using a custom fetch wrapper
 * that mirrors the opencode-anthropic-auth plugin's behavior:
 *   - Sets Authorization: Bearer header
 *   - Adds required anthropic-beta flags
 *   - Sets claude-cli user-agent
 *   - Appends ?beta=true to /v1/messages
 *   - Removes x-api-key header
 *
 * Supports both credential types stored by OpenCode:
 *   - type: "api"   → uses x-api-key header (standard path)
 *   - type: "oauth"  → uses custom fetch wrapper with Bearer auth
 */
import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import Anthropic_SDK from "@anthropic-ai/sdk"

// Same client_id that opencode-anthropic-auth@0.0.13 uses
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"

// Refresh 5 minutes before expiry to avoid race conditions
const REFRESH_BUFFER_MS = 5 * 60 * 1000

const REQUIRED_BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
]

type ApiAuth = { type: "api"; key: string }
type OAuthAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
}
export type AuthInfo = ApiAuth | OAuthAuth

interface AuthJson {
  [provider: string]: AuthInfo
}

function opencodeAuthPath(): string {
  return (
    process.env.OPENCODE_AUTH_PATH ??
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
  )
}

async function readAuthJson(): Promise<AuthJson> {
  const raw = await fs.readFile(opencodeAuthPath(), "utf8")
  return JSON.parse(raw) as AuthJson
}

async function writeAuthJson(data: AuthJson): Promise<void> {
  await fs.writeFile(opencodeAuthPath(), JSON.stringify(data, null, 2), {
    mode: 0o600,
  })
}

/** In-memory cache so we don't re-read auth.json on every fetch call */
let cachedAuth: OAuthAuth | null = null

async function getOrRefreshOAuth(): Promise<OAuthAuth> {
  if (!cachedAuth) {
    const allAuth = await readAuthJson()
    const auth = allAuth["anthropic"]
    if (!auth || auth.type !== "oauth") {
      throw new Error("Expected OAuth auth in auth.json")
    }
    cachedAuth = auth
  }

  // Refresh if expired or near-expiry
  if (!cachedAuth.access || cachedAuth.expires < Date.now() + REFRESH_BUFFER_MS) {
    console.log("  Refreshing Anthropic OAuth token...")
    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: cachedAuth.refresh,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`OAuth token refresh failed: ${response.status} ${body}`)
    }

    const json = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }

    cachedAuth = {
      type: "oauth",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      accountId: cachedAuth.accountId,
    }

    // Persist refreshed tokens
    const allAuth = await readAuthJson()
    allAuth["anthropic"] = cachedAuth
    await writeAuthJson(allAuth)

    console.log(
      `  Token refreshed. Expires: ${new Date(cachedAuth.expires).toLocaleTimeString()}`,
    )
  }

  return cachedAuth
}

/**
 * Load Anthropic credentials from OpenCode's auth.json.
 * If OAuth and expired/near-expiry, auto-refreshes the token.
 */
export async function loadAnthropicAuth(): Promise<AuthInfo> {
  const allAuth = await readAuthJson()
  let auth = allAuth["anthropic"]
  if (!auth) {
    throw new Error(
      "No anthropic credentials in OpenCode auth.json. Run `opencode` and connect your Anthropic account first.",
    )
  }

  if (auth.type === "oauth") {
    cachedAuth = auth
    const needsRefresh =
      !auth.access || auth.expires < Date.now() + REFRESH_BUFFER_MS
    if (needsRefresh) {
      auth = await getOrRefreshOAuth()
    }
  }

  return auth
}

/**
 * Custom fetch wrapper for OAuth that mirrors opencode-anthropic-auth@0.0.13.
 *
 * Transformations applied:
 *   1. Refreshes token if expired
 *   2. Sets Authorization: Bearer header
 *   3. Merges required anthropic-beta flags
 *   4. Sets claude-cli user-agent
 *   5. Removes x-api-key header
 *   6. Appends ?beta=true to /v1/messages URL
 */
async function oauthFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const auth = await getOrRefreshOAuth()

  const requestInit = init ?? {}

  // Build merged headers
  const requestHeaders = new Headers()
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value)
    })
  }
  if (requestInit.headers) {
    if (requestInit.headers instanceof Headers) {
      requestInit.headers.forEach((value, key) => {
        requestHeaders.set(key, value)
      })
    } else if (Array.isArray(requestInit.headers)) {
      for (const [key, value] of requestInit.headers) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value))
        }
      }
    } else {
      for (const [key, value] of Object.entries(requestInit.headers)) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value))
        }
      }
    }
  }

  // Merge beta headers
  const incomingBeta = requestHeaders.get("anthropic-beta") || ""
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean)
  const mergedBetas = [
    ...new Set([...REQUIRED_BETAS, ...incomingBetasList]),
  ].join(",")

  requestHeaders.set("authorization", `Bearer ${auth.access}`)
  requestHeaders.set("anthropic-beta", mergedBetas)
  requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)")
  requestHeaders.delete("x-api-key")

  // Remove SDK fingerprint headers that identify this as a non-Claude-Code client
  for (const key of [...requestHeaders.keys()]) {
    if (key.startsWith("x-stainless-")) {
      requestHeaders.delete(key)
    }
  }

  // Rewrite request body: ensure the Claude Code system prompt prefix is present
  // and map tool names to Claude Code-compatible MCP names.
  const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
  const TOOL_PREFIX = "mcp_"
  let body = requestInit.body
  if (body && typeof body === "string") {
    try {
      const parsed = JSON.parse(body)
      if (parsed.system && Array.isArray(parsed.system)) {
        // System is already an array of text blocks
        const hasPrefix = parsed.system.some(
          (item: any) => item.type === "text" && item.text?.startsWith(CLAUDE_CODE_PREFIX),
        )
        if (!hasPrefix) {
          parsed.system.unshift({ type: "text", text: CLAUDE_CODE_PREFIX })
        }
      } else if (typeof parsed.system === "string") {
        // Convert string to array: prefix block + original content block
        if (parsed.system.startsWith(CLAUDE_CODE_PREFIX)) {
          // Already prefixed as string — convert to array form
          const rest = parsed.system.slice(CLAUDE_CODE_PREFIX.length).replace(/^\n+/, "")
          parsed.system = [{ type: "text", text: CLAUDE_CODE_PREFIX }]
          if (rest) parsed.system.push({ type: "text", text: rest })
        } else {
          parsed.system = [
            { type: "text", text: CLAUDE_CODE_PREFIX },
            { type: "text", text: parsed.system },
          ]
        }
      } else if (!parsed.system) {
        parsed.system = [{ type: "text", text: CLAUDE_CODE_PREFIX }]
      }

      // Add prefix to tool definitions
      if (parsed.tools && Array.isArray(parsed.tools)) {
        parsed.tools = parsed.tools.map((tool: any) => ({
          ...tool,
          name: tool?.name ? `${TOOL_PREFIX}${tool.name}` : tool?.name,
        }))
      }

      // Add prefix to tool_use blocks in outbound messages
      if (parsed.messages && Array.isArray(parsed.messages)) {
        parsed.messages = parsed.messages.map((msg: any) => {
          if (msg?.content && Array.isArray(msg.content)) {
            msg.content = msg.content.map((block: any) => {
              if (block?.type === "tool_use" && block?.name) {
                return {
                  ...block,
                  name: `${TOOL_PREFIX}${block.name}`,
                }
              }
              return block
            })
          }
          return msg
        })
      }

      body = JSON.stringify(parsed)
    } catch {
      // ignore parse errors
    }
  }

  // Append ?beta=true to /v1/messages URL
  let requestInput: RequestInfo | URL = input
  try {
    let requestUrl: URL | null = null
    if (typeof input === "string" || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
    if (
      requestUrl &&
      requestUrl.pathname === "/v1/messages" &&
      !requestUrl.searchParams.has("beta")
    ) {
      requestUrl.searchParams.set("beta", "true")
      requestInput =
        input instanceof Request
          ? new Request(requestUrl.toString(), input)
          : requestUrl
    }
  } catch {
    // URL parsing failed — pass through as-is
  }

  const response = await fetch(requestInput, {
    ...requestInit,
    body,
    headers: requestHeaders,
  })

  // Transform streaming response to rename MCP-prefixed tool names back
  // to the local tool names expected by TanStack AI.
  if (response.body) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }

        let text = decoder.decode(value, { stream: true })
        text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
        controller.enqueue(encoder.encode(text))
      },
    })

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  return response
}

/**
 * Create an Anthropic SDK client configured for the stored credential type.
 * - API key: uses x-api-key header (standard)
 * - OAuth: uses custom fetch wrapper matching opencode-anthropic-auth behavior
 */
export async function createAnthropicClientFromOpenCode(): Promise<Anthropic_SDK> {
  const auth = await loadAnthropicAuth()

  if (auth.type === "api") {
    return new Anthropic_SDK({ apiKey: auth.key })
  }

  // OAuth: use a custom fetch wrapper that handles all the header/URL
  // transformations that Anthropic's server requires for OAuth credentials.
  // The apiKey is set to a placeholder since the fetch wrapper handles auth.
  return new Anthropic_SDK({
    apiKey: "oauth-handled-by-fetch-wrapper",
    fetch: oauthFetch as any,
  })
}
