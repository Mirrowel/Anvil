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
import { composeSkillContext } from '../../skills/index.js';
import { findMcpConfigPath } from '../../mcp/index.js';

// ── Provider resolution ──────────────────────────────────────────────────

export function resolveProvider(modelId: string): ProviderName {
  const id = modelId.toLowerCase();

  // Ollama: explicit `ollama:` prefix or `:tag` suffix common to local models
  // (e.g. `qwen2.5-coder:7b`, `llama3.1:8b`).
  if (id.startsWith('ollama:')) return 'ollama';

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

  // OpenCode Go: registry uses `opencode/<model>` to disambiguate from
  // OpenRouter's slug format. Must come BEFORE the generic slash-check.
  if (id.startsWith('opencode/')) return 'opencode';

  // Google ADK: explicit `adk:<model>` prefix (e.g. `adk:claude-sonnet-4-6`,
  // `adk:gemini-2.5-flash`). The adapter strips the prefix before
  // handing the bare model id to ADK's LLMRegistry.
  if (id.startsWith('adk:')) return 'adk';

  // OpenRouter uses `org/model` format
  if (id.includes('/')) {
    return 'openrouter';
  }

  // Local Ollama models often look like `<family>:<size>` (no slash, with tag).
  // Route through Ollama only when the daemon is reachable; otherwise fall
  // back to Claude so misconfigured runs don't break.
  if (/^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(id) && id !== 'claude' && !id.startsWith('claude-')) {
    return 'ollama';
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
  const enriched = enrichRequestWithWorkspace(request, resolved.provider);
  return new LanguageModelBridge(enriched, resolved.adapter, resolved.provider);
}

/**
 * When `request.workspaceDir` is set, enrich the request with workspace-
 * rooted artefacts:
 *   - Non-Claude paths: compose skill context (system prompt + allowed-
 *     tools narrowing) into the request's `projectPrompt` / `allowedTools`.
 *   - Claude path: resolve the canonical `mcp.json` path so the adapter
 *     can pass `--mcp-config <path>` to claude-cli.
 *
 * Skills are NOT injected into the system prompt for the Claude path
 * because claude-cli auto-loads `.claude/skills/` itself; double-loading
 * would duplicate the bullet list. Per AGENT-PROCESS-CONSOLIDATION-ADR
 * §C5.
 *
 * Pure: returns a new `AdapterRequest` (or the original when no enrichment
 * applies).
 */
export function enrichRequestWithWorkspace(
  request: AdapterRequest,
  provider: ProviderName,
): AdapterRequest {
  if (!request.workspaceDir) return request;

  if (provider === 'claude') {
    const mcpPath = findMcpConfigPath({ workspaceRoot: request.workspaceDir });
    if (!mcpPath) return request;
    return { ...request, claudeMcpConfigPath: mcpPath };
  }

  // Non-Claude path: inject skill block into projectPrompt + reconcile
  // allowed-tools. composeSkillContext is a no-op when no skills exist.
  const ctx = composeSkillContext(request.projectPrompt ?? '', {
    workspaceRoot: request.workspaceDir,
    allowedTools: request.allowedTools,
  });
  if (ctx.activated.skills.length === 0 && !ctx.toolsConstrained) {
    return request;
  }
  return {
    ...request,
    projectPrompt: ctx.systemPrompt || undefined,
    allowedTools: ctx.allowedTools,
  };
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
