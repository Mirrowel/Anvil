# Agent-core LLM Router — Architecture Decision Record

> Companion to [`AGENT-CORE-LLM-ROUTER-PLAN.md`](./AGENT-CORE-LLM-ROUTER-PLAN.md). Locks decisions R1–R10, persistence-site inventory, public API migration table, schema shapes, and per-phase commit log.
>
> **Status:** draft — locked at Phase 0.
> **Depends on:** `@anvil/agent-core` (shipped), `@anvil/memory-core` (shipped — SQLite primitives reused for spend ledger).

---

## 1. Pre-flight reality check (verified 2026-04-29)

| Check | Result |
|---|---|
| `packages/agent-core/src/registry.ts` exists | ✅ — `ProviderRegistry` regex routing |
| `packages/agent-core/src/fallback-adapter.ts` exists | ✅ — single `maxRetries`, fixed delay |
| `packages/agent-core/src/cost.ts` exists with vendored LiteLLM table | ✅ — `data/model-prices.json` |
| `packages/agent-core/src/telemetry/instrument.ts` wraps `ModelAdapter.run()` | ✅ — wraps below retries today |
| Per-error retry / rate-limit / spend-ledger / circuit-breaker | ❌ none of these exist |
| `~/.anvil/router/` directory does NOT exist yet | ✅ → reserved for Phase 4 spend ledger |

---

## 2. Decisions

### R1 — Module location
**Choice:** `packages/agent-core/src/router/`. `LlmRouter` sits *above* `ProviderRegistry`, *below* `instrumentModelAdapter`.
**Why:** OTel spec says retries should be sibling spans, not nested. The router decides retries, so the router's parent span must wrap the entire decision tree.

### R2 — Per-error retry policy table
**Choice:** Declarative table per `ErrorClass` (rate_limit / timeout / server_5xx / auth / content_policy / invalid_request / unknown). Defaults locked in Phase 2 §2.2.4.
**Why:** Aggressive retry on transient (429/5xx/timeout); zero on terminal (auth/content-policy/400). Matches LiteLLM Proxy + every production gateway.

### R3 — Rate limiting
**Choice:** Token-bucket per provider. In-process by default; cross-process via SQLite advisory file when `RouterConfig.rateLimit.crossProcess === true`.
**Why:** Most users run one cli; cross-process matters only when multiple parallel runs share a key. SQLite reuses memory-core's existing dep.

### R4 — Spend ledger
**Choice:** SQLite at `~/.anvil/router/spend.sqlite`. Per-tag aggregation; daily/per-run caps via `BudgetConfig`.
**Why:** Matches memory-core M1 substrate decision (no Postgres). Survives restart, queryable from cli + dashboard later.

### R5 — Route configuration
**Choice:** YAML at `~/.anvil/llm-router.yaml` with hard-coded defaults if absent. Search order: `ANVIL_ROUTER_CONFIG` env → workspace `.anvil/llm-router.yaml` → home `~/.anvil/llm-router.yaml` → compiled-in defaults.
**Why:** Same convention as agent-harness Phase 3 MCP config-loader. Users can ship config without code changes.

### R6 — Circuit breaker
**Choice:** Per-provider; closed → open → half-open. Defaults `failureThreshold=5`, `cooldownMs=30_000`, `halfOpenAttempts=1`. In-memory only (cross-process is overkill).
**Why:** Hystrix-pattern; well-trodden ground. In-memory is fine because router lifetime ≈ cli process lifetime.

### R7 — Caller dispatch
**Choice:** Tag-driven (`router.invoke({ tag: 'code-gen', ... })`). Raw `model: '<id>'` still works as a literal-pin escape hatch.
**Why:** Tags decouple "what kind of work" from "which model" — config can rebind without code change. The escape hatch keeps existing `task.model = 'claude-opus-4'` calls working.

### R8 — `FallbackAdapter` deprecation
**Choice:** Keep as a no-op shim that internally uses `LlmRouter`. Mark `@deprecated`.
**Why:** External callers (cli, dashboard) keep working. Migration is per-call-site rather than big-bang.

### R9 — Cost calculation source of truth
**Choice:** `cost.ts` with vendored LiteLLM JSON snapshot. Router invokes `calculateCostBreakdown` post-call.
**Why:** Already correct. No need to duplicate.

### R10 — OTel attributes for routing
**Choice:** New attributes — `anvil.router.route_id`, `anvil.router.attempt`, `anvil.router.error_class`, `anvil.router.fallback_index`, `anvil.router.budget_remaining_usd`, `anvil.router.circuit_breaker_state`. Each `RouteAttempt` is a child span.
**Why:** Matches OTel GenAI semantic conventions for "agent step + LLM invoke" hierarchy.

---

## 3. Persistence inventory

| Path | Purpose | Format | Phase |
|---|---|---|---|
| `~/.anvil/router/spend.sqlite` | Per-call spend ledger | SQLite (better-sqlite3) | 4 |
| `~/.anvil/llm-router.yaml` | Route config | YAML | 7 |
| `<workspace>/.anvil/llm-router.yaml` | Per-workspace override | YAML | 7 |
| `data/model-prices.json` | Cost table (already exists) | JSON snapshot of LiteLLM | unchanged |
| In-memory only | Circuit breaker state | per-process | 6 |
| In-memory or SQLite (opt-in) | Rate limit buckets | per-process default | 3 |

---

## 4. Schema shapes

(See plan §5 for full TS shapes.)

SQL DDL for the spend ledger:

```sql
CREATE TABLE IF NOT EXISTS spend (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  run_id TEXT,
  project TEXT,
  user TEXT,
  tag TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  fallback_index INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error_class TEXT,
  trace_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_spend_run ON spend(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_spend_project ON spend(project, ts);
CREATE INDEX IF NOT EXISTS idx_spend_tag ON spend(tag, ts);
CREATE INDEX IF NOT EXISTS idx_spend_provider ON spend(provider, ts);
```

---

## 5. External callers requiring migration (audit before Phase 9)

Run `git grep -n 'new FallbackAdapter\|FallbackAdapter('` and `git grep -n 'registry.resolveFromModelId'`. Expected hits:

- `packages/cli/src/pipeline/orchestrator.ts` — multiple stages instantiate adapters via registry
- `packages/cli/src/agents/*.ts` — persona-specific agent runners
- `packages/dashboard/server/agent-runner-wrapper.ts` — dashboard's parallel runner
- `packages/agent-core/src/headless/runner.ts` — headless `runAgent`

Migration: every site swaps `new FallbackAdapter([...])` for `router.invoke({ tag, ...})` plus a route in YAML. Shim absorbs callers that don't migrate.

---

## 6. Per-phase commit log

Plan ships in 11 phases (0 through 10). Updated incrementally as phases land.

| Phase | Status | Commit | Deviations |
|---|---|---|---|
| 0 — Audit + decisions | shipped | 75960d5 | — |
| 1 — Scaffold router/ + types | pending | — | — |
| 2 — Per-error retry engine | pending | — | — |
| 3 — Rate limiter | pending | — | — |
| 4 — Spend ledger | pending | — | — |
| 5 — Fallback chain + degradation | pending | — | — |
| 6 — Circuit breaker | pending | — | — |
| 7 — YAML route config | pending | — | — |
| 8 — OTel telemetry reposition | pending | — | — |
| 9 — `FallbackAdapter` shim + caller migration | pending | — | — |
| 10 — Tests + docs + ADR finalize | pending | — | — |
