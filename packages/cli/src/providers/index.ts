// Types now live in @anvil/agent-core (Phase 3).
// Re-exported here so cli-internal consumers (e.g. commands/run-feature.ts)
// continue to resolve them via the providers barrel.
export type {
  ProviderName,
  ProviderTier,
  ProviderCapabilities,
  ModelAdapterConfig,
  ModelAdapterResult,
  ModelAdapter,
  TextContentBlock,
  ToolUseContentBlock,
  ThinkingContentBlock,
  ContentBlock,
  AssistantMessage,
  ResultUsage,
  ResultMessage,
  StreamLine,
} from '@anvil/agent-core';
export { emitContent, emitToolUse, emitThinking, emitResult } from '@anvil/agent-core';
export * from './registry.js';
export { ClaudeAdapter } from './claude-adapter.js';
export { OpenAIAdapter } from './openai-adapter.js';
export { GeminiAdapter } from './gemini-adapter.js';
export { OpenRouterAdapter } from './openrouter-adapter.js';
export { OllamaAdapter } from './ollama-adapter.js';
export { GeminiCliAdapter } from './gemini-cli-adapter.js';
export { AdkAdapter } from './adk-adapter.js';
