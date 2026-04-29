/**
 * `@anvil/core-pipeline` barrel.
 *
 * Public surface for the typed Step<I,O> graph + EventBus + StepRegistry.
 * See CORE-PIPELINE-EXTRACT-PLAN.md for the phased rollout.
 */

export type {
  Step,
  StepContext,
  StepRetryPolicy,
  StepHookPoint,
  PipelineEvent,
  EventBus,
  EventListener,
  StepRegistry,
  ReadonlyArtifactStore,
  PipelineRunResult,
  MemoryHandles,
  LlmHandles,
} from './types.js';
export { InMemoryEventBus } from './event-bus.js';
export { InMemoryStepRegistry } from './step-registry.js';
export { Pipeline } from './pipeline.js';
export type { PipelineDeps } from './pipeline.js';
export { VERSION } from './version.js';
