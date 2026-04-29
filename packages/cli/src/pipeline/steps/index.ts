/**
 * cli pipeline `Step` registry — Phase 4 entry point.
 *
 * Builds the default ordered list of `Step<I, O>`s the new pipeline
 * walker runs through. Phase 4 only registers `clarify`; subsequent
 * phases (5) extend this with the remaining 7 stages.
 *
 * The orchestrator's legacy if-tree continues to ship the actual hot
 * path until Phase 8 deletes it. The compatibility shim
 * (`isNewPipelineEnabled`) gates the new code path on
 * `ANVIL_USE_NEW_PIPELINE=1` until then.
 */

import { InMemoryStepRegistry, type StepRegistry } from '@anvil/core-pipeline';
import { createClarifyStep, CLARIFY_STEP_ID, CLARIFICATION_ARTIFACT_ID } from './clarify.step.js';
import type { ClarifyInput, ClarifyOutput } from './clarify.step.js';

export {
  createClarifyStep,
  CLARIFY_STEP_ID,
  CLARIFICATION_ARTIFACT_ID,
};
export type { ClarifyInput, ClarifyOutput };

/**
 * Construct the default cli pipeline registry. Phase 4 registers only
 * `clarify`; Phase 5 ports the remaining 7 stages.
 */
export function buildDefaultPipelineRegistry(): StepRegistry {
  const registry = new InMemoryStepRegistry();
  registry.register(createClarifyStep() as never);
  return registry;
}

/**
 * Strangler-fig feature flag.
 *
 * Returns true when `ANVIL_USE_NEW_PIPELINE` is set to a truthy value
 * (1, true, yes, on — case-insensitive). Defaults to false until the
 * orchestrator's if-tree is fully replaced (Phase 8).
 */
export function isNewPipelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ANVIL_USE_NEW_PIPELINE;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
