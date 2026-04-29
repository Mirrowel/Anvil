# `@anvil/core-pipeline`

Typed `Step<I, O>` graph + EventBus + StepRegistry + lifecycle hooks for the Anvil pipeline. Decouples pipeline orchestration from cli's monolithic `orchestrator.ts` if-tree, so future tooling (dashboard servers, CI runners, alternate front-ends) can drive the same pipeline shape.

> Status: shipped through Phase 8. The cli's `orchestrator.ts` if-tree is still the default execution path; the new walker is gated behind `ANVIL_USE_NEW_PIPELINE=1`. See [`CORE-PIPELINE-EXTRACT-ADR.md`](../../CORE-PIPELINE-EXTRACT-ADR.md) for rollout decisions.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Pipeline runner                              │
│                                                                      │
│   for step in registry.steps():                                      │
│     bus.emit('step:started', { stepId })                             │
│     [run subSteps] → step.run(ctx) [with retryPolicy]                │
│     bus.emit('step:completed' | 'step:failed', ...)                  │
└──────────────────────────────────────────────────────────────────────┘
            ▲                                          │
            │ subscribes (priority-ordered)            │ writes via ctx.emit
            │                                          ▼
   ┌───────────────────┐                   ┌───────────────────────┐
   │  audit-log hook   │ p=100             │ InMemoryArtifactStore │
   │  learners hook    │ p=50              │ (read by downstream    │
   │  cost-tracker     │ p=20              │  Steps via ctx.artifacts)
   │  dashboard-state  │ p=10              └───────────────────────┘
   └───────────────────┘
```

- **Pipeline** walks the StepRegistry, threading each Step's output into the next Step's `ctx.input`.
- **EventBus** is the single in-process pub/sub seam. `emit` awaits all listeners (for ordering-sensitive paths); `emitFireAndForget` is for non-critical updates.
- **StepRegistry** supports `register / insertBefore / insertAfter / replace / remove` — plugins compose by ID, not by index.
- **Hooks** are subscribers; the four built-in hooks reproduce the cross-cutting concerns the cli orchestrator inlines today.

---

## Quick start

```ts
import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  attachAuditLogHook,
  attachDashboardStateHook,
  attachCostTrackerHook,
  attachLearnersHook,
  type Step,
} from '@anvil/core-pipeline';

const bus = new InMemoryEventBus();
const registry = new InMemoryStepRegistry();

attachAuditLogHook(bus, { path: '/tmp/audit.jsonl' });
attachDashboardStateHook(bus, { path: '/tmp/state.json' });
const cost = attachCostTrackerHook(bus);
attachLearnersHook(bus, {
  project: 'my-project',
  onLearnEvent: (event) => myLearner(event),
});

const clarify: Step<{ feature: string }, { artifact: string }> = {
  id: 'clarify',
  run: async (ctx) => {
    ctx.emit('CLARIFICATION.md', `# ${ctx.input.feature}`);
    return { artifact: `# ${ctx.input.feature}` };
  },
};
registry.register(clarify as Step<unknown, unknown>);

const result = await new Pipeline({
  bus,
  registry,
  runId: 'run-001',
  workspaceDir: process.cwd(),
  initialInput: { feature: 'multi-tenant-billing' },
}).run();

console.log(result.status, '- spent', cost.totals().costUsd, 'USD');
```

---

## `Step<I, O>` contract

```ts
interface Step<I, O> {
  id: string;
  name?: string;
  run(ctx: StepContext<I>): Promise<O>;

  // Optional sub-step composition (Phase 7).
  subSteps?: Step<unknown, unknown>[];

  // Optional retry policy: transient failures retry up to `attempts`
  // times with exponential / linear / constant backoff.
  retryPolicy?: {
    attempts: number;
    backoff: 'exponential' | 'linear' | 'constant';
    baseMs: number;
    maxMs?: number;
    retryOn?: (error: unknown) => boolean;
  };

  // Per-project parallelism hint — `'per-project'` lets a future
  // walker fan out across project entries.
  parallelism?: 'serial' | 'per-project';
}

interface StepContext<I> {
  runId: string;
  workspaceDir: string;
  repoPaths?: Record<string, string>;
  input: I;
  artifacts: ReadonlyArtifactStore;       // read prior steps' outputs by id
  emit: (artifactId: string, data: unknown) => void;
  bus: EventBus;
  memory?: MemoryHandles;                  // memory-core integration
  llm?: LlmHandles;                        // agent-core/router integration
  signal: AbortSignal;
}
```

`Step.subSteps` run sequentially before the parent's `run()`; `Step.retryPolicy` wraps each Step (parent or sub).

---

## Lifecycle hook points

| Hook                  | When                                     | Listener priority convention |
|-----------------------|------------------------------------------|------------------------------|
| `pipeline:started`    | once, before the first Step              | —                            |
| `step:started`        | per Step entry                           | —                            |
| `sub-step:started`    | per sub-Step entry                       | —                            |
| `sub-step:completed`  | per sub-Step exit (success or fail)      | —                            |
| `step:retried`        | before each retry attempt                | —                            |
| `step:completed`      | per Step success                         | audit (100) → learners (50)  |
| `step:failed`         | per Step failure (after retry exhaustion)| audit (100) → learners (50)  |
| `step:skipped`        | per Step skip                            | —                            |
| `artifact:emitted`    | each `ctx.emit(...)` call                | cost-tracker (20)            |
| `pipeline:completed`  | once, after last Step                    | —                            |
| `pipeline:failed`     | once, after first failure                | audit (100) → learners (50)  |

Listener registration order is preserved at equal priorities (FIFO tie-break).

---

## Custom stages (`factory.yaml`)

cli's `factory.yaml` `custom_stages:` block continues to work unchanged. The Phase 6 shim (`registerCustomStages` in cli) translates each entry into a `Step` and registers it in the right slot:

```yaml
# .anvil/factory.yaml
custom_stages:
  security-scan:
    persona: security
    prompt_file: .anvil/stages/security-scan.md
    insertAfter: build              # NEW (Phase 6) — preferred
  legacy-extra:
    persona: tester
    after: validate                 # legacy field — still supported
```

Precedence at registration time: **`insertBefore` > `insertAfter` > legacy `after` > append-to-end**.

Entries whose prompt file is missing are skipped with a warning (mirrors today's `loadCustomStages`).

---

## Environment variables

| Var                       | Effect                                                                           |
|---------------------------|----------------------------------------------------------------------------------|
| `ANVIL_USE_NEW_PIPELINE`  | When set to `1` / `true` / `yes` / `on`, cli's `runPipeline` delegates to the v2 (core-pipeline-backed) orchestrator. Default off — legacy if-tree stays in charge. |
| `ANVIL_HOME`              | Override for `~/.anvil` (state-file + audit-log root). Honored by the cli wrapper that wires hooks. |

---

## Integration points

- **`@anvil/agent-core`** — `LlmHandles` plumbing on `StepContext.llm` so Steps can dispatch through the LLM router (tag-based routing, retry, spend ledger).
- **`@anvil/memory-core`** — `MemoryHandles` plumbing on `StepContext.memory`. Phase 9 hook `attachLearnersHook` is the wire-point for cli's previously-dead `autoLearnHook`.
- **cli** — `cli/src/pipeline/steps/index.ts` exports `buildDefaultPipelineRegistry()` (8 stages: clarify → requirements → project-requirements → specs → tasks → build → validate → ship) and `isNewPipelineEnabled()` for the strangler-fig flag.

---

## Observability

Every Step run produces:

1. JSONL audit row at `~/.anvil/runs/<runId>/audit.jsonl` (append-only, one line per emitted event).
2. Debounced JSON snapshot at `~/.anvil/state.json` for the dashboard.
3. Cost rollup in-process via `attachCostTrackerHook(bus).totals()`.

Test seams (deterministic clocks, fake `setTimeout`/`writeFileSync`) are exposed on each hook's options for unit tests.
