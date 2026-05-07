/**
 * Tests for runPerRepoStage. Validates parallel fan-out, atomic-failure
 * semantics, empty-artifact retryable defense, and cost/token aggregation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPerRepoStage } from '../stages/per-repo.js';
import type { AgentRunner, AgentRunResult } from '../agent-runner.js';
import type { StageContext } from '../stages/types.js';

function makeRunner(byRepo: Record<string, Partial<AgentRunResult> | Error>): AgentRunner {
  return {
    async run(req) {
      const out = byRepo[req.repoName ?? ''];
      if (out instanceof Error) throw out;
      return {
        output: out?.output ?? '',
        tokenEstimate: (out?.inputTokens ?? 0) + (out?.outputTokens ?? 0),
        inputTokens: out?.inputTokens ?? 0,
        outputTokens: out?.outputTokens ?? 0,
        costUsd: out?.costUsd ?? 0,
      };
    },
  };
}

function makeCtx(runner: AgentRunner, repoNames: string[]): StageContext {
  return {
    runId: 'r1',
    runDir: '/tmp/r1',
    project: 'test',
    feature: 'test feature',
    featureSlug: 'test-feature',
    workspaceDir: '/tmp',
    repoPaths: Object.fromEntries(repoNames.map((r) => [r, `/tmp/${r}`])),
    repoNames,
    agentRunner: runner,
  };
}

describe('runPerRepoStage', () => {
  it('runs all repos in parallel and combines artifacts', async () => {
    const longA = 'A'.repeat(200);
    const longB = 'B'.repeat(200);
    const runner = makeRunner({
      backend: { output: longA, inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      frontend: { output: longB, inputTokens: 8, outputTokens: 7, costUsd: 0.02 },
    });
    const ctx = makeCtx(runner, ['backend', 'frontend']);
    const result = await runPerRepoStage(ctx, {
      stageName: 'specs',
      persona: 'architect',
      buildPrompt: (r) => `prompt-${r}`,
      buildProjectPrompt: (r) => `project-${r}`,
      prevArtifact: 'prev',
    });
    assert.equal(result.repoArtifacts!.backend, longA);
    assert.equal(result.repoArtifacts!.frontend, longB);
    assert.match(result.artifact, /## backend/);
    assert.match(result.artifact, /## frontend/);
    assert.equal(result.costUsd, 0.03);
    assert.equal(result.tokens.inputTokens, 18);
    assert.equal(result.tokens.outputTokens, 12);
  });

  it('throws when any repo returns an empty artifact', async () => {
    const runner = makeRunner({
      backend: { output: 'A'.repeat(200), outputTokens: 5, costUsd: 0.01 },
      frontend: { output: '', outputTokens: 0, costUsd: 0 },
    });
    const ctx = makeCtx(runner, ['backend', 'frontend']);
    await assert.rejects(
      runPerRepoStage(ctx, {
        stageName: 'specs',
        persona: 'architect',
        buildPrompt: () => 'p',
        buildProjectPrompt: () => 'pp',
        prevArtifact: '',
      }),
      /failed on 1 of 2 repo/,
    );
  });

  it('surfaces minArtifactLength threshold', async () => {
    const runner = makeRunner({
      backend: { output: 'too short', outputTokens: 1, costUsd: 0.001 },
    });
    const ctx = makeCtx(runner, ['backend']);
    await assert.rejects(
      runPerRepoStage(ctx, {
        stageName: 'specs',
        persona: 'architect',
        buildPrompt: () => 'p',
        buildProjectPrompt: () => 'pp',
        prevArtifact: '',
        minArtifactLength: 50,
      }),
      /Per-repo stage "specs"/,
    );
  });

  it('fires onRepoStart and onRepoComplete hooks', async () => {
    const runner = makeRunner({
      backend: { output: 'X'.repeat(100), inputTokens: 5, outputTokens: 3, costUsd: 0.005 },
    });
    const ctx = makeCtx(runner, ['backend']);
    const events: string[] = [];
    await runPerRepoStage(ctx, {
      stageName: 'specs',
      persona: 'architect',
      buildPrompt: () => 'p',
      buildProjectPrompt: () => 'pp',
      prevArtifact: '',
      onRepoStart: (r) => events.push(`start:${r}`),
      onRepoComplete: (r, _a, _t, c) => events.push(`done:${r}:${c}`),
    });
    assert.deepEqual(events, ['start:backend', 'done:backend:0.005']);
  });
});
