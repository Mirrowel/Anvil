/**
 * Pipeline orchestrator — v2 (Phase 8).
 *
 * Thin wrapper around `@anvil/core-pipeline`'s `Pipeline.run()`. Builds
 * the default registry from `steps/index.ts` (Phases 4 + 5), wires
 * lifecycle hooks (audit, dashboard-state, learners, cost-tracker),
 * runs, then maps the `PipelineRunResult` back into the legacy
 * `OrchestratorResult` shape so existing callers (`commands/run-feature`)
 * see no surface change.
 *
 * **Status:** v2 ships gated behind `ANVIL_USE_NEW_PIPELINE=1`. The
 * legacy if-tree in `orchestrator.ts` remains as fallback per ADR P8 +
 * plan §8.5 ("keep feature flag for one cycle so users can fall back").
 * Feature parity items (interactive readline clarify, approval gate
 * polling, resume-from-stage, parallel-per-project fan-out) are
 * tracked as out-of-scope work for this Phase — Steps cover the
 * vanilla path; the rich behaviors stay in the legacy path until they
 * are individually ported.
 */

import { join } from 'node:path';
import {
  Pipeline,
  InMemoryEventBus,
  attachAuditLogHook,
  attachDashboardStateHook,
  attachCostTrackerHook,
  attachLearnersHook,
} from '@anvil/core-pipeline';
import type { CostEntry } from '../run/index.js';
import { generateRunId, generateFeatureSlug } from '../run/index.js';
import { getFFDirs, getAnvilHome } from '../home.js';
import type { OrchestratorConfig, OrchestratorResult, PipelineDependencies } from './orchestrator.js';
import { buildDefaultPipelineRegistry } from './steps/index.js';
import { autoLearnHook } from '../memory/learners/index.js';
import type { PipelineEvent as LegacyPipelineEvent } from './types.js';

/**
 * Run the pipeline through `@anvil/core-pipeline`'s walker. Returns the
 * legacy `OrchestratorResult` shape for caller compatibility.
 */
export async function runPipelineV2(
  config: OrchestratorConfig,
  deps?: PipelineDependencies,
): Promise<OrchestratorResult> {
  const runId = generateRunId();
  const featureSlug = config.featureSlug || generateFeatureSlug(config.feature);
  const dirs = getFFDirs(config.workingDir);
  const auditPath = join(dirs.runs, runId, 'audit.jsonl');
  const statePath = join(getAnvilHome(), 'state.json');

  const bus = new InMemoryEventBus();
  const auditHandle = attachAuditLogHook(bus, { path: auditPath });
  const stateHandle = attachDashboardStateHook(bus, { path: statePath });
  const costHandle = attachCostTrackerHook(bus);

  // Wire cli's previously-dead autoLearnHook into the bus.
  attachLearnersHook(bus, {
    project: config.project,
    onLearnEvent: (event) => {
      const legacy = mapToLegacyEvent(event.hook);
      if (!legacy) return;
      autoLearnHook(
        {
          type: legacy,
          stage: undefined,
          stageName: event.stepId,
          timestamp: event.ts,
          error: event.error?.message,
        },
        config.project,
      );
    },
  });

  const registry = buildDefaultPipelineRegistry();

  const pipeline = new Pipeline({
    bus,
    registry,
    runId,
    workspaceDir: config.workingDir ?? process.cwd(),
    initialInput: {
      project: config.project,
      feature: config.feature,
      featureSlug,
      runId,
      agentRunner: deps?.agentRunner,
    },
  });

  const result = await pipeline.run();
  stateHandle.flush();
  auditHandle.unsubscribe();
  stateHandle.unsubscribe();
  costHandle.unsubscribe();

  const totalCost: CostEntry = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: costHandle.totals().costUsd,
  };

  if (result.status === 'success') {
    return { runId, status: 'completed', totalCost, prUrls: [] };
  }
  if (result.status === 'aborted') {
    return { runId, status: 'cancelled', totalCost, prUrls: [] };
  }
  return {
    runId,
    status: 'failed',
    totalCost,
    prUrls: [],
    failedStage: registry.steps().findIndex((s) => s.id === result.failedStep),
    failedError: 'see audit.jsonl',
  };
}

function mapToLegacyEvent(hook: string): LegacyPipelineEvent['type'] | null {
  switch (hook) {
    case 'pipeline:completed':
      return 'pipeline-complete';
    case 'pipeline:failed':
      return 'pipeline-fail';
    case 'step:failed':
      return 'stage-fail';
    case 'step:started':
      return 'stage-start';
    case 'step:completed':
      return 'stage-complete';
    default:
      return null;
  }
}
