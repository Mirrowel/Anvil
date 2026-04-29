/**
 * `Pipeline` skeleton — Phase 1 scaffold.
 *
 * Phase 3 implements the actual `run()` walker (registry → step.run → bus
 * emit). This stub exists so cli + tests compile against the surface.
 */

import type {
  EventBus,
  PipelineRunResult,
  StepRegistry,
} from './types.js';

export interface PipelineDeps {
  registry: StepRegistry;
  bus: EventBus;
  runId: string;
  workspaceDir: string;
  signal?: AbortSignal;
}

export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(): Promise<PipelineRunResult> {
    throw new Error(
      'Pipeline.run() not implemented yet — Phase 3 wires the walker. ' +
        `Registry has ${this.deps.registry.steps().length} step(s); ` +
        `runId=${this.deps.runId}.`,
    );
  }
}
