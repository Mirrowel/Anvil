# Agent Process Consolidation — Before / After

> Companion to [`AGENT-PROCESS-CONSOLIDATION-ADR.md`](./AGENT-PROCESS-CONSOLIDATION-ADR.md) and [`AGENT-PROCESS-CONSOLIDATION-PLAN.md`](./AGENT-PROCESS-CONSOLIDATION-PLAN.md).
> **Date:** 2026-05-03. All 7 phases shipped on `feat/plan-generation` (commits `996f1f9` → `3555a5c`).

This document explains what changed, what got better, and what trade-offs we accepted.

---

## 1. The big picture

**Before:** Anvil had **two parallel execution paths** for running an agent.

```
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│ AgentProcess + AgentManager      │    │ Headless runAgent                │
│  (live, EventEmitter, streaming) │    │  (request → trajectory)          │
│                                  │    │                                  │
│ Used by: dashboard, cli pipeline │    │ Used by: nobody (in-tree).       │
│                                  │    │  Designed for external evals.    │
│                                  │    │                                  │
│ Knows about: cost ledger,        │    │ Knows about: skills, MCP,        │
│   checkpoint cache, sessions     │    │   Inspect-AI trajectories        │
│                                  │    │                                  │
│ Skills loaded: ❌ no             │    │ Skills loaded: ✅ yes            │
│ MCP loaded:    ❌ no             │    │ MCP loaded:    ✅ yes            │
│ Streaming UI:  ✅ yes            │    │ Streaming UI:  ❌ no             │
└──────────────────────────────────┘    └──────────────────────────────────┘
```

The mismatch was the source of every gripe:
- The dashboard couldn't pick up `.claude/skills/` even though Anvil had a skill loader.
- The cli had no way to fire a one-shot headless task (Phase 5 of the harness plan was explicitly skipped).
- `runAgent` required callers to inject a `LanguageModel`, but no agent-core adapter implemented it natively — so it wasn't actually callable from anywhere in the repo.

**After:** **One execution path.** `AgentProcess` is the single primitive; `collectTrajectory` is a thin event aggregator that produces the same Inspect-AI trajectory `runAgent` did.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ AgentProcess + AgentManager                                              │
│                                                                          │
│ defaultAdapterFactory enriches every spawn with:                         │
│   • skill system-prompt block (non-Claude paths) ✅                      │
│   • mcp.json forwarding (Claude path: --mcp-config) ✅                   │
│   • OTel attrs (anvil.skills.* / anvil.mcp.*) ✅                         │
│                                                                          │
│ Consumers:                                                               │
│   • dashboard live pipeline           → spawns directly                  │
│   • cli pipeline (run-feature, fix)   → spawns directly                  │
│   • cli `anvil run --task '...'`      → spawns directly (streaming) OR   │
│                                         collectTrajectory (--json)       │
│   • external evals (Inspect AI etc.)  → collectTrajectory(task,          │
│                                                          workspace)      │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. What got better — for each consumer

### 2.1 Dashboard

| | Before | After |
|---|---|---|
| `.claude/skills/` auto-load | ❌ never picked up | ✅ injected into projectPrompt for non-Claude; claude-cli auto-loads on Claude path |
| `mcp.json` discovery | ❌ never picked up | ✅ Claude path: `--mcp-config <path>` forwarded; non-Claude path: deferred to follow-up |
| Spawn-site code changes needed | — | **0** (workspaceDir defaults to cwd in the factory) |
| OTel session span attrs | base only | + `anvil.skills.activated.count`, `.names`, `anvil.mcp.servers.count` |
| Behavior of existing pipelines | unchanged | unchanged (skill enrichment only kicks in if `.claude/skills/` exists) |

**Impact:** Users authoring per-project skills and MCP configs see them light up across the entire dashboard pipeline with zero configuration. This was the single biggest gap before consolidation.

### 2.2 CLI

| | Before | After |
|---|---|---|
| Headless one-shot agent run | ❌ "coming soon" placeholder | ✅ `anvil run --task '<prompt>'` ships |
| Streaming output to terminal | ❌ no entry | ✅ default mode pipes content → stdout, tool activity → stderr |
| Eval-friendly JSON output | ❌ no entry | ✅ `--json` mode writes the full `AgentTrajectory` |
| Pipe to `jq` for testing | ❌ impossible | ✅ `anvil run --task '...' --json \| jq .finalAnswer` |
| Skills + MCP integration | n/a (no entry) | ✅ inherited from the spawn path |

**Impact:** The skipped Phase 5 of the harness plan is now done — and done better, because it goes through the production execution path instead of a separate runner that was never wired up.

### 2.3 External eval consumers (Inspect AI, SWE-bench, custom scripts)

| | Before | After |
|---|---|---|
| Entry point | `runAgent(task, workspace, opts)` | `collectTrajectory(task, workspace, opts?)` |
| Caller must inject `LanguageModel` | ✅ yes (and no native impl existed) | ❌ no — registry/factory/bridge handle it |
| Trajectory shape | Inspect-AI-compatible | **same** — Inspect-AI-compatible |
| Skill + MCP discovery | yes | **same** — yes (now via `defaultAdapterFactory`) |
| Production parity | ❌ separate code path | ✅ same code path the dashboard runs |
| Migration cost from old API | n/a (no in-tree callers) | one-line rename: `runAgent → collectTrajectory` |

**Impact:** Eval runs now exercise the exact same execution path users see in production. Bugs reproducible in evals are bugs reproducible in the dashboard, and vice-versa. No more "the eval shape works but production doesn't" surprises.

### 2.4 Maintainers

| | Before | After |
|---|---|---|
| Inference loops to maintain | 2 (`AgentProcess` adapter loop + `runAgent` LanguageModel loop) | 1 (`AgentProcess` adapter loop only) |
| Skill loaders to wire | 1 (in `runAgent` only) | 1 (in `defaultAdapterFactory` — covers everything) |
| MCP loaders to wire | 1 (in `runAgent` only) | 1 (in `defaultAdapterFactory` — covers everything) |
| Telemetry attrs split | maintained per-loop | maintained once at the spawn seam |
| `ModelAdapter → LanguageModel` bridge | follow-up #1 in the harness ADR | **no longer needed** for the eval path |
| Total LOC removed | — | net −556 LOC (+271 phase-1 / +601 phase-2 / +144 phase-3 / +9 phase-4 / −827 phase-5 / +230 phase-6 → −572 net) |

**Impact:** Less surface area, fewer places for skill/MCP/telemetry to drift between paths.

---

## 3. What we deliberately did *not* change

These were called out in the ADR as out-of-scope. Recording them so future work knows where to start:

1. **Per-tool source attribution (`anvil.tool.source`).** Phase 6 ships session-level skill/MCP attrs but not the per-call `gen_ai.tool.<name>` source tag. Adding it requires plumbing the MCP tool-name set into `LanguageModelBridge.openToolSpan`. Self-contained future change.
2. **MCP tool merging into the non-Claude bridge.** Today only Claude-path agents see MCP-discovered tools (via `--mcp-config`). Letting Ollama / OpenRouter / OpenCode call MCP tools would require extending `BuiltinToolExecutor` (or wrapping it) to route by namespace prefix `<server>/<tool>`. Held back to keep this consolidation tight.
3. **CLI test coverage for `anvil run`.** The cli has no `node:test` runner today (its `test` script is a `console.log` placeholder). Adding even smoke tests for the streaming + JSON modes needs that infrastructure first.
4. **`anvil.mcp.tools.count` attribute.** Currently absent because `loadMcpServers` only reads the config file; counting tools means connecting to each server. The natural place to set it is wherever a future Phase-7 wires MCP into the non-Claude bridge via `buildAgentToolset`.

---

## 4. Test coverage gained

| Surface | Tests | What they verify |
|---|---|---|
| `enrichRequestWithWorkspace` | 5 | Skill block injected (non-Claude); `claudeMcpConfigPath` resolved (Claude); allowed-tools narrowed; back-compat when no workspaceDir; no skill block on Claude path |
| `collectTrajectory` | 6 | Happy path; tool-use loop; usage incl. cache tokens; abort signal; timeout; listener-ordering regression |
| Spawn telemetry | 3 | Skills attrs surface on active span; absent when no skills load; MCP server count surfaces |
| **Total new** | **14** | |

Plus the deletion of `runAgent.test.ts` (4 tests) which was testing a different surface.

agent-core's `node --test` baseline: **390 tests** (pre-consolidation) → **383 tests** (post-consolidation). The −7-test delta is the 4 deleted runAgent tests + 3 sub-tests it had. The 14 new tests live in `agent/session/__tests__/`.

---

## 5. Migration touchpoints (for anyone with external code)

If you imported anything from `@anvil/agent-core/headless`, the migration is one rename:

```ts
// Before
import { runAgent } from '@anvil/agent-core';
const trajectory = await runAgent(task, workspace, {
  model: myLanguageModel,         // had to inject
  builtInTools, builtInDispatch,  // had to wire
  maxToolLoopIterations: 25,
  timeoutMs: 600_000,
});

// After
import { collectTrajectory } from '@anvil/agent-core';
const trajectory = await collectTrajectory(task, workspace, {
  timeoutMs: 600_000,             // optional
  signal: ac.signal,              // optional
});
// trajectory shape is unchanged
```

The trajectory's fields (`messages`, `toolCalls`, `model`, `usage`, `costUsd`, `finalAnswer`, `finishReason`, `error`, `durationMs`) are byte-compatible with what `runAgent` produced.

Type imports also keep working — `AgentTask`, `AgentTrajectory`, `WorkspaceConfig`, etc. now ship from `agent/session/headless-types.ts` and re-export through the package barrel.

---

## 6. The one trade-off worth understanding

`collectTrajectory` exposes a `Promise<AgentTrajectory>` — it materialises the trajectory **after** the run finishes. That's by design: external evals want a structured artefact, not a stream of events.

If a future consumer wants both — *streaming events AND a final trajectory* — they have two options:

1. **Use `AgentProcess` directly.** It's the same primitive `collectTrajectory` wraps; consumers that need live events drive it themselves. The dashboard does this today.
2. **Add an `onEvent` hook to `collectTrajectory`.** A 5-line addition: take an optional callback that receives each `content` / `activity` / `result` event before the aggregator processes it. Not needed today, but the design supports it.

This is the same trade-off the original "live vs. headless" two-path system encoded — except now the underlying execution is shared, so behaviour can't drift.

---

## 7. Where to read more

- **Decisions:** [`AGENT-PROCESS-CONSOLIDATION-ADR.md`](./AGENT-PROCESS-CONSOLIDATION-ADR.md)
- **Phase plan + commit log:** [`AGENT-PROCESS-CONSOLIDATION-PLAN.md`](./AGENT-PROCESS-CONSOLIDATION-PLAN.md) and ADR §7
- **Original (now-superseded) harness plan:** [`AGENT-HARNESS-PLAN.md`](./AGENT-HARNESS-PLAN.md) — banner updated to point here
- **Module/flow diagrams:** `packages/agent-core/ARCHITECTURE.md` §7, `packages/agent-core/FLOW.md` §4
- **Public API:** `packages/agent-core/README.md` — "Agent harness" section rewritten to reflect the new entry points
