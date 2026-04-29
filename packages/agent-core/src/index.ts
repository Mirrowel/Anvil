/**
 * @anvil/agent-core — public barrel.
 *
 * What lives here today (Phase 1):
 *   - Shared LLM types: `LanguageModel`, `ModelAdapter`, `ProviderName`,
 *     `ProviderTier`, `StreamEvent`, `InvokeResult`, etc.
 *   - VERSION constant.
 *
 * What will land in subsequent phases:
 *   - Phase 2: stream-format types (NDJSON event shapes)
 *   - Phase 3: ProviderRegistry singleton
 *   - Phase 4: 7 provider adapters
 *   - Phase 5: single-shot wrapper (runLLM / runClaude / runGemini)
 *   - Phase 6: agent subprocess machinery (AgentManager, spawn, etc.)
 *   - Phase 7: cost table loader
 */

export * from './types.js';
export * from './stream-format.js';
export { VERSION } from './version.js';
