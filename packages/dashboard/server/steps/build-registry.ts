/**
 * `buildDashboardStepRegistry` — assembles the dashboard's `StepRegistry`
 * for a single pipeline run.
 *
 * Phase 4a lands the scaffold only — the registry is empty. Phases 4b–4f
 * register actual Step implementations through the same factory, so the
 * eventual Phase 4f cutover (pipeline-runner.ts → thin façade) is just a
 * matter of swapping `PipelineRunner.run()` for `new Pipeline(...).run()`.
 *
 * The dependency shape captures what each future Step will need from the
 * dashboard side:
 *   - `featureStore` / `manifestStore` — for 4b (FEATURE-MANIFEST.json)
 *   - `planRiskScorer` deps        — for 4c (PLAN-RISK.json)
 *   - `taskBundler` deps           — for 4d (TASK-BUNDLES.json)
 *   - `clarifyInputResolver`       — for 4e (interactive WS clarify)
 *
 * Steps consume these via closure capture inside the factory so the resulting
 * `Step.run()` doesn't need to type-thread dashboard internals through
 * `StepContext` (which stays generic per core-pipeline's contract).
 */

import { InMemoryStepRegistry, type StepRegistry } from '@anvil/core-pipeline';

import type { FeatureStore } from '../feature-store.js';
import type { FeatureManifestStore } from '../feature-manifest.js';
import type { ProjectLoader } from '../project-loader.js';
import type { MemoryStore } from '../memory-store.js';

/**
 * Run-scoped deps the dashboard's Steps will close over. Everything is
 * optional so 4a can land before 4b–4f require a particular field.
 */
export interface DashboardStepRegistryDeps {
  /** Project slug (matches `~/.anvil/projects/<project>/`). */
  project: string;
  /** Feature folder name (matches FeatureStore's keying). */
  featureSlug?: string;
  /** Feature title shown in the manifest header. */
  feature?: string;
  /** Repo names participating in this run; drives per-repo fanout. */
  repoNames?: string[];
  /** Workspace root (matches PipelineConfig.workspaceDir). */
  workspaceDir: string;
  /** Per-repo absolute paths; consumed by per-repo Steps. */
  repoPaths?: Record<string, string>;
  /** Optional — Phase 4b will require this for the FeatureStore Step. */
  featureStore?: FeatureStore;
  /** Optional — Phase 4b will require this for the FeatureStore Step. */
  manifestStore?: FeatureManifestStore;
  /** Optional — Phase 4c–4d Steps may consult ProjectLoader for stage models. */
  projectLoader?: ProjectLoader;
  /** Optional — Phase 4e clarify Step may read from the project's MemoryStore. */
  memoryStore?: MemoryStore;
  /**
   * Optional — Phase 4e clarify Step resolves user input via the dashboard
   * server's WebSocket userMessage path. The Step's `run()` calls this
   * function with a prompt string and awaits the user's reply.
   */
  clarifyInputResolver?: (prompt: string) => Promise<string>;
}

/**
 * Build an empty `StepRegistry` for the dashboard.
 *
 * Phases 4b–4f extend this factory to register real Steps; for now it's a
 * placeholder that round-trips through the core-pipeline runtime cleanly so
 * tests can exercise the wiring before any real Step is added.
 */
export function buildDashboardStepRegistry(
  // Underscore to silence "unused parameter" while still pinning the public
  // signature Phase 4b–4f will rely on.
  _deps: DashboardStepRegistryDeps,
): StepRegistry {
  return new InMemoryStepRegistry();
}
