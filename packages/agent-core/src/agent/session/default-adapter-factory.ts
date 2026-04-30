/**
 * Default `AgentAdapterFactory` for `AgentManager`.
 *
 * Resolves a `SpawnConfig`'s model field to an `@anvil/agent-core`
 * `ModelAdapter` via `ProviderRegistry`, then wraps it in a
 * `LanguageModelBridge` so `AgentProcess` can drive it through the 5-event
 * `AgentAdapter` surface.
 *
 * Provider resolution heuristic:
 *   - `gemini-*` prefers the Gemini CLI when the binary is on PATH; if not,
 *     falls back to the HTTP API adapter (`gemini`).
 *   - Model ids containing `/` route to OpenRouter.
 *   - Otherwise we delegate to `ProviderRegistry.resolveFromModelId` which
 *     covers Claude / OpenAI / Gemini-API.
 */

import { execSync } from 'node:child_process';
import { ProviderRegistry } from '../../registry.js';
import type { ModelAdapter, ProviderName } from '../../types.js';
import type {
  AdapterRequest,
  AgentAdapter,
  AgentAdapterFactory,
} from './adapter.js';
import { LanguageModelBridge } from './language-model-bridge.js';

// ── Provider resolution ──────────────────────────────────────────────────

export function resolveProvider(modelId: string): ProviderName {
  const id = modelId.toLowerCase();

  // Gemini: prefer CLI when available, fall back to HTTP API.
  if (id.startsWith('gemini-')) {
    if (geminiCliAvailable()) return 'gemini-cli';
    return 'gemini';
  }

  // OpenAI patterns
  if (
    id.startsWith('gpt-') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.startsWith('chatgpt-')
  ) {
    return 'openai';
  }

  // OpenRouter uses `org/model` format
  if (id.includes('/')) {
    return 'openrouter';
  }

  // Claude (default)
  return 'claude';
}

// Cache the CLI probe so repeated factory calls don't fork a shell each time.
let geminiCliCached: boolean | null = null;
function geminiCliAvailable(): boolean {
  if (geminiCliCached !== null) return geminiCliCached;
  try {
    execSync('which gemini', { stdio: 'pipe', timeout: 2000 });
    geminiCliCached = true;
  } catch {
    geminiCliCached = false;
  }
  return geminiCliCached;
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Default factory used by `AgentManager` when no `adapterFactory` is
 * passed to its constructor. Resolves a `LanguageModelBridge` for the
 * given request via `ProviderRegistry`.
 *
 * Returned adapter is always a `LanguageModelBridge` — `AgentProcess`
 * sees the 5-event `AgentAdapter` surface; agent-core handles the actual
 * call via the registered `ModelAdapter`.
 */
export function defaultAdapterFactory(request: AdapterRequest): AgentAdapter {
  const registry = ProviderRegistry.getInstance();
  const provider = resolveProvider(request.model);
  const resolved = resolveAdapterOrFallback(registry, provider);
  return new LanguageModelBridge(request, resolved.adapter, resolved.provider);
}

/** Type alias matching `AgentAdapterFactory` — exported for explicit typing. */
export const defaultAdapterFactoryFn: AgentAdapterFactory = defaultAdapterFactory;

function resolveAdapterOrFallback(
  registry: ProviderRegistry,
  provider: ProviderName,
): { adapter: ModelAdapter; provider: ProviderName } {
  const direct = registry.get(provider);
  if (direct) return { adapter: direct, provider };

  // Claude is always registered by registerDefaults; treat as the safe fallback.
  const claude = registry.get('claude');
  if (claude) return { adapter: claude, provider: 'claude' };

  throw new Error(
    `No agent-core adapter available for provider "${provider}" and no "claude" fallback registered.`,
  );
}
