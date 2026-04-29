# `@anvil/agent-core`

Shared LLM stack for the Anvil monorepo. Owns every LLM call surface — both the
streaming/agent shape (build/validate/ship pipeline stages) and the single-shot
analytical shape (repo profiler, service-mesh inferrer, RAG evaluator).

> **Status:** under construction. Tracked in [`AGENT-CORE-EXTRACT-PLAN.md`](../../AGENT-CORE-EXTRACT-PLAN.md).
> Phase 1 (this commit) ships the package skeleton + the unified `LanguageModel` /
> `ModelAdapter` type surface. Adapters and registry land in Phases 2–6.

## Goals

1. **One unified interface.** `LanguageModel` covers both streaming and
   single-shot use. Existing legacy `ModelAdapter` kept verbatim for the
   transition window; bridged via `legacyAdapterToLanguageModel()` (Phase 3).
2. **No external LLM-abstraction library.** Each provider adapter calls its
   vendor's official SDK directly (or spawns a CLI subprocess). Lock-in surface
   = one adapter file per provider (~150 LOC).
3. **Existing public APIs preserved.** `cli/src/providers/index.ts` and
   `knowledge-core/src/claude-runner.ts` keep the same exports; both become
   thin re-export shims pointing at this package.

## Public API (Phase 1)

```ts
import {
  // New unified shape
  type LanguageModel,
  type LanguageModelInvokeOptions,
  type StreamEvent,
  type InvokeResult,
  type ToolCall,
  type ToolSchema,

  // Shared identifiers
  type ProviderName,
  type ProviderTier,
  type ProviderCapabilities,

  // Legacy shape (transition only — prefer LanguageModel)
  type ModelAdapter,
  type ModelAdapterConfig,
  type ModelAdapterResult,

  VERSION,
} from '@anvil/agent-core';
```

## Roadmap

| Phase | Scope |
|---|---|
| 1 (done) | Package skeleton + types |
| 2 | Hoist `stream-format.ts` from cli |
| 3 | Hoist `types.ts` (legacy section) + `ProviderRegistry` |
| 4 | Hoist 7 provider adapters |
| 5 | Single-shot wrapper (`runLLM`, `runClaude`, `runGemini`) |
| 6 | Hoist `cli/src/agent/` subprocess machinery |
| 7 | Cost table integration (LiteLLM snapshot) |
| 8 | Test migration |
| 9 | Build/CI consolidation |
| 10 | Docs |

See [`AGENT-CORE-ADR.md`](../../AGENT-CORE-ADR.md) for the locked decisions
(D1–D16) and audit findings.
