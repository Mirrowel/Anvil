# Anvil Token-Optimization Plan

> **Self-contained implementation plan.** This document is written to be executed by a fresh-context coding agent with no prior conversation. Every file path, line number, code shape, and acceptance criterion is captured below. Read top-to-bottom before starting Phase 0.

---

## 0. Context You Need

### What Anvil is

Anvil is a **local-only developer tool** that runs an 8-stage AI pipeline against a project's source code. A single user runs it on their own machine; there is no multi-tenant scale. Each user pays their own LLM bill. Optimizations target **per-user cost** and **interactive latency**, not aggregate fleet economics.

### Multi-provider, not Claude-only

The architecture must remain provider-agnostic. Today: Claude (CLI), OpenAI-shape (API), Gemini (CLI). Tomorrow: more. Optimizations must live behind the adapter contract, not in caller code.

### Pipeline stages (from `packages/dashboard/server/pipeline-runner.ts:170-178`)

| Idx | name              | persona      | perRepo |
|-----|-------------------|--------------|---------|
| 0   | clarify           | clarifier    | false   |
| 1   | requirements      | analyst      | false   |
| 2   | repo-requirements | analyst      | true    |
| 3   | specs             | architect    | true    |
| 4   | tasks             | lead         | true    |
| 5   | build             | engineer     | true    |
| 6   | test              | test-author  | true    |
| 7   | validate          | tester       | true    |
| 8   | ship              | engineer     | false   |

### Where artifacts live

- `featureStore.writeArtifact(project, slug, relPath, content)` — `packages/dashboard/server/feature-store.ts:239`
- `featureStore.readArtifact(project, slug, relPath): string | null` — `feature-store.ts:257`
- `featureStore.getFeatureDir(project, slug): string` — `feature-store.ts:106`

Per-feature dir layout (already exists):
```
<anvilHome>/projects/<project>/features/<slug>/
  feature.json                 # metadata
  REQUIREMENTS.md              # high-level (stage 1 output)
  repos/<repoName>/REQUIREMENTS.md
  repos/<repoName>/SPECS.md
  repos/<repoName>/TASKS.md
  repos/<repoName>/BUILD.md
  runs/<runId>/...
```

### Adapter contract today (`packages/dashboard/server/adapters/base-adapter.ts`)

```ts
abstract class BaseAdapter extends EventEmitter {
  abstract start(): void;
  abstract kill(): void;
  abstract get pid(): number | undefined;
  abstract get killed(): boolean;
}
interface AdapterConfig {
  prompt: string; model: string; sessionId: string; cwd: string;
  resume?: boolean; projectPrompt?: string; permissionMode?: string;
  disallowedTools?: string[]; allowedTools?: string[];
}
interface AdapterCostInfo {
  totalUsd; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; durationMs;
}
```

Existing concrete adapters: `claude-adapter.ts`, `api-adapter.ts`, `gemini-cli-adapter.ts`. Factory: `adapter-factory.ts`.

### Three duplicate token estimators (chars/4 heuristic)

Centralize these in Phase 0 step 2:

1. `packages/dashboard/server/context-budget.ts:21` — `estimateTokens(text)`
2. `packages/dashboard/server/prompt-budget.ts:192` — `estimateBudgetTokens(text)`
3. `packages/cli/src/knowledge/context-assembler.ts:18` — `estimateTokens(text)`

### Existing infrastructure to reuse, not rebuild

- **Hybrid retriever**: `packages/cli/src/knowledge/retriever.ts` (vector + BM25 + RRF + AST + optional rerank). Already supports a `Reranker` slot.
- **Embedder**: `packages/cli/src/knowledge/embedder.ts` (used for vector store; reuse for similarity checkpoint).
- **AST graph builder**: `packages/cli/src/knowledge/ast-graph-builder.ts` (reuse for structural truncation).
- **Checkpoint store**: see `dashboard-server.ts:4843+` — `agentManager.setCheckpointHook({ lookup, record })`. Already keyed by exact prompt hash; we'll extend with similarity lookup in Phase 7.
- **Cost ledger**: `packages/dashboard/server/cost-ledger.ts` + `cost-breach-handler.ts`. Records every LLM call's spend. Use this to **measure savings** at every phase (instrumentation only — no behavior change needed).
- **Prompt builder**: `pipeline-runner.ts:2744` (`buildStagePrompt`) and `pipeline-runner.ts:2796` (`buildRepoStagePrompt`). All prompt mutations land here.
- **Plan-seed shortcut**: `pipeline-runner.ts:734-770` already deterministically renders REQUIREMENTS/SPECS/TASKS from a plan JSON when `config.planSeed` is provided. Don't break this path.

### Goals

1. **Cut input-token cost 50–80%** on stages 2+ via prefix caching.
2. **Cut redundant LLM calls 30–50%** on stages 5+ via a shared **feature manifest**.
3. **Cap output bloat** by enforcing per-stage `max_tokens`.
4. **Drop free** stages (clarify/ship) onto a fully-local model so they cost $0.
5. **Stay provider-agnostic** — every optimization gated behind the adapter capability surface.

### Non-goals

- Batch API integration (24-hour async; not for interactive use).
- Multi-tenant scaling, fleet routing, server-side caching of customer data.
- Replacing the existing hybrid retriever (it's already strong).
- Anything that breaks the `planSeed` deterministic short-circuit.

### Order of phases

Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Each phase is independently shippable; don't start phase N+1 until phase N's acceptance criteria pass. Phase 1 alone is most of the dollar savings; Phase 2 is the user-requested "don't waste prior-stage info" win.

---

## Phase 0 — Adapter Capability Surface + Real Tokenizer

**Goal:** A single seam for every later phase to use. After Phase 0, the rest of the codebase asks `adapter.countTokens(...)` and `adapter.markCacheBreakpoint(...)`; nothing knows or cares which provider is in the call.

**Effort:** ~0.5 day.

### 0.1 — Add `AdapterCapabilities` and helper methods to `BaseAdapter`

**File:** `packages/dashboard/server/adapters/base-adapter.ts`

Add at top-level (export):

```ts
export interface AdapterCapabilities {
  /**
   * 'auto'     — provider caches stable prefixes silently (e.g., OpenAI ≥1024 tok).
   * 'explicit' — caller must place markers (e.g., Anthropic cache_control).
   * 'none'     — no caching benefit; markers are no-ops.
   */
  promptCache: 'auto' | 'explicit' | 'none';
  /** Whether countTokens uses the model's exact tokenizer or an estimator. */
  countTokens: 'exact' | 'heuristic';
  /** Structured output support. */
  structuredOutput: 'strict' | 'tool-shim' | 'best-effort' | 'none';
  /** Cache TTL in seconds when promptCache !== 'none'. Informational only. */
  cacheTtlSeconds?: number;
  /** Adapter knows how to enforce a max-output ceiling. */
  maxOutputTokens: boolean;
}
```

Add to `BaseAdapter`:

```ts
abstract get capabilities(): AdapterCapabilities;

/**
 * Exact token count for a string under this adapter's model.
 * Fallback implementation is the chars/4 heuristic; concrete adapters
 * SHOULD override with the provider's real tokenizer.
 */
countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Insert a cache breakpoint marker into the prompt at `position`.
 * - For 'explicit' providers: implementations transform the prompt to include
 *   the provider-native marker (e.g., wrap a section with cache_control).
 * - For 'auto' / 'none': default impl returns the prompt unchanged.
 *
 * Returns the (possibly transformed) full prompt string.
 */
markCacheBreakpoint(prompt: string, _position: number): string {
  return prompt;
}

/**
 * Optional: attach a max-output ceiling to the next call. No-op if the
 * adapter doesn't support it.
 */
setMaxOutputTokens(_n: number): void { /* no-op */ }
```

**Validation:** `npx tsc --noEmit -p packages/dashboard/server/tsconfig.json`. No errors.

### 0.2 — Concrete adapter overrides

#### Claude (`packages/dashboard/server/adapters/claude-adapter.ts`)

The Claude CLI has automatic prompt caching via `cache_control: {type: 'ephemeral'}` markers in the prompt-prefix structure. The CLI itself manages caching when system prompts are stable. We mark `promptCache: 'explicit'` so callers know to keep prefix structure stable.

```ts
override get capabilities(): AdapterCapabilities {
  return {
    promptCache: 'explicit',
    countTokens: 'heuristic',  // upgrade in 0.3 if @anthropic-ai/tokenizer is added
    structuredOutput: 'tool-shim',
    cacheTtlSeconds: 300,      // 5-min default
    maxOutputTokens: true,
  };
}

override markCacheBreakpoint(prompt: string, position: number): string {
  // The Claude CLI consumes a single string prompt. We embed a sentinel that
  // the CLI doesn't interpret but that downstream "prompt restructure" code
  // can detect to ensure it placed the breakpoint correctly. Real cache
  // behavior requires the prefix to be byte-identical across calls — that's
  // the caller's responsibility (Phase 1).
  const safe = Math.max(0, Math.min(prompt.length, position));
  return prompt.slice(0, safe) + '\n<!-- anvil:cache-breakpoint -->\n' + prompt.slice(safe);
}

override setMaxOutputTokens(n: number): void {
  this._maxOutputTokens = n;
}

// In buildArgs(): pass --max-tokens or equivalent if the CLI supports it.
// Inspect: spawn the CLI with `claude --help` once to confirm flag name; otherwise omit.
```

Add `_maxOutputTokens?: number;` private field.

#### OpenAI-shape (`packages/dashboard/server/adapters/api-adapter.ts`)

OpenAI has automatic prefix caching (≥1024 tokens, 50% off). No marker needed — just stable prefix.

```ts
override get capabilities(): AdapterCapabilities {
  return {
    promptCache: 'auto',
    countTokens: 'heuristic',
    structuredOutput: 'strict',
    cacheTtlSeconds: 600,
    maxOutputTokens: true,
  };
}
override markCacheBreakpoint(prompt: string): string { return prompt; }
override setMaxOutputTokens(n: number): void { this._maxOutputTokens = n; }
```

When invoking OpenAI, pass `max_tokens: this._maxOutputTokens` if set.

#### Gemini CLI (`packages/dashboard/server/adapters/gemini-cli-adapter.ts`)

Gemini supports explicit `CachedContent` objects, but the CLI exposes it differently. Conservatively mark as `auto` with the marker as a no-op until the CLI surface is verified.

```ts
override get capabilities(): AdapterCapabilities {
  return {
    promptCache: 'auto',
    countTokens: 'heuristic',
    structuredOutput: 'strict',
    cacheTtlSeconds: 300,
    maxOutputTokens: true,
  };
}
```

### 0.3 — Real tokenizer (optional within Phase 0; can defer to a follow-up)

If you can install dependencies in this codebase:

```bash
npm install --workspace=@anvil-dev/dashboard tiktoken @anthropic-ai/tokenizer
```

Then override `countTokens` per adapter:

```ts
// claude-adapter.ts
import { countTokens as anthropicCount } from '@anthropic-ai/tokenizer';
override countTokens(text: string): number {
  try { return anthropicCount(text); } catch { return Math.ceil(text.length / 4); }
}

// api-adapter.ts
import { encoding_for_model } from 'tiktoken';
override countTokens(text: string): number {
  try {
    const enc = encoding_for_model(this.config.model as any);
    const n = enc.encode(text).length;
    enc.free();
    return n;
  } catch { return Math.ceil(text.length / 4); }
}
```

Update capability `countTokens: 'exact'` for adapters that successfully load the real tokenizer.

If dependency installation is out of scope, leave the heuristic in place — the rest of the plan still works; you just lose the ~3–5% extra accuracy.

### 0.4 — Centralize and route through the adapter

**Files:** `context-budget.ts:21`, `prompt-budget.ts:192`, `cli/src/knowledge/context-assembler.ts:18`.

Replace each local `estimateTokens` implementation with a thin wrapper that takes an adapter:

```ts
// shared utility — put in packages/dashboard/server/token-util.ts (new file)
import type { BaseAdapter } from './adapters/base-adapter.js';
export function countTokens(adapter: BaseAdapter | null, text: string): number {
  if (adapter) return adapter.countTokens(text);
  if (!text) return 0;
  return Math.ceil(text.length / 4);  // fallback
}
```

Migrate the three call sites to import from `token-util.ts`. Where an adapter is not available (e.g., the CLI `context-assembler.ts` runs outside agent execution), keep the heuristic fallback. Inside `pipeline-runner.ts`, thread the active adapter into context-budgeting calls.

### Phase 0 acceptance

- [ ] `BaseAdapter` exposes `capabilities`, `countTokens`, `markCacheBreakpoint`, `setMaxOutputTokens`.
- [ ] All three concrete adapters implement `capabilities`.
- [ ] `tsc -p packages/dashboard/server/tsconfig.json` is clean.
- [ ] `npm run build` succeeds in `packages/dashboard`.
- [ ] No call site references `Math.ceil(text.length / 4)` directly except inside `token-util.ts` and inside `BaseAdapter.countTokens`'s fallback.

### Phase 0 rollback

The new methods have safe defaults; if anything regresses, revert the call-site migrations (the new utilities won't be referenced) and the original heuristics keep working.

---

## Phase 1 — Stable-Prefix Prompt Restructure (the dollars phase)

**Goal:** Across the 8-stage pipeline, the same ~30K of system prompt + project context + KB ships up to 8×. Currently each stage rebuilds the prompt with subtle reorderings, busting the prefix cache. After Phase 1, the **stable prefix is byte-identical across stages** and the variable suffix carries the per-stage delta. Result: providers that auto-cache (OpenAI, Gemini) get 50–75% off cached input tokens for free; providers that need explicit markers (Anthropic) get a `cache_control` marker placed by the adapter.

**Effort:** 1.5–2 days.

### 1.1 — Define the canonical prompt envelope

Create `packages/dashboard/server/prompt-envelope.ts`:

```ts
import type { BaseAdapter } from './adapters/base-adapter.js';

/**
 * Canonical layout for every stage prompt. The STABLE block must be
 * byte-identical across stages of the same run so prompt caching kicks in.
 *
 *   ┌─ STABLE PREFIX ─────────────────────────────────────┐
 *   │ 1. System prompt (persona-agnostic invariants)      │
 *   │ 2. Project facts (factory.yaml summary, repo names) │
 *   │ 3. Knowledge graph index (full or repo-tier)        │
 *   │ 4. Conventions / repo invariants                    │
 *   │ 5. Feature manifest (Phase 2 — see below)           │
 *   ├─ CACHE BREAKPOINT ──────────────────────────────────┤
 *   │ 6. Stage instructions (persona-specific)            │
 *   │ 7. Feature description                              │
 *   │ 8. Prior artifact (if any)                          │
 *   │ 9. Resume / failure context                         │
 *   └─────────────────────────────────────────────────────┘
 */
export interface PromptEnvelopeInput {
  // STABLE
  systemPrompt: string;        // never mutated mid-run
  projectFacts: string;        // factory.yaml summary, repo list
  knowledgeBase: string;       // already KB-tier-shaped per stage; SAME tier within a stage
  conventions: string;         // long-lived rules
  featureManifest: string;     // empty until Phase 2

  // VARIABLE
  stageInstructions: string;   // persona prompt
  featureDescription: string;
  priorArtifact: string;
  resumeContext: string;
}

export interface PromptEnvelopeOutput {
  prompt: string;
  stableBytes: number;
  variableBytes: number;
  /** Byte index where the cache breakpoint is placed. */
  breakpointAt: number;
}

const STABLE_HEADER = '<!-- anvil:stable-prefix:v1 -->';
const VARIABLE_HEADER = '<!-- anvil:variable-suffix:v1 -->';

export function buildPromptEnvelope(
  input: PromptEnvelopeInput,
  adapter: BaseAdapter | null,
): PromptEnvelopeOutput {
  const stable = [
    STABLE_HEADER,
    input.systemPrompt,
    sectionIfNonEmpty('Project facts', input.projectFacts),
    sectionIfNonEmpty('Knowledge graph', input.knowledgeBase),
    sectionIfNonEmpty('Conventions', input.conventions),
    sectionIfNonEmpty('Feature manifest', input.featureManifest),
  ].filter(Boolean).join('\n\n');

  const variable = [
    VARIABLE_HEADER,
    sectionIfNonEmpty('Stage instructions', input.stageInstructions),
    sectionIfNonEmpty('Feature', input.featureDescription),
    sectionIfNonEmpty('Previous stage output', input.priorArtifact),
    sectionIfNonEmpty('Resume context', input.resumeContext),
  ].filter(Boolean).join('\n\n');

  let prompt = stable + '\n\n' + variable;
  const breakpointAt = stable.length + 2; // position right after stable block

  if (adapter && adapter.capabilities.promptCache === 'explicit') {
    prompt = adapter.markCacheBreakpoint(prompt, breakpointAt);
  }

  return {
    prompt,
    stableBytes: Buffer.byteLength(stable, 'utf-8'),
    variableBytes: Buffer.byteLength(variable, 'utf-8'),
    breakpointAt,
  };
}

function sectionIfNonEmpty(title: string, body: string): string | null {
  if (!body || body.trim().length === 0) return null;
  return `## ${title}\n${body.trim()}`;
}
```

### 1.2 — Refactor `buildStagePrompt` and `buildRepoStagePrompt` to emit envelopes

**File:** `packages/dashboard/server/pipeline-runner.ts:2744` and `:2796`.

Replace the bodies. Pseudocode:

```ts
private buildStagePrompt(stage: StageDefinition, prevArtifact: string): string {
  const env = buildPromptEnvelope({
    systemPrompt: this.getStableSystemPrompt(),       // see 1.3
    projectFacts: this.getStableProjectFacts(),       // see 1.3
    knowledgeBase: this.getStableKnowledgeBase(stage),// SAME tier across stages — see 1.4
    conventions: this.getStableConventions(),
    featureManifest: '', // Phase 2 fills this
    stageInstructions: this.getStageInstructions(stage), // persona prompt only
    featureDescription: `Feature: "${this.config.feature}"`,
    priorArtifact: prevArtifact ? prevArtifact.slice(0, 12000) : '',
    resumeContext: this.config.failureContext ?? '',
  }, this.activeAdapter);
  return env.prompt;
}
```

The stable getters (`getStableSystemPrompt`, etc.) MUST return the same string for every stage in the run. Cache them on `this` after the first call.

### 1.3 — Stable getters: build once, reuse forever

Add private fields to `PipelineRunner`:

```ts
private cachedStableSystemPrompt: string | null = null;
private cachedStableProjectFacts: string | null = null;
private cachedStableConventions: string | null = null;
private cachedStableKB: Map<string /* tier */, string> = new Map();

private getStableSystemPrompt(): string {
  if (this.cachedStableSystemPrompt !== null) return this.cachedStableSystemPrompt;
  // Compose a persona-AGNOSTIC system prompt: it must NOT mention the current
  // stage or persona. Move per-stage instructions into stageInstructions.
  const parts = [
    'You are an Anvil pipeline agent. Follow the structured artifact handoff protocol.',
    'Treat the feature manifest as authoritative — read it before deriving anything.',
    // ... pull other persona-agnostic invariants here
  ];
  this.cachedStableSystemPrompt = parts.join('\n\n');
  return this.cachedStableSystemPrompt;
}

private getStableProjectFacts(): string {
  if (this.cachedStableProjectFacts !== null) return this.cachedStableProjectFacts;
  // factory.yaml summary, repo list, language hints, domain glossary.
  // Read once, stringify deterministically (sort keys), cache.
  this.cachedStableProjectFacts = renderProjectFactsForPrompt(this.projectInfo, this.state.repoNames);
  return this.cachedStableProjectFacts;
}
```

Cache invalidation: only when `factory.yaml` changes between runs (i.e., next run rebuilds). Within a run, never.

### 1.4 — Lock KB tier across stages within a run

Today `kbTierForStage` (`pipeline-runner.ts:568`) returns different tiers per stage. That's CORRECT for context-shrinking but WRONG for cache stability — switching tiers between stages means the KB section bytes change, busting the cache.

**Trade-off:** for the cache to fire across stages 2–8, we need ONE tier for stages 2–8. Pick the highest tier needed by any non-trivial stage (`'repo-focused'` is the right balance). Stages where this tier is bigger than necessary (e.g., `validate`) still fire the cache and pay 0.5–0.9× the cached price.

Modify the prompt envelope's `knowledgeBase` field source: use a single locked tier per run, computed once at run start:

```ts
// In PipelineRunner.run() / initial setup, near where stages start:
this.lockedKbTier = this.computeLockedKbTier();  // e.g., 'repo-focused'

private getStableKnowledgeBase(stage: StageDefinition): string {
  // Ignore `stage` for cache-stability; emit the locked tier always.
  const cached = this.cachedStableKB.get(this.lockedKbTier);
  if (cached !== undefined) return cached;
  const built = this.kbManager?.renderForTier(this.lockedKbTier, this.state.repoNames) ?? '';
  this.cachedStableKB.set(this.lockedKbTier, built);
  return built;
}
```

**Exception:** stage `'ship'` legitimately needs `'none'` (git ops only). Keep the existing `if (stageName === 'ship') return 'none'` branch, treating ship as a "cache-bust accepted" stage. The 8th stage cache-breaking is fine — it's once at the end.

**Exception:** stage `'clarify'` may need `'index-only'` (the big picture). If its prompt would explode otherwise, allow clarify to use its own tier and accept the cache bust on that stage too.

Net: stages 1–7 share the cache; stages 0 and 8 are accepted as cache-cold.

### 1.5 — Verify the breakpoint with a smoke test

Add `packages/dashboard/server/__tests__/prompt-envelope.test.ts`:

```ts
import { buildPromptEnvelope } from '../prompt-envelope.js';
import { strict as assert } from 'node:assert';
import test from 'node:test';

test('stable prefix is byte-identical across two calls with same stable inputs', () => {
  const stable = {
    systemPrompt: 'sys', projectFacts: 'facts', knowledgeBase: 'kb',
    conventions: 'conv', featureManifest: '',
  };
  const a = buildPromptEnvelope({ ...stable, stageInstructions: 'A', featureDescription: 'f', priorArtifact: '', resumeContext: '' }, null);
  const b = buildPromptEnvelope({ ...stable, stageInstructions: 'B', featureDescription: 'f', priorArtifact: '', resumeContext: '' }, null);
  assert.equal(a.prompt.slice(0, a.breakpointAt), b.prompt.slice(0, b.breakpointAt));
});
```

Run via `npm run test:server` (`packages/dashboard`).

### 1.6 — Instrument cache hit rate

Already wired — `claude-adapter.ts:30-31, 186-187` records `cache_read_input_tokens`. Add a per-run aggregate broadcast: in `cost-ledger.ts` or wherever spend is recorded, also tally `sum(cacheReadTokens) / sum(inputTokens + cacheReadTokens)` and surface in the dashboard. This is your KPI.

### Phase 1 acceptance

- [ ] `buildStagePrompt` and `buildRepoStagePrompt` both route through `buildPromptEnvelope`.
- [ ] On a build run with stages 1–7 enabled, the stable prefix bytes (`env.stableBytes`) are equal across all calls in that run (measure by logging in dev mode).
- [ ] Cache hit ratio in the dashboard exceeds 0% on the first re-run after the patch is deployed (Anthropic) and >50% on stages 2–7 by the second build of the same feature.
- [ ] Smoke test in 1.5 passes.
- [ ] No regression on the `planSeed` deterministic short-circuit (`pipeline-runner.ts:734-770`).
- [ ] `npm run build` succeeds.

### Phase 1 rollback

Keep the old `buildStagePrompt` body in a `buildStagePromptLegacy` private method behind a feature flag (`process.env.ANVIL_PROMPT_ENVELOPE_DISABLED === '1'`). Default to envelope; flip the flag to revert.

---

## Phase 2 — Feature Manifest (artifact memoization)

**Goal:** Stop re-deriving information that an earlier stage already produced and wrote to a Markdown artifact. Stage 5+ agents currently re-reason about requirements/specs/tasks they could just read. Introduce a **feature manifest** — one structured JSON file per feature, accumulated across stages, that all stages consult before going to the LLM.

**Effort:** 2–3 days.

### 2.1 — Define the manifest schema

Create `packages/dashboard/server/feature-manifest.ts`:

```ts
export const FEATURE_MANIFEST_VERSION = 1;

export type FieldStatus = 'unset' | 'partial' | 'final';

export interface ManifestField<T> {
  status: FieldStatus;
  value: T | null;
  /** Stage that last wrote this field. */
  writtenBy?: string;
  /** ISO timestamp of last write. */
  writtenAt?: string;
}

export interface FeatureManifest {
  version: number;
  feature: string;
  featureSlug: string;
  project: string;
  createdAt: string;
  updatedAt: string;

  // Populated through the pipeline:
  acceptanceCriteria: ManifestField<string[]>;       // from clarify/requirements
  affectedRepos: ManifestField<string[]>;            // from requirements
  apiEndpoints: ManifestField<Array<{               // from specs
    repo: string; method: string; path: string; purpose: string;
  }>>;
  tablesTouched: ManifestField<Array<{               // from specs
    repo: string; table: string; mutationKind: 'add' | 'alter' | 'drop' | 'read-only';
  }>>;
  filesPlanned: ManifestField<Array<{                // from tasks
    repo: string; path: string; kind: 'create' | 'modify' | 'delete';
  }>>;
  testBehaviors: ManifestField<Array<{                // from specs/tasks
    description: string; gherkin?: string;
  }>>;
  changeBrief: ManifestField<string>;                 // from build (one-line summary for review/ship)
  openQuestions: ManifestField<string[]>;             // any stage can append
}

export function emptyManifest(project: string, slug: string, feature: string): FeatureManifest {
  const now = new Date().toISOString();
  const unset = <T>(): ManifestField<T> => ({ status: 'unset', value: null });
  return {
    version: FEATURE_MANIFEST_VERSION,
    feature, featureSlug: slug, project,
    createdAt: now, updatedAt: now,
    acceptanceCriteria: unset(), affectedRepos: unset(),
    apiEndpoints: unset(), tablesTouched: unset(),
    filesPlanned: unset(), testBehaviors: unset(),
    changeBrief: unset(), openQuestions: unset(),
  };
}
```

### 2.2 — Manifest store (read/write atomic)

Same file:

```ts
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureStore } from './feature-store.js';

const MANIFEST_FILENAME = 'manifest.json';

export class FeatureManifestStore {
  constructor(private featureStore: FeatureStore) {}

  read(project: string, slug: string): FeatureManifest | null {
    const path = join(this.featureStore.getFeatureDir(project, slug), MANIFEST_FILENAME);
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf-8')) as FeatureManifest; }
    catch { return null; }
  }

  write(m: FeatureManifest): void {
    const dir = this.featureStore.getFeatureDir(m.project, m.featureSlug);
    const path = join(dir, MANIFEST_FILENAME);
    const tmp = path + '.tmp';
    m.updatedAt = new Date().toISOString();
    writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf-8');
    renameSync(tmp, path);
  }

  /** Update one field in place; bumps writtenBy/writtenAt and persists. */
  patchField<K extends keyof FeatureManifest>(
    project: string, slug: string, field: K, status: FieldStatus,
    value: FeatureManifest[K] extends ManifestField<infer T> ? T : never,
    writtenBy: string,
  ): FeatureManifest {
    const m = this.read(project, slug) ?? emptyManifest(project, slug, '');
    (m[field] as ManifestField<unknown>) = {
      status, value: value as unknown,
      writtenBy, writtenAt: new Date().toISOString(),
    };
    this.write(m);
    return m;
  }
}
```

### 2.3 — Render manifest into prompt envelope

Add to `feature-manifest.ts`:

```ts
/**
 * Render the manifest as a compact text block for inclusion in the stable
 * prefix of the prompt envelope. ~200–800 tokens depending on fill state.
 */
export function renderManifestForPrompt(m: FeatureManifest | null): string {
  if (!m) return '';
  const lines: string[] = [];
  lines.push(`Feature manifest (v${m.version}) — read this BEFORE deriving any field below.`);
  lines.push(`Rule: if a field is marked 'final', use it verbatim. Do not re-derive.`);
  lines.push('');

  const f = (label: string, fld: ManifestField<unknown>): void => {
    if (fld.status === 'unset' || fld.value === null) {
      lines.push(`- ${label}: <unset>`);
      return;
    }
    const val = Array.isArray(fld.value)
      ? `[${fld.value.length} entries]\n` + fld.value.map((v) => `    • ${stringifyEntry(v)}`).join('\n')
      : String(fld.value);
    lines.push(`- ${label} [${fld.status}, by ${fld.writtenBy ?? '?'}]: ${val}`);
  };

  f('Acceptance criteria', m.acceptanceCriteria);
  f('Affected repos', m.affectedRepos);
  f('API endpoints', m.apiEndpoints);
  f('Tables touched', m.tablesTouched);
  f('Files planned', m.filesPlanned);
  f('Test behaviors', m.testBehaviors);
  f('Change brief', m.changeBrief);
  f('Open questions', m.openQuestions);
  return lines.join('\n');
}

function stringifyEntry(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
```

Wire into `pipeline-runner.ts` `buildStagePrompt`:

```ts
const manifest = this.manifestStore.read(this.config.project, this.state.featureSlug);
const env = buildPromptEnvelope({
  ...,
  featureManifest: renderManifestForPrompt(manifest),
  ...
}, this.activeAdapter);
```

### 2.4 — Stage-exit manifest extraction

After each stage's `result.artifact` is produced (`pipeline-runner.ts:866`), run a **cheap-model extraction** that pulls structured fields out of the artifact and patches the manifest. Use the cheapest tier model (Haiku-class).

Add `extractAndUpdateManifest`:

```ts
private async extractAndUpdateManifest(stage: StageDefinition, artifact: string): Promise<void> {
  const fieldsForStage: Record<string, Array<keyof FeatureManifest>> = {
    requirements:        ['acceptanceCriteria', 'affectedRepos'],
    'repo-requirements': [],  // already covered
    specs:               ['apiEndpoints', 'tablesTouched', 'testBehaviors'],
    tasks:               ['filesPlanned'],
    build:               ['changeBrief'],
    test:                [],
    validate:            ['openQuestions'],
  };
  const fields = fieldsForStage[stage.name] ?? [];
  if (fields.length === 0) return;

  // One small extraction call per stage. Use a fast-tier model.
  const extractionPrompt = buildExtractionPrompt(stage, fields, artifact);
  const fastModel = resolveModel('fast', this.config.model);
  const json = await this.runQuickExtraction(extractionPrompt, fastModel);
  if (!json) return;

  for (const field of fields) {
    const value = json[field as string];
    if (value === undefined) continue;
    this.manifestStore.patchField(
      this.config.project, this.state.featureSlug,
      field, 'final', value, stage.name,
    );
  }
}
```

`runQuickExtraction` is a thin one-shot adapter call that returns parsed JSON (use the adapter's `structuredOutput` capability if `'strict'`; otherwise prompt for a JSON-fenced block and parse). Spec the JSON schema in `buildExtractionPrompt`.

### 2.5 — Stage-entry "consult-before-derive" rule

The persona prompt must instruct the agent to consult the manifest first. Add a uniform header to every stage's `stageInstructions`:

```ts
private getStageInstructions(stage: StageDefinition): string {
  const persona = stage.persona;
  const personaPrompt = this.getPersonaPrompt(persona, stage);
  return [
    'Manifest discipline:',
    '- The feature manifest above is authoritative. If a field you would otherwise derive is already marked [final], use that value verbatim.',
    '- Do not re-justify, re-validate, or paraphrase final fields. Move on to the unset/partial fields.',
    '- If you find the manifest contradicts your reasoning, note the contradiction in `openQuestions` (don\'t silently override).',
    '',
    personaPrompt,
  ].join('\n');
}
```

### 2.6 — Bypass: planSeed already covers stages 1–4

The `planSeed` short-circuit (`pipeline-runner.ts:734-770`) already short-cuts the design stages without any LLM call. When `planSeed` is set, ALSO populate the manifest from the plan so stages 5–8 see it pre-filled:

```ts
if (this.config.planSeed) {
  this.populateManifestFromPlan(this.config.planSeed.plan);
}
```

`populateManifestFromPlan` walks the plan JSON and patches every field whose source is on the plan.

### 2.7 — Resume / re-run safety

Existing checkpoint store (`dashboard-server.ts:4843+`) keys on prompt hash. With manifest in the prefix, identical runs of the same feature will hash identically and hit the checkpoint. Re-runs after manifest mutation produce a different hash → cold call → manifest re-extraction. This is correct.

### Phase 2 acceptance

- [ ] `manifest.json` is written under `<feature>/manifest.json` after each stage that has extraction fields.
- [ ] Subsequent stages see the manifest rendered in their prompt envelope.
- [ ] An end-to-end build run produces a manifest with at least 4 fields marked `final` by the time stage 5 (build) starts.
- [ ] In a re-run of the same feature with the manifest already populated, stages 5–8 prompts are measurably shorter (instrument: log `env.variableBytes` per stage).
- [ ] `planSeed` runs populate the manifest from the plan before stage 5.
- [ ] No persona drops below previous quality (eyeball-check: have an engineer review one before-and-after pair of artifacts).

### Phase 2 rollback

Manifest store is additive. To roll back, stop calling `extractAndUpdateManifest` and pass `featureManifest: ''` to the envelope. The on-disk manifests are inert.

---

## Phase 3 — Output Token Ceiling

**Goal:** Cap how much the model is allowed to emit per stage. Stops 50KB-artifact bloat.

**Effort:** 0.5 day.

### 3.1 — Per-stage budget table

In `pipeline-runner.ts`, add:

```ts
const STAGE_OUTPUT_LIMITS: Record<string, number> = {
  clarify: 2000,
  requirements: 4000,
  'repo-requirements': 4000,
  specs: 6000,
  tasks: 8000,
  build: 16000,    // real codegen
  test: 12000,
  validate: 4000,
  ship: 2000,
};
```

Tune later from cost-ledger telemetry.

### 3.2 — Wire into adapter spawn

Where `agentManager.spawn(...)` or equivalent is called, set the ceiling on the adapter before `start()`:

```ts
adapter.setMaxOutputTokens(STAGE_OUTPUT_LIMITS[stage.name] ?? 8000);
```

Adapter implementations:

- `api-adapter.ts` — pass `max_tokens: this._maxOutputTokens` in the request body.
- `claude-adapter.ts` — pass `--max-tokens N` if the CLI supports it; otherwise no-op (CLI provides default).
- `gemini-cli-adapter.ts` — same conditional.

### 3.3 — Truncation telemetry

When a stage's output is truncated by the model (you'll see `stop_reason: 'max_tokens'` in the result for OpenAI/Anthropic), surface a warning in the dashboard. If a stage is repeatedly hitting its ceiling, raise the limit for that stage in the table.

### Phase 3 acceptance

- [ ] Every stage spawn sets `setMaxOutputTokens`.
- [ ] At least one provider (OpenAI or Anthropic) honors the ceiling end-to-end (verify by intentionally setting a tiny limit and seeing truncation).

---

## Phase 4 — Tree-Sitter Structural Code Truncation

**Goal:** Stop using `smartTruncate`'s "first 40% + last 20%" middle-cut on code. Replace with a code-aware truncator that drops function bodies but keeps signatures.

**Effort:** 1 day.

### 4.1 — Reuse existing AST tooling

`packages/cli/src/knowledge/ast-graph-builder.ts` already builds an AST graph and knows file structure. Add a sibling utility:

`packages/cli/src/knowledge/structural-truncator.ts`:

```ts
import type { CodeChunk } from './types.js';

export interface StructuralTruncateOptions {
  budgetTokens: number;
  /** Minimum signature-only fallback per file. */
  minPerFileTokens?: number;
}

/**
 * Given a long code file's chunks (already produced by the chunker), assemble
 * a token-budgeted version that:
 *   1. keeps imports
 *   2. keeps top-level signatures (function declarations, class headers)
 *   3. keeps full bodies of public/exported symbols up to budget
 *   4. drops bodies of private helpers
 *   5. emits "// [N more symbols truncated]" markers
 */
export function structurallyTruncate(
  filePath: string,
  chunks: CodeChunk[],
  opts: StructuralTruncateOptions,
): string {
  // Implementation outline:
  // a) sort chunks by symbol kind: imports > exported-fn > exported-class > exported-const > private-*
  // b) greedy-pack until budget; emit signature-only stubs for skipped exports.
  // c) drop private-* entirely beyond budget.
  // ... (concrete impl uses the chunk metadata already produced by chunker.ts)
}
```

### 4.2 — Replace `smartTruncate` callers

`packages/dashboard/server/context-budget.ts:142-155` — `smartTruncate`. Add a content-type detector:

```ts
function isCode(text: string, hint?: string): boolean {
  if (hint && /\.(ts|tsx|js|jsx|py|go|rs|java|kt|cpp|c|h|rb|swift|cs)$/.test(hint)) return true;
  // Heuristic: many lines start with `import|export|function|class|def|fn|public|private`.
  const lines = text.split('\n').slice(0, 50);
  const codey = lines.filter((l) => /^(import|export|function|class|def|public|private|const|let|var|fn |func |type )/.test(l.trim())).length;
  return codey > lines.length * 0.2;
}
```

Route code content through `structurallyTruncate`; route prose through the existing middle-cut.

### Phase 4 acceptance

- [ ] A 200-line TS file truncated to 50% budget retains imports + top-level signatures + at least one body in full.
- [ ] No regression on `prompt-budget.test.ts` and `context-budget.test.ts`.

---

## Phase 5 — Local-Model Tier (Ollama Adapter)

**Goal:** Route fast-tier stages (clarify, ship, manifest extraction) to a fully-local model. **Zero token cost** for those stages.

**Effort:** 1.5 days.

### 5.1 — Add `ollama-adapter.ts`

`packages/dashboard/server/adapters/ollama-adapter.ts`:

```ts
import { BaseAdapter, AdapterConfig, AdapterCapabilities } from './base-adapter.js';
import { spawn, ChildProcess } from 'node:child_process';

const OLLAMA_BIN = process.env.ANVIL_OLLAMA_BIN ?? 'ollama';

export class OllamaAdapter extends BaseAdapter {
  private proc: ChildProcess | null = null;

  override get capabilities(): AdapterCapabilities {
    return {
      promptCache: 'none',         // local model — no API cache
      countTokens: 'heuristic',    // optionally use llama.cpp tokenizer if available
      structuredOutput: 'best-effort',
      maxOutputTokens: true,
    };
  }

  override countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  start(): void {
    // `ollama run <model> "<prompt>"` is the simplest form;
    // the API server form is preferable for streaming:
    //   POST http://localhost:11434/api/generate
    // For parity with other adapters, start by shelling out to `ollama run`.
    this.proc = spawn(OLLAMA_BIN, ['run', this.config.model], {
      cwd: this.config.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdin?.write(this.config.prompt);
    this.proc.stdin?.end();
    // ... wire stdout/stderr → activity events, exit → result
  }

  kill(): void {
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
  }

  get pid(): number | undefined { return this.proc?.pid; }
  get killed(): boolean { return this.proc?.killed ?? false; }
}
```

Register in `adapter-factory.ts`. The factory should pick `OllamaAdapter` when `model` matches `^ollama:.*` or when the provider registry says so.

### 5.2 — Provider registry: declare the local provider

`packages/dashboard/server/provider-registry.ts` — add an `ollama` provider with weight class `'fast'` for cheap models like `qwen2.5-coder:7b`, `llama3.1:8b`. Detection: `await fetch('http://localhost:11434/api/tags')` succeeds.

### 5.3 — Model tier resolver: opt-in routing to local

`packages/dashboard/server/model-tier-resolver.ts:29-60` — extend the per-stage weight table with a fourth key `'local'` for clarify/ship:

```ts
fast: {
  clarify: 'local',  // was 'fast'
  ...
  ship:    'local',  // was 'fast'
},
```

Resolver looks up best-available `'local'` model from the discovery result; falls back to `'fast'` if no local model is available.

### 5.4 — Manifest extraction calls also route to local

The Phase 2 `runQuickExtraction` should explicitly request the local tier. If unavailable, fall back to fast tier — never the configured run model (would be wasteful).

### Phase 5 acceptance

- [ ] If `ollama serve` is running with at least one model installed, Anvil discovers it.
- [ ] When tier is `fast`, clarify and ship stages run on the local model with `cost.totalUsd === 0`.
- [ ] When Ollama is not present, runs fall back to the previous behavior with no error.

### Phase 5 rollback

Ship behind env flag `ANVIL_LOCAL_TIER_ENABLED`. Default off until Ollama detection is reliable.

---

## Phase 6 — Default-On Local Reranker

**Goal:** With the cross-encoder rerank step always enabled, top-30 retrieval results can be safely cut to top-5 with equal precision. ~6× fewer chunk tokens shipped to the model.

**Effort:** 0.5 day.

### 6.1 — Verify the slot

`packages/cli/src/knowledge/retriever.ts:59` — `private reranker: Reranker | null = null`. Already wired; we just need to default-construct one.

### 6.2 — Local Ollama reranker (no API)

If a `Reranker` impl using Ollama or a local cross-encoder doesn't exist yet, add `packages/cli/src/knowledge/local-reranker.ts`:

```ts
export interface Reranker {
  rerank(query: string, docs: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>>;
}

export class LocalCrossEncoderReranker implements Reranker {
  constructor(private model = 'bge-reranker-v2-m3') {}

  async rerank(query, docs) {
    // Option A: call Ollama (if user has bge-reranker pulled).
    // Option B: shell out to `python -m sentence_transformers ...`.
    // For minimum dependencies, use Ollama if available, fallback no-op (return docs in input order).
  }
}
```

### 6.3 — Default-on construction

Wherever `HybridRetriever` is constructed (search for `new HybridRetriever`), pass `new LocalCrossEncoderReranker()` by default unless a flag disables it.

### 6.4 — Cut top-K

After rerank is on, change retriever defaults: `maxChunks: 30 → 8` and let the reranker pick the best 5–8.

### Phase 6 acceptance

- [ ] Hybrid retrieval runs the rerank step by default.
- [ ] Manual eval: average chunks per query drops from ~30 to ~8 with no measurable accuracy regression on a fixed test set of 10 queries.

---

## Phase 7 — Similarity-Based Checkpoint Cache

**Goal:** Today the checkpoint store hits only on byte-identical prompt hash (`dashboard-server.ts:4847`). For interactive iteration, prompts change by tiny amounts (one extra word in the feature description). Add an embed-and-k-NN lookup.

**Effort:** 1.5 days.

### 7.1 — Add embedding step to checkpoint write

When a stage completes and `record(...)` runs (`dashboard-server.ts:4862-4887`), also embed the prompt and store the vector alongside the checkpoint blob.

### 7.2 — Add similarity lookup to the read path

Modify `lookup` (`dashboard-server.ts:4844-4861`):

```ts
lookup: (input) => {
  // 1. Try exact-hash hit (existing path).
  const exact = exactLookup(input);
  if (exact.hit) return exact;

  // 2. Embed input.prompt; k-NN against stored vectors with cosine ≥ 0.95.
  const queryVec = embedder.embed(input.prompt);
  const candidate = checkpointStore.nearest(input.project, queryVec, { topK: 1, threshold: 0.95 });
  if (candidate) {
    const blob = blobStore.read(candidate.outputRef);
    if (blob) return { hit: true, output: blob.toString('utf-8') };
  }
  return { hit: false };
},
```

### 7.3 — Threshold tuning

Start at 0.95. Telemetry: log when a similarity hit fires, including the cosine score and the prompt diff. After a week, eyeball-review hits that produced bad results and raise the threshold if needed.

### Phase 7 acceptance

- [ ] Re-running the same feature with a one-word edit hits the checkpoint via similarity (not exact).
- [ ] False-positive rate on a fixed eval set <5%.
- [ ] Wall-time of stage 1 (clarify) drops to <500ms on similarity hit.

### Phase 7 rollback

Behind env flag `ANVIL_CHECKPOINT_SIMILARITY_ENABLED`. Default off until threshold is calibrated.

---

## Cross-cutting: Telemetry & KPIs

Every phase needs measurement. Add to `cost-ledger.ts` (or wherever spend is recorded) and surface in the dashboard:

| Metric | Source | Phase that moves it |
|---|---|---|
| `cacheHitRatio = sum(cacheReadTokens) / sum(inputTokens + cacheReadTokens)` | Adapter result events | Phase 1 |
| `manifestFinalFieldsAtBuild` | manifest.json read at stage 5 | Phase 2 |
| `outputTruncationRate = stages with stop_reason='max_tokens' / total stages` | Adapter result events | Phase 3 |
| `localTierStageRatio = stages on local model / total stages` | tier resolver log | Phase 5 |
| `chunksPerQuery` | retriever output | Phase 6 |
| `checkpointHitRate (exact + similar)` | checkpoint hook | Phase 7 |
| `dollarsPerBuild = sum(totalUsd over a build run)` | cost-ledger | All phases |

Add a `Cost` panel in the dashboard if not already present, showing `dollarsPerBuild` over time. Without this you can't tell what's working.

---

## Validation strategy (every phase)

1. **TypeScript:** `npx tsc --noEmit -p packages/dashboard/server/tsconfig.json` — must be clean before merging the phase.
2. **Build:** `npm run build` from `packages/dashboard` — must succeed.
3. **Unit tests:** `npm run test:server` — pre-existing failures are OK; the count must not increase.
4. **Smoke:** kick off a single 8-stage build on the `pet-company` test project. Capture cost-ledger output. Compare against the pre-phase baseline saved before each phase.
5. **Phase-specific checks:** see each phase's "acceptance" section.

---

## Order of work + projected savings

| Phase | Effort | Cumulative input-cost reduction | Why |
|---|---|---|---|
| 0 | 0.5d | 0% (foundation) | Nothing ships saving until 1+. |
| 1 | 2d | 50–75% on stages 2–7 input | Prefix caching activates on every provider. |
| 2 | 3d | +20–30% on stages 5–8 input | Manifest replaces re-derivation. |
| 3 | 0.5d | +5–10% on output | Output cap. |
| 4 | 1d | +5% on stage 5+ input | Code-aware truncation. |
| 5 | 1.5d | $0 on stages 0 + 8 | Local model. |
| 6 | 0.5d | +10–20% on retrieval-heavy stages | Reranker cuts chunks. |
| 7 | 1.5d | Variable: 30–50% checkpoint hits on iteration | Similarity cache. |

**Total effort:** ~10 dev-days. **Net cost reduction expected:** **~60–80%** on input tokens for a typical 8-stage build, plus stages 0+8 free, plus iteration runs ~50% cheaper via similarity checkpoint.

---

## Files touched (summary)

**New files:**
- `packages/dashboard/server/token-util.ts`
- `packages/dashboard/server/prompt-envelope.ts`
- `packages/dashboard/server/feature-manifest.ts`
- `packages/dashboard/server/adapters/ollama-adapter.ts`
- `packages/dashboard/server/__tests__/prompt-envelope.test.ts`
- `packages/dashboard/server/__tests__/feature-manifest.test.ts` (write basic CRUD + render tests)
- `packages/cli/src/knowledge/structural-truncator.ts`
- `packages/cli/src/knowledge/local-reranker.ts`

**Modified files:**
- `packages/dashboard/server/adapters/base-adapter.ts` — add capabilities, countTokens, markCacheBreakpoint, setMaxOutputTokens
- `packages/dashboard/server/adapters/claude-adapter.ts` — implement capabilities + tokenizer
- `packages/dashboard/server/adapters/api-adapter.ts` — implement capabilities + tokenizer + max_tokens wiring
- `packages/dashboard/server/adapters/gemini-cli-adapter.ts` — implement capabilities
- `packages/dashboard/server/adapters/adapter-factory.ts` — register Ollama
- `packages/dashboard/server/pipeline-runner.ts` — `buildStagePrompt`, `buildRepoStagePrompt`, manifest hooks, output ceilings
- `packages/dashboard/server/dashboard-server.ts` — checkpoint similarity lookup; manifest store wiring
- `packages/dashboard/server/context-budget.ts` — route through token-util; structural truncate for code
- `packages/dashboard/server/prompt-budget.ts` — route through token-util
- `packages/dashboard/server/model-tier-resolver.ts` — local tier
- `packages/dashboard/server/provider-registry.ts` — Ollama detection
- `packages/cli/src/knowledge/context-assembler.ts` — route through token-util
- `packages/cli/src/knowledge/retriever.ts` — default-on reranker, smaller default top-K

---

## Failure modes to watch

1. **Cache busts after a tiny ordering change.** Any code path that mutates the stable prefix bytes (even reordering of object keys when stringified) will reset the cache. The smoke test in 1.5 catches the obvious cases; instrument `stableBytes` per call and alarm if it changes mid-run.
2. **Manifest extraction hallucinates fields.** A cheap-model extractor sometimes invents content. Mitigation: never mark `final` if confidence is low; fall back to `partial`. Have the persona prompt reject contradictions to `openQuestions`.
3. **Local model quality regression.** `qwen2.5-coder:7b` is fine for clarify but not for build. Hard-code: local tier is **only** for clarify, ship, and manifest extraction. Never for build/specs.
4. **Reranker cold start.** Ollama loads the model on first call (~5s). Pre-warm at server start.
5. **Similarity checkpoint false positives.** Tune by raising the threshold; add a "report a bad cache hit" button in the UI.

---

## Glossary for fresh implementers

- **Stage:** one of clarify, requirements, repo-requirements, specs, tasks, build, test, validate, ship.
- **Persona:** the agent role that runs a stage (clarifier, analyst, architect, lead, engineer, test-author, tester).
- **Artifact:** the markdown file a stage produces (REQUIREMENTS.md, SPECS.md, TASKS.md, etc.).
- **Manifest:** the new structured JSON file (`manifest.json`) introduced in Phase 2.
- **Envelope:** the canonical prompt layout introduced in Phase 1 (stable prefix + variable suffix).
- **Tier:** model weight class — `local`, `fast`, `balanced`, `powerful`.
- **planSeed:** an existing config option that short-cuts stages 1–4 from a pre-built plan. Don't break this.

---

## Done when

- Phases 0–7 acceptance criteria all green.
- One full build run on `pet-company` shows ≥50% reduction in `dollarsPerBuild` vs. the pre-Phase-1 baseline.
- The dashboard has a Cost panel showing `cacheHitRatio`, `manifestFinalFieldsAtBuild`, `dollarsPerBuild` over time.
- This document remains accurate; update `Files touched` with anything that drifted during implementation.
