/**
 * Ship step — single agent turn that pushes the feature branch, opens
 * one PR per repo, and deploys a preview sandbox via the nexus MCP.
 *
 * The Step factory pattern is the unification surface — both cli (today)
 * and dashboard (after R3 lands and pipeline-runner.ts migrates to
 * `Pipeline.run()` + `InMemoryStepRegistry`) drive the same Step.
 */

import { execSync } from 'node:child_process';
import type { Step, StepContext } from '@esankhan3/anvil-core-pipeline';
import { buildShipUserPrompt, extractPrUrls, extractSandboxUrl } from '@esankhan3/anvil-core-pipeline';
import { buildPersonaProjectPrompt } from '../persona-prompt.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import { warn } from '../../logger.js';
import { estimateAgentCallCost } from '../cost-estimator.js';
import type { CliPipelineState } from '../cli-state.js';

export const SHIP_STEP_ID = 'ship' as const;

export function createShipStep(): Step<unknown, unknown> {
  return {
    id: SHIP_STEP_ID,
    name: 'Commit, push feature branch, create PRs, deploy sandbox',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;

      if (state.skipShip) {
        updatePipelineStage(7, 'skipped');
        return null;
      }

      // Pre-check: gh CLI auth
      try {
        execSync('gh auth status', { stdio: 'pipe', timeout: 10_000 });
      } catch {
        warn('GitHub CLI is not authenticated. PRs will not be created.');
        warn('Run "gh auth login" to authenticate, then retry with "anvil resume".');
      }

      updatePipelineStage(7, 'running');

      const projectPrompt = await buildPersonaProjectPrompt(
        7, state.project, state.feature, state.featureSlug,
        state.projectYamlPath, state.workspaceDir, state.repoNames, state.memoryStore,
      );

      const userPrompt = buildShipUserPrompt({
        feature: state.feature,
        featureSlug: state.featureSlug,
        repoNames: state.repoNames,
        workspaceDir: state.workspaceDir,
        actionType: state.actionType,
      });

      const shipResult = await state.agentRunner.run({
        persona: 'engineer',
        projectPrompt,
        userPrompt,
        workingDir: state.workspaceDir,
        stage: 'ship',
      });

      const prUrls = extractPrUrls(shipResult.output);
      if (prUrls.length > 0) {
        state.prUrls = prUrls;
      }
      const sandboxUrl = extractSandboxUrl(shipResult.output);
      if (sandboxUrl) {
        state.sandboxUrl = sandboxUrl;
      }

      const { inputTokens, outputTokens, costUsd } = estimateAgentCallCost(shipResult.tokenEstimate, state.model);
      state.stageCosts.set(7, { inputTokens, outputTokens, estimatedCost: costUsd });
      updateStageCost(7, costUsd);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(7, 'completed');

      return state.prUrls;
    },
  };
}

function aggregateCost(state: CliPipelineState): { inputTokens: number; outputTokens: number; estimatedCost: number } {
  let estimatedCost = 0, inputTokens = 0, outputTokens = 0;
  for (const c of state.stageCosts.values()) {
    estimatedCost += c.estimatedCost;
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
  }
  return { estimatedCost, inputTokens, outputTokens };
}
