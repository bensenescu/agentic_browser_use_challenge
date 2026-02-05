/**
 * TanStack AI adapter for Anthropic using OpenCode OAuth credentials.
 *
 * Creates a standard AnthropicTextAdapter then replaces its internal SDK client
 * with one configured for Bearer token auth (from OpenCode's auth.json).
 *
 * Usage:
 *   const adapter = await createOpenCodeAnthropicAdapter("claude-opus-4-6")
 *   const stream = chat({ adapter, messages, tools, ... })
 */
import { createAnthropicChat } from "@tanstack/ai-anthropic"
import {
  loadAnthropicAuth,
  createAnthropicClientFromOpenCode,
} from "./opencode-auth"

/**
 * Create a TanStack AI Anthropic adapter backed by OpenCode credentials.
 *
 * For API key auth: works identically to the standard anthropicText() adapter.
 * For OAuth auth: replaces the SDK client with one using Authorization: Bearer.
 */
export async function createOpenCodeAnthropicAdapter(model: string) {
  const auth = await loadAnthropicAuth()

  if (auth.type === "api") {
    // Standard path — just pass the API key directly
    return createAnthropicChat(model as any, auth.key)
  }

  // OAuth path: create adapter with a placeholder key, then swap the client
  // The adapter constructor only uses apiKey to create the internal SDK client.
  // We replace that client with one configured for Bearer auth.
  const adapter = createAnthropicChat(model as any, "placeholder-replaced-by-oauth")
  const oauthClient = await createAnthropicClientFromOpenCode()

  // Replace the private client field at runtime.
  // TypeScript marks it private but it's a regular JS property.
  ;(adapter as any).client = oauthClient

  return adapter
}
