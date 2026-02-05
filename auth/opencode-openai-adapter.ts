import path from "node:path"
import os from "node:os"
import { promises as fs } from "node:fs"
import { createOpenaiChat } from "@tanstack/ai-openai"

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com"
const OPENAI_OAUTH_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/oauth/token`
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const REFRESH_BUFFER_MS = 5 * 60 * 1000
const SESSION_ID = crypto.randomUUID()

type ApiAuth = { type: "api"; key: string }
type OAuthAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
}
export type OpenAIAuthInfo = ApiAuth | OAuthAuth

interface AuthJson {
  [provider: string]: OpenAIAuthInfo
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

let cachedAuth: OAuthAuth | null = null

async function getOrRefreshOAuth(): Promise<OAuthAuth> {
  if (!cachedAuth) {
    const allAuth = await readAuthJson()
    const auth = allAuth["openai"]
    if (!auth || auth.type !== "oauth") {
      throw new Error("Expected OpenAI OAuth auth in auth.json")
    }
    cachedAuth = auth
  }

  if (!cachedAuth.access || cachedAuth.expires < Date.now() + REFRESH_BUFFER_MS) {
    const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cachedAuth.refresh,
        client_id: OPENAI_OAUTH_CLIENT_ID,
      }).toString(),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`OpenAI OAuth token refresh failed: ${response.status} ${body}`)
    }

    const json = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in?: number
      id_token?: string
    }

    cachedAuth = {
      type: "oauth",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + (json.expires_in ?? 3600) * 1000,
      accountId: cachedAuth.accountId,
    }

    const allAuth = await readAuthJson()
    allAuth["openai"] = cachedAuth
    await writeAuthJson(allAuth)
  }

  return cachedAuth
}

export async function loadOpenAIAuth(): Promise<OpenAIAuthInfo> {
  const allAuth = await readAuthJson()
  let auth = allAuth["openai"]
  if (!auth) {
    throw new Error("No openai credentials in OpenCode auth.json")
  }

  if (auth.type === "oauth") {
    cachedAuth = auth
    const needsRefresh = !auth.access || auth.expires < Date.now() + REFRESH_BUFFER_MS
    if (needsRefresh) {
      auth = await getOrRefreshOAuth()
    }
  }

  return auth
}

async function openAIOAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const debug = process.env.DEBUG_CODEX_FETCH === "1"
  const auth = await getOrRefreshOAuth()
  const headers = new Headers()

  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => headers.set(key, value))
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        if (value !== undefined) headers.set(key, String(value))
      }
    } else {
      for (const [key, value] of Object.entries(init.headers)) {
        if (value !== undefined) headers.set(key, String(value))
      }
    }
  }

  headers.delete("authorization")
  headers.delete("Authorization")
  headers.delete("x-api-key")
  headers.set("authorization", `Bearer ${auth.access}`)
  headers.set("originator", "opencode")
  headers.set("User-Agent", "opencode/standalone")
  headers.set("session_id", SESSION_ID)
  if (auth.accountId) {
    headers.set("ChatGPT-Account-Id", auth.accountId)
  }

  const parsed =
    input instanceof URL
      ? input
      : new URL(typeof input === "string" ? input : input.url)

  const url =
    parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
      ? new URL(CODEX_API_ENDPOINT)
      : parsed

  let body = init?.body
  if (url.toString() === CODEX_API_ENDPOINT && typeof body === "string") {
    try {
      const parsedBody = JSON.parse(body) as Record<string, any>
      // Codex backend requires `instructions` to be present.
      // TanStack/OpenAI adapter sometimes omits it.
      if (!parsedBody.instructions || String(parsedBody.instructions).trim() === "") {
        parsedBody.instructions = "You are a helpful assistant."
      }
      // Codex backend requires explicit store=false
      parsedBody.store = false
      // Codex backend requires streaming mode
      parsedBody.stream = true
      // Codex backend requires input to be a list
      if (parsedBody.input !== undefined && !Array.isArray(parsedBody.input)) {
        parsedBody.input = [parsedBody.input]
      }
      body = JSON.stringify(parsedBody)
      if (debug) {
        console.log("[codex fetch] body keys:", Object.keys(parsedBody).join(", "))
      }
    } catch {
      // keep original body
    }
  }

  const response = await fetch(url, {
    ...init,
    body,
    headers,
  })

  if (debug || !response.ok) {
    const text = await response.clone().text().catch(() => "")
    console.log(`[codex fetch] ${response.status} ${url.toString()}`)
    if (text) console.log("[codex fetch] response:", text.slice(0, 400))
  }

  return response
}

export async function createOpenCodeOpenAIAdapter(model: string) {
  const auth = await loadOpenAIAuth()

  if (auth.type === "api") {
    return createOpenaiChat(model as any, auth.key)
  }

  return createOpenaiChat(model as any, "oauth-dummy-key", {
    fetch: openAIOAuthFetch as any,
  })
}
