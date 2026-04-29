/**
 * `@anvil/agent-core` — public type surface.
 *
 * Two interfaces live here, intentionally:
 *
 *   1. `LanguageModel` — the new, forward-looking shape. Vendor-agnostic
 *      streaming/single-shot interface that future code (Phase 5+ of the
 *      agent-core extract) wires against. Yields typed events; analytical
 *      callers drain the stream via the default `invoke()` impl.
 *
 *   2. `ModelAdapter` — the legacy interface inherited from cli/src/providers.
 *      Kept verbatim (same field names, same signatures) so the seven existing
 *      adapters keep compiling unchanged when they move into this package in
 *      Phase 3+4. New code should not import these — they are bridged into
 *      `LanguageModel` via `legacyAdapterToLanguageModel()` (Phase 3).
 *
 * `ProviderName` is shared between the two interfaces and uses the EXISTING
 * values (`'claude' | 'openai' | …`) — see ADR D15. Renaming would cascade
 * through every `ProviderRegistry.get()` site and the model-router dispatcher.
 */

// ────────────────────────────────────────────────────────────────────────────
// Shared identifiers
// ────────────────────────────────────────────────────────────────────────────

export type ProviderName =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'ollama'
  | 'gemini-cli'
  | 'adk';

export type ProviderTier = 'agentic' | 'function-calling' | 'text-only';

export interface ProviderCapabilities {
  tier: ProviderTier;
  streaming: boolean;
  toolUse: boolean;
  fileSystem: boolean;
  shellExecution: boolean;
  sessionResume: boolean;
  /** Whether the provider supports prompt caching (e.g. Anthropic ephemeral cache). */
  promptCaching?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// LanguageModel — new unified interface (Phase 1+)
// ────────────────────────────────────────────────────────────────────────────

export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LanguageModelInvokeOptions {
  model: string;
  messages: LanguageModelMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  /** Index in `messages[]` where a cache breakpoint should be inserted (Anthropic-style). */
  cacheBreakpoint?: number;
  /** Escape hatch for provider-specific knobs (e.g., `topP`, `responseFormat`). */
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'reasoning-delta'; text: string }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | {
      type: 'finish';
      reason: 'end' | 'tool-use' | 'length' | 'error';
      error?: string;
    };

export interface InvokeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface InvokeResult {
  text: string;
  toolCalls: ToolCall[];
  usage: InvokeUsage;
  costUsd: number;
  durationMs: number;
  provider: ProviderName;
  model: string;
  /** Reason the stream finished. Mirrors the final `finish` event. */
  finishReason: 'end' | 'tool-use' | 'length' | 'error';
}

export interface LanguageModel {
  readonly provider: ProviderName;
  readonly capabilities: ProviderCapabilities;
  supportsModel(modelId: string): boolean;
  /** `[inputPer1M, outputPer1M]` pricing in USD, or `null` if unknown. */
  getModelPricing(modelId: string): [number, number] | null;
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }>;
  /** Streaming surface — yields events as the provider produces them. */
  invokeStream(opts: LanguageModelInvokeOptions): AsyncIterable<StreamEvent>;
  /** Single-shot surface — drains the stream and returns the final block. */
  invoke(opts: LanguageModelInvokeOptions): Promise<InvokeResult>;
}

// ────────────────────────────────────────────────────────────────────────────
// Legacy adapter shape (preserved verbatim from cli/src/providers/types.ts)
// ────────────────────────────────────────────────────────────────────────────
//
// Field names + signatures must remain identical so the seven existing
// adapters (claude / openai / gemini / openrouter / ollama / gemini-cli / adk)
// keep compiling when they move into agent-core in Phase 4. New code should
// prefer `LanguageModel`; the bridge `legacyAdapterToLanguageModel()` is the
// migration path (Phase 3).

export interface ModelAdapterConfig {
  userPrompt: string;
  projectPrompt?: string;
  model: string;
  workingDir: string;
  stage: string;
  persona: string;
  sessionId?: string;
  resume?: boolean;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeout?: number;
}

export interface ModelAdapterResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  provider: ProviderName;
  model: string;
}

export interface ModelAdapter {
  readonly provider: ProviderName;
  readonly capabilities: ProviderCapabilities;

  /** Check whether this adapter handles the given model identifier. */
  supportsModel(modelId: string): boolean;

  /** Return [inputPer1M, outputPer1M] pricing, or null if unknown. */
  getModelPricing(modelId: string): [number, number] | null;

  /** Verify the provider CLI / API is reachable and report its version. */
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }>;

  /** Run agent. Write Anvil Stream Format NDJSON to `output`. */
  run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult>;

  /** Kill running process if applicable. */
  kill?(): void;
}
