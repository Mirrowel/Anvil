/**
 * `buildPipelineStepRegistry` — assembles an `InMemoryStepRegistry`
 * with one Step per pipeline stage. Each Step delegates to a caller-
 * supplied `runStage` callback that mutates the shared run state.
 *
 * Today this registry is **not yet wired** into the dashboard's active
 * dispatch loop — pipeline-runner.ts still walks stages via its own
 * for-loop. The registry exists as the migration target: a future
 * `Pipeline.run()` call over this registry replaces the for-loop and
 * unlocks bus-driven WS event broadcasting (subscribe to
 * `step:started` / `step:completed` events instead of inline emits).
 *
 * Migration recipe (post-R7):
 *   1. Construct the registry alongside the existing for-loop.
 *   2. In a new code path (env-flagged), call
 *      `new Pipeline({ registry, eventBus, hooks }).run({ runId, ... })`.
 *   3. Subscribe `step:started` → state.stages[i].status = 'running' +
 *      broadcastState; subscribe `step:completed` → analogous.
 *   4. Verify WS event-vocabulary parity (capture WS messages from
 *      both paths on the same input; assert byte-equal).
 *   5. Flip the env flag default to enabled. Delete the for-loop.
 */

import {
  InMemoryStepRegistry,
  type Step,
  type StepContext,
  type StepRegistry,
} from '@esankhan3/anvil-core-pipeline';
import { STAGES } from '@esankhan3/anvil-core-pipeline';

export interface PipelineStageStepDeps {
  /**
   * Caller-supplied stage runner. Returns the artifact + cost + tokens
   * for the named stage. Side effects (state mutation, broadcasts) live
   * inside the callback today; tomorrow they migrate to bus subscribers.
   */
  runStage: (stageName: string, prevArtifact: string) => Promise<{
    artifact: string;
    cost: number;
  }>;
}

export function buildPipelineStepRegistry(deps: PipelineStageStepDeps): StepRegistry {
  const registry = new InMemoryStepRegistry();

  for (const stage of STAGES) {
    const step: Step<string, string> = {
      id: stage.name,
      name: stage.label,
      parallelism: 'serial',
      run: async (ctx: StepContext<string>): Promise<string> => {
        const prevArtifact = ctx.input ?? '';
        const result = await deps.runStage(stage.name, prevArtifact);
        return result.artifact;
      },
    };
    registry.register(step as Step<unknown, unknown>);
  }

  return registry;
}
