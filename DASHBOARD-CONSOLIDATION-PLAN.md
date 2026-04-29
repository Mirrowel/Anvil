# Dashboard Consolidation Plan

> Companion to [`DASHBOARD-CONSOLIDATION-ADR.md`](./DASHBOARD-CONSOLIDATION-ADR.md). Locks decisions, parallel-impl inventory, public API migration table, and per-phase commit log.
>
> **Status:** draft 2026-04-29.
> **Depends on:** `@anvil/agent-core` (shipped), `@anvil/memory-core` (shipped), `@anvil/knowledge-core` (shipped — graph imports re-wired in `b103dae`), `@anvil/core-pipeline` (shipped through Phase 9).

---

## 1. Pre-flight reality check (verified 2026-04-29)

| Check | Result |
|---|---|
| `packages/dashboard/server/dashboard-server.ts` exists, **6,601 LOC** | ✅ |
| `packages/dashboard/server/pipeline-runner.ts` exists, **3,315 LOC** — own orchestrator, parallel to cli's | ✅ |
| Knowledge-core dynamic imports re-wired (b103dae) | ✅ — graph build works again |
| Dashboard imports from `@anvil/agent-core`, `@anvil/memory-core`, `@anvil/core-pipeline` | ❌ — **zero imports** |
| Dashboard's `adapters/{base,claude,gemini-cli,api}-adapter.ts` (~600 LOC) duplicate agent-core's adapter family | ✅ |
| Dashboard's `cost-{ledger,pricing,types,breach-handler,breach-sweeper}.ts` (~900 LOC) overlap agent-core's SpendLedger | ✅ — different storage (NDJSON vs SQLite), similar concept |
| Dashboard's `memory-store.ts` (329 LOC) is a Hermes-style markdown text store | ✅ — **will be replaced** by memory-core façade (D6 flipped 2026-04-29) |
| Dashboard's `pipeline-learner.ts` (139 LOC) parallels cli's dead `autoLearnHook` | ✅ |
| Dashboard reads `~/.anvil/state.json` to observe pipeline state (file-polling) | ✅ — no in-process bus subscription |
| 133 WebSocket message types handled by `dashboard-server.ts` | ✅ |

**Coupling shape today:**
- Dashboard server is a **second orchestrator**, not a consumer. `pipeline-runner.ts` runs its own 8-stage pipeline with per-repo parallelism, FeatureStore manifests, plan-risk scoring, engineer-task bundling — features cli's orchestrator doesn't have and core-pipeline's walker doesn't replicate yet.
- Dashboard's adapter family (claude/gemini-cli/api) has its own `BaseAdapter` (EventEmitter), `AdapterCapabilities`, `AdapterCostInfo` — **shape differs** from agent-core's `LanguageModel` / `ProviderCapabilities` / `InvokeUsage`.
- Cross-process pipeline state lives in `~/.anvil/state.json` (cli writes, dashboard reads). Polled, not pushed.

**Total in-scope LOC** across dashboard server's parallel impls: **~6,000 LOC** (adapters 600 + cost ~900 + pipeline-runner 3,315 + agent-manager 444 + agent-process 120 + memory-store 329 + pipeline-learner 139 + audit-log 227 + approval-tokens 143).

---

## 2. Why this isn't a one-shot rewrite

The dashboard's `pipeline-runner` is **not** a duplicate of cli's orchestrator — it has features cli doesn't:

- per-repo parallel agents (cli's orchestrator runs serial; the only parallelism today is `parallel-runner.ts` for stages 2–4)
- FeatureStore + FeatureManifestStore (`feature-manifest.ts`) — typed artifact ledger with extractors for AcceptanceCriteria, ApiEndpoints, FilesPlanned, TestBehaviors, etc.
- Plan-risk scoring (`plan-risk-scorer.ts`)
- Engineer-task-bundler (`engineer-task-bundler.ts`)
- Interactive clarify via WebSocket userMessages (cli's orchestrator uses readline)
- Per-stage cost-budget enforcement via CostBreachHandler

A naive "delete dashboard's orchestrator, use core-pipeline" loses all of this. The plan therefore focuses on **lifting these features into Steps** (so they become reusable across cli + dashboard) rather than collapsing the dashboard's runner into thin shims.

The agent adapter consolidation, by contrast, is naturally a swap — both impls cover the same conceptual surface, only the contract shape differs. Same for cost-ledger ↔ spend-ledger.

---

## 3. Decisions (deferred to ADR)

The full decision matrix lives in `DASHBOARD-CONSOLIDATION-ADR.md`. Headlines:

- **D1** — Dashboard becomes a **consumer** of `@anvil/agent-core`, `@anvil/core-pipeline`, `@anvil/memory-core`. No code moves into the dashboard package.
- **D2** — Adapter contracts unify on agent-core's `LanguageModel`. Dashboard's `BaseAdapter` (EventEmitter) gets a thin shim that adapts a `LanguageModel` into the dashboard's existing event-emit surface — preserves AgentManager / AgentProcess wiring.
- **D3** — Dashboard subscribes to `core-pipeline`'s `EventBus` directly (in-process when the same process runs both, file-tailed otherwise). State-file polling is kept as a fallback for cross-process deployments.
- **D4** — Dashboard's `cost-ledger` (NDJSON) and `agent-core`'s `SpendLedger` (SQLite) **stay separate** for now; we add an adapter so cost data flows in both directions. Merging the storage layers is a follow-up plan.
- **D5** — Dashboard's `pipeline-runner.ts` features (FeatureStore, manifests, risk scoring, task bundling, per-repo parallelism) lift into core-pipeline `Step` implementations under `packages/core-pipeline/src/steps/dashboard/` — usable from cli once they're hoisted.
- **D6** — Dashboard's `memory-store.ts` (Hermes-style markdown) is **replaced** by a thin façade over `@anvil/memory-core`. The 5 consumed methods (`add`, `replace`, `remove`, `getEntriesWithMeta`, `formatForPrompt`) keep their signatures; storage swaps from per-project markdown files to memory-core's SQLite + namespaces. Existing markdown files are imported once on first launch via memory-core's `migrate/` helper, then archived to `~/.anvil/memories/_archive_<ts>/`.
- **D7** — Dashboard's `pipeline-learner.ts` becomes a `learners.hook` subscriber on the core-pipeline bus. Replaces cli's dead `autoLearnHook` for dashboard-driven runs.
- **D8** — **No feature flags.** Each phase is a full cutover; legacy code is deleted in the same PR that lands the replacement. Phases are sequential, independently revertable, and merged after parity testing on the release branch. The running system never carries dual code paths.
- **D9** — No new shared package. All consolidation lands in existing packages (`@anvil/agent-core`, `@anvil/core-pipeline`).
- **D10** — The dashboard's WebSocket message protocol stays unchanged. All 133 message types must keep their existing payload shapes through the migration.

---

## 4. Public API migration table

| Surface | Today | After |
|---|---|---|
| `dashboard/server/adapters/*Adapter` | local impls | thin shims wrapping `agent-core` `LanguageModel`s |
| `dashboard/server/agent-runner-wrapper.ts` (checkpoint cache) | local | unchanged — orthogonal to model invocation |
| `dashboard/server/cost-ledger.ts` | NDJSON file ledger | unchanged shape; gains a sync adapter to/from `agent-core/router/SpendLedger` |
| `dashboard/server/pipeline-runner.ts` | 3,315-LOC monolith | thin caller — registers Steps + hooks, calls `core-pipeline` `Pipeline.run()` |
| `dashboard/server/pipeline-audit-log.ts` | local JSONL | replaced by `attachAuditLogHook` from core-pipeline |
| `dashboard/server/pipeline-learner.ts` | local | replaced by `attachLearnersHook` from core-pipeline |
| `dashboard/server/memory-store.ts` (`MemoryStore`) | local markdown files | thin façade over memory-core SQLite + namespaces — same method shapes |
| `~/.anvil/memories/<project>/{MEMORY,USER}.md` | source of truth | one-shot import source; archived under `_archive_<ts>/` after Phase 5 |
| `dashboard/server/feature-store.ts`, `feature-manifest.ts` | local | unchanged externally; consumed by Steps via `ctx.artifacts` + `ctx.emit` |
| `dashboard-server.ts` 133 msg types | unchanged | unchanged (D10 invariant) |
| `~/.anvil/state.json` polling | primary read path | secondary; bus subscription is primary in-process |

---

## 5. Schema shapes

No new schemas — all the contracts already exist:
- `LanguageModel` / `ProviderCapabilities` / `InvokeResult` in `@anvil/agent-core/types.ts`
- `Step<I, O>` / `EventBus` / `PipelineEvent` in `@anvil/core-pipeline/types.ts`
- `SpendRow` in `@anvil/agent-core/router/spend-ledger.ts`
- `Memory<T>` / `MemoryNamespace` / `MemoryKind` in `@anvil/memory-core/types.ts`; storage via `SqliteHotIndex`

The plan's job is to **wire** these into the dashboard, not to design new ones.

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 What changes
Lock D1–D10 in `DASHBOARD-CONSOLIDATION-ADR.md`. Snapshot the dashboard's parallel-impl inventory + WebSocket message-type list. Identify which dashboard messages depend on each parallel impl (so each phase's migration can be scoped to a subset of messages).

### 0.2 Acceptance
- [ ] ADR with D1–D10, each with one-line `Why`
- [ ] Parallel-impl inventory: file path, LOC, primary consumers
- [ ] WebSocket message ↔ parallel-impl dependency map (which messages break if a phase regresses?)

### 0.3 Rollback
Revert the ADR commit.

---

## Phase 1 — agent-core adapter consolidation

**Effort:** 2d.

### 1.1 What changes
Dashboard's `adapters/{claude,gemini-cli,api}-adapter.ts` are deleted and replaced by thin shims that wrap `agent-core`'s `LanguageModel` instances and re-emit dashboard's existing `BaseAdapter` event shape. Net effect: dashboard's `AgentManager` / `AgentProcess` keep their event-emit interface; all model invocation now runs through agent-core (and therefore through the LLM router, retry policy, spend ledger, OTel routing spans).

### 1.2 Procedure
1. New `packages/dashboard/server/adapters/agent-core-bridge.ts` — accepts a `LanguageModel`, returns a `BaseAdapter`-compatible event emitter. Maps `InvokeUsage` → `AdapterCostInfo`, `StreamEvent` → dashboard's text/tool-use events.
2. `adapters/adapter-factory.ts` rewritten: it now resolves a `LanguageModel` from `agent-core`'s `ProviderRegistry` and returns a bridge instance. Old heuristic-routing branches are deleted.
3. Dashboard's `AdapterCapabilities` (promptCache/countTokens/structuredOutput) maps to `ProviderCapabilities` via a translation table.
4. Add `@anvil/agent-core` to `packages/dashboard/package.json` deps (workspace symlink already wired through root install).
5. Delete `claude-adapter.ts`, `gemini-cli-adapter.ts`, `api-adapter.ts`, and any unused fields from `base-adapter.ts` in the same PR.
6. Tests: existing dashboard adapter test fixtures run unchanged through the shim.

### 1.3 Acceptance
- [ ] Dashboard's 4 WebSocket agent-related messages (`run-agent`, `cancel-agent`, `agent-status`, `agent-output`) work end-to-end on the phase branch
- [ ] Cost summary in dashboard UI matches a recorded baseline run (within $0.0001)
- [ ] Branch parity: dashboard fixture run on `main` vs phase branch produces identical WebSocket transcripts (modulo timestamps + costs)
- [ ] `npm test` cli + core-pipeline + dashboard all green

### 1.4 Risks
- **Capability mismatch:** dashboard tests for `promptCache === 'explicit'` for prompt-envelope optimizations; agent-core's `ProviderCapabilities` doesn't carry that bit. Mitigation: add an optional `cache: 'auto' | 'explicit' | 'none'` to `ProviderCapabilities` (additive change).

---

## Phase 2 — core-pipeline EventBus subscription

**Effort:** 1.5d.

### 2.1 What changes
Dashboard subscribes to the core-pipeline `EventBus` directly for in-process pipeline runs (when `dashboard-server.ts` spawns the pipeline itself). The state-file polling path (`~/.anvil/state.json`) is kept solely for cross-process observation (e.g. cli runs from a separate terminal) and stays read-only. There is no flag — bus subscription is the primary path whenever the dashboard owns the run; polling is the fallback whenever it doesn't.

### 2.2 Procedure
1. New `packages/dashboard/server/pipeline-bus-subscriber.ts` — exposes `attachToBus(bus, channels)` that translates core-pipeline `PipelineEvent`s into the dashboard's existing WebSocket message payload shapes (D10 invariant).
2. `dashboard-server.ts` constructs an `InMemoryEventBus`, attaches the subscriber + the four hooks (audit, dashboard-state, cost-tracker, learners) via `attachAuditLogHook` etc.
3. The dashboard's pipeline-spawn path now constructs a `Pipeline` from core-pipeline and runs it; `pipeline-runner.ts`'s legacy in-process orchestration is removed in Phase 4 (the bus wiring lands here so Phase 4 has it ready).
4. State-file polling code stays in place as the cross-process fallback; it is exercised when no in-process bus is attached.

### 2.3 Acceptance
- [ ] `pipeline-status` / `stage-start` / `stage-complete` / `stage-fail` WebSocket messages fire identically to the saved baseline (parity diff on the phase branch)
- [ ] No regression in 133-message protocol: all msg types still respond
- [ ] Bus subscriber tested in isolation (mocked bus + fake WebSocket)
- [ ] Cross-process polling path exercised by an integration test that spawns the cli in a child process

### 2.4 Risks
- **Event-payload drift:** dashboard messages expect specific fields (`stage: number`, `stageName: string`); core-pipeline's `PipelineEvent` carries `stepId: string`. Mitigation: subscriber maintains a `stepId → stageIndex` lookup table.
- **Subscriber back-pressure:** WebSocket broadcast can be slow. Mitigation: use `bus.emitFireAndForget` for dashboard updates, awaited `emit` only for ordering-sensitive hooks (audit).

---

## Phase 3 — Cost-ledger ↔ spend-ledger bridge

**Effort:** 1d.

### 3.1 What changes
Dashboard's `CostLedger.record()` calls now also invoke `agent-core/router/SpendLedger.record()`, and vice versa. Storage stays separate (NDJSON for dashboard, SQLite for agent-core's router) per D4. Single source of truth via either store; reads from the dashboard UI continue to query `CostLedger`, reads from cli `anvil-loc cost summary` continue via `SpendLedger`.

### 3.2 Procedure
1. New `packages/dashboard/server/cost-bridge.ts` — wraps `CostLedger` so each `record()` also writes a `SpendRow`. Field mapping: dashboard's `CostStage` → router's `tag`, dashboard's `provider` / `model` → router's same fields.
2. CLI side: `agent-core/router` gains an optional `onRecord` hook so a future cli-side bridge can mirror writes back into NDJSON if needed.
3. No flag — the bridge is always on (additive).

### 3.3 Acceptance
- [ ] Every `CostLedger.record()` produces a matching `SpendRow` (verified via test that runs both stores side-by-side)
- [ ] Daily summary tools on both sides agree to within $0.0001

### 3.4 Risks
- **ID collisions:** dashboard generates `${ts}-${rand}`; router uses ULIDs. Mitigation: bridge maps IDs explicitly (no shared keyspace assumed).

---

## Phase 4 — Lift dashboard pipeline-runner features into Steps

**Effort:** 5d (split: per-repo parallelism 1d, FeatureStore Step 1d, plan-risk Step 0.5d, task-bundler Step 0.5d, interactive-clarify Step 1d, integration 1d).

### 4.1 What changes
The dashboard's pipeline-runner.ts (3,315 LOC) gets decomposed into `Step<I, O>` implementations under `packages/core-pipeline/src/steps/dashboard/`. Each Step is registered into a custom registry that the dashboard builds at run start. The dashboard's `pipeline-runner.ts` becomes a thin coordinator: build the registry, attach hooks, call `Pipeline.run()`, broadcast WebSocket events from the bus subscriber (Phase 2).

### 4.2 Procedure (per-Step, in order)
1. **Per-repo parallel runner Step** — lift from `pipeline-runner.ts:runPerRepoStage()`. Fans `Step.run()` across repos, threading per-repo input/output. New: `Step.parallelism: 'per-repo'` (companion to today's `'per-project'`).
2. **FeatureStore Step** — wraps `FeatureStore` + `FeatureManifestStore` calls into a `Step` that emits the feature-manifest artifact. The 7 manifest extractors (`extractAcceptanceCriteria`, `extractApiEndpoints`, etc.) become helpers on the Step's input.
3. **Plan-risk-scorer Step** — `scorePlan()` + `computeRiskTier()` lift into a Step that emits `PLAN-RISK.json`.
4. **Engineer-task-bundler Step** — `parseTasks()` + `groupTasksForExecution()` lift into a Step that emits `TASK-BUNDLES.json`.
5. **Interactive-clarify Step** — dashboard variant that uses WebSocket userMessages instead of cli's readline. Lands as a separate Step (registered by the dashboard, replacing the cli's clarify Step in the dashboard's registry) — keeps the cli's readline path untouched.
6. **Cost-budget Step** — `CostBreachHandler` becomes a hook subscriber (priority 30) instead of inline calls in pipeline-runner.

### 4.3 Acceptance
- [ ] Dashboard fixture pipeline run produces identical artifacts (FEATURE-MANIFEST.json / PLAN-RISK.json / TASK-BUNDLES.json) before/after
- [ ] WebSocket message ordering is identical (same `pipeline-status` cadence)
- [ ] `pipeline-runner.ts` shrinks from 3,315 LOC to ≤ 300 LOC (registry build + Pipeline.run call + WebSocket broadcast loop)

### 4.4 Risks
- **Hidden state in pipeline-runner.ts:** 3,315 LOC has accreted edge-case handling (resume logic, partial-failure recovery, stage skipping per project config). Mitigation: branch-level parity testing — run the dashboard fixture pipeline on `main` and the phase branch, diff the WebSocket transcript + audit JSONL + emitted artifacts byte-for-byte. Hold the merge until the diff is empty (modulo timestamps + costs).
- **Per-repo parallelism semantics:** dashboard's runner has bespoke fanout. Mitigation: Step 1 above lands as a typed addition to core-pipeline's walker, not as a one-off.
- **Single-PR blast radius:** with no flag, a regression that ships hits every dashboard user at once. Mitigation: this is Phase 4 of 6 — earlier phases are smaller cutovers that build confidence in the bus + bridge stack before the big lift; Phase 6 doesn't merge until Phase 4 has cooked on the release branch.

---

## Phase 5 — MemoryStore → memory-core replacement

**Effort:** 3d (split: namespace+kind mapping 0.5d, façade rewrite 1d, one-shot importer 0.5d, call-site migration + WS handler check 0.5d, integration + smoke 0.5d).

### 5.1 What changes
Dashboard's `memory-store.ts` is replaced by a façade over `@anvil/memory-core`. The class keeps its 5-method surface (`add`, `replace`, `remove`, `getEntriesWithMeta`, `formatForPrompt`) so the ~15 call sites in `dashboard-server.ts`, `pipeline-runner.ts`, and `pipeline-learner.ts` need no signature changes. Storage swaps from per-project `~/.anvil/memories/<project>/{MEMORY,USER}.md` files to memory-core's SQLite + namespace API. Existing markdown is imported once on first launch.

### 5.2 Procedure
1. **Add `@anvil/memory-core` to `packages/dashboard/package.json`** deps (workspace symlink).
2. **Namespace + kind mapping** — pick a deterministic mapping:
   - Namespace: `{ scope: 'project', project: <projectName>, branch: undefined }` per memory-core's `MemoryNamespace` shape.
   - `target: 'memory'` → `MemoryKind = 'semantic'` with subtype `'fact'`.
   - `target: 'user'` → `MemoryKind = 'semantic'` with subtype `'preference'`.
   - Document the mapping in `packages/dashboard/server/memory-store.ts` header comment.
3. **Rewrite `memory-store.ts` as a façade** —
   - Constructor takes optional `anvilHome`; instantiates `SqliteHotIndex` against `~/.anvil/memory-core.sqlite` (memory-core's standard path).
   - `add(project, target, content)` → `SqliteHotIndex.write({ namespace, kind, subtype, body, addedAt })`.
   - `replace(project, target, oldText, content)` → search by `body` match, write replacement, soft-delete old.
   - `remove(project, target, oldText)` → soft-delete by body match.
   - `getEntriesWithMeta(project, target)` → `SqliteHotIndex.list({ namespace, kind })` mapped to `{ content, addedAt }[]`.
   - `formatForPrompt(project, target)` → BM25 search via `bm25Search` (recency-weighted) → joined with the existing `\n§\n` delimiter and char-limit truncation rules.
4. **One-shot importer** — on first construction, scan `~/.anvil/memories/<project>/{MEMORY,USER}.md`; if any exist AND no rows exist yet for that namespace, parse entries (preserving each entry's `<!-- added:ISO -->` header) and bulk-insert into memory-core. Then `mv ~/.anvil/memories ~/.anvil/memories_archive_<ISO>/` so a re-run is idempotent.
5. **Call-site audit** — confirm none of the ~15 sites depend on synchronous file behavior. memory-core's `SqliteHotIndex` is sync (better-sqlite3) so signatures stay sync-compatible.
6. **WebSocket handler check** — D10 invariant. The 3 memory-related messages (`memory:add`, `memory:replace`, `memory:remove`) plus the memory list snapshot (rendered via `getEntriesWithMeta`) keep their existing payload shapes. Add a transcript-comparison test against a saved baseline.
7. **Cutover** — the rewritten `memory-store.ts` replaces the original in the same PR. No legacy fork, no flag. The original markdown-backed impl is recoverable from git history if Phase 5 needs to be reverted.
8. **Char-limit semantics** — the markdown impl rejects writes that overflow `MEMORY_CHAR_LIMIT=4000` / `USER_CHAR_LIMIT=2000`. The façade preserves these as soft caps via `formatForPrompt` truncation, **not** as write rejections (memory-core has no equivalent rejection path). Document the behavior change in the dashboard README.

### 5.3 Acceptance
- [ ] All ~15 `memoryStore.*` call sites compile + pass on the phase branch
- [ ] One-shot import: a fixture project with seeded MEMORY.md/USER.md migrates cleanly; re-running is a no-op
- [ ] WebSocket transcript for `memory:add` / `memory:replace` / `memory:remove` matches the saved baseline byte-for-byte
- [ ] `formatForPrompt` produces identical-or-better content (manual review on 3 fixtures)
- [ ] cli + dashboard both read the same memory entries (write through dashboard, read via `anvil-loc memory list <project>`)
- [ ] `npm test` cli + core-pipeline + memory-core + dashboard all green

### 5.4 Risks
- **Recency ordering:** markdown impl orders by file position (write order); memory-core's SQLite uses `addedAt`. Mitigation: import preserves `addedAt` from each entry's header; new writes use `now()`.
- **Char-limit drift:** legacy rejects writes > limit; façade soft-truncates at read. Mitigation: log a `warn` event on first overflowing write so we notice if the soft cap matters in practice.
- **Cross-process locks:** SQLite write contention if cli + dashboard write concurrently. better-sqlite3 uses `WAL` mode; this is a non-issue but verify in the integration test (parallel write loop from both processes).
- **Dropped dedup:** legacy `readRawEntries` dedupes via `Set<string>`. Mitigation: importer dedupes; runtime writes don't dedup (callers are responsible). Document the change.

### 5.5 Rollback
`git revert` the Phase 5 PR. The reverted `memory-store.ts` reads from the archived markdown files (`~/.anvil/memories_archive_<ts>/`) — a tiny restore script in the revert commit moves them back to `~/.anvil/memories/`. memory-core SQLite rows are left in place (orphaned but harmless) for forensic inspection.

---

## Phase 6 — Tests + docs + ADR finalize

**Effort:** 1d.

### 6.1 What changes
Coverage push: ≥ 30 new tests across `packages/dashboard/server/__tests__/` + `packages/core-pipeline/src/__tests__/dashboard-steps/`. README updates in `packages/dashboard/README.md` documenting the consolidation. ADR §6 finalized with commit hashes. End-to-end smoke run on the release branch produces identical artifacts to a recorded baseline before tagging the release.

### 6.2 Acceptance
- [ ] Bridge tests (Phase 1 / 3) pass
- [ ] Bus subscriber tests (Phase 2) pass
- [ ] Each new dashboard Step (Phase 4) has a unit test
- [ ] memory-core façade tests (Phase 5) pass: importer + 5 ops + WebSocket transcript parity
- [ ] `dashboard-server.ts` has an integration test exercising at least one end-to-end pipeline run end-to-end
- [ ] Release-branch smoke: full dashboard fixture pipeline produces identical WebSocket transcript + audit JSONL + cost ledger to the pre-Phase-1 baseline
- [ ] README explains the consolidation status and the markdown→sqlite migration

---

## Cross-cutting validation strategy

Before each phase's PR merges into the release branch:

1. `npm install`
2. `tsc -b` from root
3. Per-package: `npm -w <name> run build && npm -w <name> test`
4. Dashboard server smoke: `npm -w @anvil-dev/dashboard run build && node packages/dashboard/server/dashboard-server.js --self-test`
5. **Branch parity diff:** trigger one fixture pipeline through the dashboard on the release-branch HEAD AND on the same-base from `main`; compare the WebSocket transcript, audit JSONL, and cost ledger output. Merge only when the diff is empty (modulo timestamps + provider-side cost noise).
6. Tag the release only after Phase 6 lands and the full release-branch smoke passes.

---

## Cross-cutting order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit | Lock decisions + impact map before code |
| 1 | Adapter consolidation | Smallest concrete win; gates the LLM router on dashboard runs |
| 2 | Bus subscription | Replaces state-file polling; unblocks Phase 4 |
| 3 | Cost-ledger bridge | Cheap; ensures Phase 4's cost-budget Step has a single ledger |
| 4 | pipeline-runner lift | The big one; depends on 1–3 |
| 5 | MemoryStore → memory-core | Last consumer-side surface to consolidate; runs after pipeline-runner so learners.hook writes through the new façade |
| 6 | Tests + docs | Standard close-out; release-branch smoke + tag |

**Total effort:** ~14d. **Total LOC delta:** dashboard server shrinks by ~3,300 LOC (+329 from memory-store removal); core-pipeline grows by ~1,500 LOC of new Steps; memory-core unchanged (façade lives in dashboard); net –1,800 LOC across the repo.

---

## Out of scope / known follow-ups

1. **Cost-ledger storage merge:** keeping NDJSON + SQLite separate for now (D4). A future plan can collapse into one if both sides converge on SQLite.
2. **`AgentManager` / `AgentProcess` rewrite:** the checkpoint wrapper at `agent-runner-wrapper.ts` is orthogonal to model invocation; it stays as-is. A future plan could move the checkpoint primitives into a shared `@anvil/checkpoint-core` if cli ever grows the same need.
3. **Cross-process pub/sub:** today's bus subscription is in-process only. Cross-process deployments still tail `state.json`. Adding a broker (Redis, NATS) is explicitly out per memory-core M1.
4. **Dashboard's React UI consolidation:** unaffected by this plan. A future plan can replace dashboard's React client with cli-bundled tooling if needed.
5. **`anvil-loc dashboard` command:** unifying the CLI launcher for the dashboard server is unrelated; this plan changes only the server-side internals.
