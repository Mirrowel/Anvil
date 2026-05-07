/**
 * `runValidateStage` — validate-then-fix loop.
 *
 * Runs the validate agent against the codebase. If the artifact reports
 * failures (per the caller-supplied `hasFailures` predicate), spawns a
 * fix agent, then re-validates. Capped at `maxFixAttempts` (default 3).
 *
 * Both cli and dashboard share this once they migrate to the
 * AgentRunner-based path. cli today has only a single fix attempt;
 * adopting this gives it the full loop for free.
 */

import type { AgentRunner } from '../agent-runner.js';
import type { StageContext, StageOutput, StageTokens } from './types.js';
import { emptyStageTokens } from './types.js';

export interface ValidateStageOptions {
  /** Persona running validate — typically 'tester'. */
  validatePersona?: string;
  /** Persona running fix — typically 'engineer'. */
  fixPersona?: string;
  /** Build the validate user prompt. Receives prevArtifact (build output). */
  buildValidatePrompt: (repoName: string, prevArtifact: string) => string;
  /** Build the fix user prompt. Receives the failing validate artifact. */
  buildFixPrompt: (repoName: string, validateArtifact: string, attemptIndex: number) => string;
  /** Build the system / project prompt. */
  buildProjectPrompt: (repoName: string, persona: string) => string;
  /** Predicate — does the validate artifact report any failures? */
  hasFailures: (artifact: string) => boolean;
  /** Combined artifact from the prior stage (build). */
  prevArtifact: string;
  /** Max fix attempts before bailing. Default 3. */
  maxFixAttempts?: number;
  /** Tool whitelist for validate runs (typically read+exec). */
  validateAllowedTools?: readonly string[];
  /** Tool whitelist for fix runs (typically read+write+exec). */
  fixAllowedTools?: readonly string[];
  /** Output token cap. */
  maxOutputTokens?: number;
  /** Hooks. */
  onValidateStart?: (repoName: string, attemptIndex: number) => void;
  onValidateComplete?: (repoName: string, attemptIndex: number, artifact: string, hasFailures: boolean) => void;
  onFixStart?: (repoName: string, attemptIndex: number) => void;
  onFixComplete?: (repoName: string, attemptIndex: number, artifact: string) => void;
  onMaxAttemptsReached?: (repoName: string, finalArtifact: string) => void;
}

export interface ValidateRepoResult {
  artifact: string;
  fixAttempts: number;
  finalHasFailures: boolean;
  costUsd: number;
  tokens: StageTokens;
}

export async function runValidateStage(
  ctx: StageContext,
  opts: ValidateStageOptions,
): Promise<StageOutput & { perRepo: Record<string, ValidateRepoResult> }> {
  const validatePersona = opts.validatePersona ?? 'tester';
  const fixPersona = opts.fixPersona ?? 'engineer';
  const maxFixAttempts = Math.max(0, opts.maxFixAttempts ?? 3);

  const perRepo: Record<string, ValidateRepoResult> = {};
  let totalCost = 0;
  const totals = emptyStageTokens();

  await Promise.all(
    ctx.repoNames.map(async (repoName) => {
      const repoTotals = emptyStageTokens();
      let repoCost = 0;
      let attemptIndex = 0;
      let validateArtifact = '';
      let failing = true;

      while (failing && attemptIndex <= maxFixAttempts) {
        opts.onValidateStart?.(repoName, attemptIndex);
        const inputForValidate = attemptIndex === 0 ? opts.prevArtifact : validateArtifact;
        const validateResult = await ctx.agentRunner.run({
          persona: validatePersona,
          projectPrompt: opts.buildProjectPrompt(repoName, validatePersona),
          userPrompt: opts.buildValidatePrompt(repoName, inputForValidate),
          workingDir: ctx.repoPaths[repoName] ?? ctx.workspaceDir,
          stage: 'validate',
          allowedTools: opts.validateAllowedTools,
          maxOutputTokens: opts.maxOutputTokens,
          repoName,
        });
        validateArtifact = validateResult.output ?? '';
        repoCost += validateResult.costUsd ?? 0;
        repoTotals.inputTokens += validateResult.inputTokens ?? 0;
        repoTotals.outputTokens += validateResult.outputTokens ?? 0;
        repoTotals.cacheReadTokens += validateResult.cacheReadTokens ?? 0;
        repoTotals.cacheWriteTokens += validateResult.cacheWriteTokens ?? 0;

        failing = opts.hasFailures(validateArtifact);
        opts.onValidateComplete?.(repoName, attemptIndex, validateArtifact, failing);

        if (!failing) break;
        if (attemptIndex >= maxFixAttempts) {
          opts.onMaxAttemptsReached?.(repoName, validateArtifact);
          break;
        }

        // Run fix.
        attemptIndex += 1;
        opts.onFixStart?.(repoName, attemptIndex);
        const fixResult = await ctx.agentRunner.run({
          persona: fixPersona,
          projectPrompt: opts.buildProjectPrompt(repoName, fixPersona),
          userPrompt: opts.buildFixPrompt(repoName, validateArtifact, attemptIndex),
          workingDir: ctx.repoPaths[repoName] ?? ctx.workspaceDir,
          stage: 'fix-loop',
          allowedTools: opts.fixAllowedTools,
          maxOutputTokens: opts.maxOutputTokens,
          repoName,
        });
        repoCost += fixResult.costUsd ?? 0;
        repoTotals.inputTokens += fixResult.inputTokens ?? 0;
        repoTotals.outputTokens += fixResult.outputTokens ?? 0;
        repoTotals.cacheReadTokens += fixResult.cacheReadTokens ?? 0;
        repoTotals.cacheWriteTokens += fixResult.cacheWriteTokens ?? 0;
        opts.onFixComplete?.(repoName, attemptIndex, fixResult.output ?? '');
      }

      perRepo[repoName] = {
        artifact: validateArtifact,
        fixAttempts: attemptIndex,
        finalHasFailures: failing,
        costUsd: repoCost,
        tokens: repoTotals,
      };
      totalCost += repoCost;
      totals.inputTokens += repoTotals.inputTokens;
      totals.outputTokens += repoTotals.outputTokens;
      totals.cacheReadTokens += repoTotals.cacheReadTokens;
      totals.cacheWriteTokens += repoTotals.cacheWriteTokens;
    }),
  );

  const repoArtifacts: Record<string, string> = {};
  for (const [r, res] of Object.entries(perRepo)) repoArtifacts[r] = res.artifact;
  const combinedArtifact = ctx.repoNames
    .map((r) => `## ${r}\n\n${repoArtifacts[r] ?? ''}`)
    .join('\n\n---\n\n');

  return {
    artifact: combinedArtifact,
    repoArtifacts,
    costUsd: totalCost,
    tokens: totals,
    tokenEstimate: totals.inputTokens + totals.outputTokens,
    perRepo,
  };
}
