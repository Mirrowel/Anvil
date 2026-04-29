/**
 * Clarify step — Phase 4 strangler-fig adapter.
 *
 * Wraps cli's existing `runClarifyStage` (cli/src/pipeline/stages/clarify.ts)
 * as a `Step<ClarifyInput, ClarifyOutput>`. The actual logic stays where it
 * is — only the call shape changes from "positional function in the
 * orchestrator's if-tree" to "Step in core-pipeline's registry walker".
 *
 * The Step preserves today's contract: emits `CLARIFICATION.md` as an
 * artifact (which the audit log + dashboard hooks pick up via
 * `artifact:emitted`) and returns the markdown body so downstream Steps
 * (Phase 5) can read it via `ctx.input`.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { runClarifyStage } from '../stages/clarify.js';
import type { AgentRunner } from '../stages/types.js';

export interface ClarifyInput {
  project: string;
  feature: string;
  agentRunner: AgentRunner;
  runDir: string;
  projectYamlPath?: string;
  conventionsPath?: string;
  /** Skip clarification entirely. */
  skipClarify?: boolean;
  /** Pre-supplied answers file (bypasses interactive prompt). */
  answersFile?: string;
}

export interface ClarifyOutput {
  /** The CLARIFICATION.md body. */
  artifact: string;
  /** Token estimate for cost tracking. */
  tokenEstimate: number;
}

export const CLARIFY_STEP_ID = 'clarify' as const;
export const CLARIFICATION_ARTIFACT_ID = 'CLARIFICATION.md' as const;

export function createClarifyStep(): Step<ClarifyInput, ClarifyOutput> {
  return {
    id: CLARIFY_STEP_ID,
    name: 'Clarify feature request via interactive Q&A',
    parallelism: 'serial',
    run: async (ctx: StepContext<ClarifyInput>): Promise<ClarifyOutput> => {
      const {
        project,
        feature,
        agentRunner,
        runDir,
        projectYamlPath,
        conventionsPath,
        skipClarify = false,
        answersFile,
      } = ctx.input;

      const result = await runClarifyStage(
        {
          project,
          feature,
          agentRunner,
          runDir,
          projectYamlPath,
          conventionsPath,
          workspaceDir: ctx.workspaceDir,
          repoPaths: ctx.repoPaths,
        },
        { skipClarify, answersFile },
      );

      ctx.emit(CLARIFICATION_ARTIFACT_ID, {
        artifact: result.artifact,
        artifactName: result.artifactName,
        tokenEstimate: result.tokenEstimate,
      });

      return {
        artifact: result.artifact,
        tokenEstimate: result.tokenEstimate,
      };
    },
  };
}
