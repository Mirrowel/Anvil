/**
 * `runBuildStage` — per-task build runner backed by the dependency-graph
 * scheduler. Both cli and dashboard share this once they adopt the
 * AgentRunner-based path.
 *
 * The actual task parsing (`parseTasks`) and dep-graph scheduling
 * (`runTasksWithDependencyGraph`) live in
 * `dashboard/server/engineer-task-bundler.ts` today — keeping them there
 * avoids pulling node-fs into core-pipeline. `runBuildStage` accepts the
 * already-parsed task list, so consumers parse upstream and pass it in.
 */

import type { AgentRunner } from '../agent-runner.js';
import type { StageContext, StageOutput, StageTokens } from './types.js';
import { emptyStageTokens } from './types.js';

/**
 * Minimal `ParsedTask` shape expected by `runBuildStage`. Mirrors the
 * dashboard's `engineer-task-bundler.ts:ParsedTask`. Consumers parse
 * upstream and pass the resulting list in.
 */
export interface BuildStageTask {
  id: string;
  title: string;
  files: string[];
  prerequisites: string[];
  /** Raw markdown sub-document for this task. Used by `buildPerTaskPrompt`. */
  block: string;
  /** Optional spec reference, used by `buildPerTaskPrompt`. */
  specRef?: string | null;
}

export interface BuildTaskOutput {
  id: string;
  title: string;
  artifact: string;
}

/**
 * Function shape matching `runTasksWithDependencyGraph` from
 * `dashboard/server/engineer-task-bundler.ts`. Promoting the function
 * itself across the package boundary is deferred — see comment at top.
 */
export type RunTasksWithDependencyGraph = <R>(
  tasks: BuildStageTask[],
  runTask: (task: BuildStageTask) => Promise<R>,
  hooks: {
    onStart?: (task: BuildStageTask) => void;
    onComplete?: (task: BuildStageTask, result: R) => void;
    onFail?: (task: BuildStageTask, err: unknown) => void;
  },
  opts?: { maxConcurrent?: number; enforceFileConflicts?: boolean },
) => Promise<Map<string, { ok: true; result: R } | { ok: false; error: unknown }>>;

export interface BuildStageOptions {
  /** Per-repo task list — already parsed from TASKS.md. */
  tasksByRepo: Record<string, BuildStageTask[]>;
  /** Build the per-task agent prompt. Receives task + repoName. */
  buildPerTaskPrompt: (task: BuildStageTask, repoName: string) => string;
  /** Build the per-repo system / project prompt. */
  buildProjectPrompt: (repoName: string) => string;
  /** Persona — typically 'engineer'. */
  persona?: string;
  /** Tool whitelist forwarded to the agent. */
  allowedTools?: readonly string[];
  /** Tool deny-list. */
  disallowedTools?: readonly string[];
  /** Output token cap. */
  maxOutputTokens?: number;
  /** Optional max concurrent tasks across the whole stage. */
  maxConcurrent?: number;
  /** Optional fallback artifact when a task throws — defaults to the task block + error message. */
  unresolvedArtifact?: (task: BuildStageTask, error: string) => string;
  /** The dependency-graph runner. Injected so core-pipeline doesn't pull
   *  node-fs deps for parsing. Pass the dashboard's `runTasksWithDependencyGraph`. */
  scheduler: RunTasksWithDependencyGraph;
  /** Per-task lifecycle hooks. */
  onTaskStart?: (repoName: string, task: BuildStageTask) => void;
  onTaskComplete?: (repoName: string, task: BuildStageTask, costUsd: number, tokens: StageTokens) => void;
  onTaskFail?: (repoName: string, task: BuildStageTask, error: unknown) => void;
}

export interface BuildRepoResult {
  artifact: string;
  taskOutputs: BuildTaskOutput[];
  costUsd: number;
  tokens: StageTokens;
}

/**
 * Run the build stage for every repo in `ctx.repoNames` in parallel.
 * Each repo runs its tasks through the dependency-graph scheduler.
 */
export async function runBuildStage(
  ctx: StageContext,
  opts: BuildStageOptions,
): Promise<StageOutput & { perRepo: Record<string, BuildRepoResult> }> {
  const persona = opts.persona ?? 'engineer';
  const perRepo: Record<string, BuildRepoResult> = {};
  const failures = new Map<string, unknown>();

  let totalCost = 0;
  const totals = emptyStageTokens();

  await Promise.all(
    ctx.repoNames.map(async (repoName) => {
      try {
        const tasks = opts.tasksByRepo[repoName] ?? [];
        const repoTotals = emptyStageTokens();
        let repoCost = 0;
        const taskOutputs: BuildTaskOutput[] = [];
        const projectPrompt = opts.buildProjectPrompt(repoName);
        const repoPath = ctx.repoPaths[repoName] ?? ctx.workspaceDir;

        if (tasks.length === 0) {
          // Empty TASKS.md: fall back to a single repo-wide spawn so
          // build still produces some artifact for downstream stages.
          const result = await ctx.agentRunner.run({
            persona,
            projectPrompt,
            userPrompt: `Build the feature for repo "${repoName}". No parseable TASKS.md was provided — implement the feature directly based on prior stages' artifacts.`,
            workingDir: repoPath,
            stage: 'build',
            allowedTools: opts.allowedTools,
            disallowedTools: opts.disallowedTools,
            maxOutputTokens: opts.maxOutputTokens,
            repoName,
          });
          perRepo[repoName] = {
            artifact: result.output,
            taskOutputs: [],
            costUsd: result.costUsd ?? 0,
            tokens: {
              inputTokens: result.inputTokens ?? 0,
              outputTokens: result.outputTokens ?? 0,
              cacheReadTokens: result.cacheReadTokens ?? 0,
              cacheWriteTokens: result.cacheWriteTokens ?? 0,
            },
          };
          totalCost += perRepo[repoName].costUsd;
          totals.inputTokens += perRepo[repoName].tokens.inputTokens;
          totals.outputTokens += perRepo[repoName].tokens.outputTokens;
          totals.cacheReadTokens += perRepo[repoName].tokens.cacheReadTokens;
          totals.cacheWriteTokens += perRepo[repoName].tokens.cacheWriteTokens;
          return;
        }

        await opts.scheduler(
          tasks,
          async (task) => {
            const result = await ctx.agentRunner.run({
              persona,
              projectPrompt,
              userPrompt: opts.buildPerTaskPrompt(task, repoName),
              workingDir: repoPath,
              stage: `build:${repoName}:${task.id}`,
              allowedTools: opts.allowedTools,
              disallowedTools: opts.disallowedTools,
              maxOutputTokens: opts.maxOutputTokens,
              repoName,
            });
            return result;
          },
          {
            onStart: (task) => opts.onTaskStart?.(repoName, task),
            onComplete: (task, result) => {
              repoCost += result.costUsd ?? 0;
              repoTotals.inputTokens += result.inputTokens ?? 0;
              repoTotals.outputTokens += result.outputTokens ?? 0;
              repoTotals.cacheReadTokens += result.cacheReadTokens ?? 0;
              repoTotals.cacheWriteTokens += result.cacheWriteTokens ?? 0;
              taskOutputs.push({ id: task.id, title: task.title, artifact: result.output });
              opts.onTaskComplete?.(repoName, task, result.costUsd ?? 0, {
                inputTokens: result.inputTokens ?? 0,
                outputTokens: result.outputTokens ?? 0,
                cacheReadTokens: result.cacheReadTokens ?? 0,
                cacheWriteTokens: result.cacheWriteTokens ?? 0,
              });
            },
            onFail: (task, err) => {
              const msg = err instanceof Error ? err.message : String(err);
              const fallback = opts.unresolvedArtifact?.(task, msg) ?? `## ${task.id}: ${task.title}\n\n_Failed: ${msg}_\n\n${task.block}`;
              taskOutputs.push({ id: task.id, title: task.title, artifact: fallback });
              opts.onTaskFail?.(repoName, task, err);
            },
          },
          { maxConcurrent: opts.maxConcurrent, enforceFileConflicts: true },
        );

        const combined = taskOutputs
          .map((t) => `### ${t.id}: ${t.title}\n\n${t.artifact}`)
          .join('\n\n---\n\n');

        perRepo[repoName] = { artifact: combined, taskOutputs, costUsd: repoCost, tokens: repoTotals };
        totalCost += repoCost;
        totals.inputTokens += repoTotals.inputTokens;
        totals.outputTokens += repoTotals.outputTokens;
        totals.cacheReadTokens += repoTotals.cacheReadTokens;
        totals.cacheWriteTokens += repoTotals.cacheWriteTokens;
      } catch (err) {
        failures.set(repoName, err);
      }
    }),
  );

  if (failures.size > 0) {
    const which = [...failures.keys()].join(', ');
    throw new Error(
      `Build stage failed on ${failures.size} of ${ctx.repoNames.length} repo(s): ${which}.`,
    );
  }

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
