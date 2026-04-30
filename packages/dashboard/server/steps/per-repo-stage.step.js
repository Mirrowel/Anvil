/**
 * `per-repo-stage` — Phase 4f.2 of the dashboard consolidation.
 *
 * Lifts the per-repo work that `pipeline-runner.ts:runPerRepoStage()` does
 * for ONE repo into a reusable helper + Step factory:
 *
 *   - `runPerRepoStageForRepo(opts)` — spawn-and-wait for a single repo,
 *     applying the persona-aware `disallowedTools` rule that's stable
 *     across the legacy per-repo stages (requirements, specs, tasks, validate).
 *   - `combinePerRepoArtifacts(results)` — joins per-repo artifacts using
 *     the legacy `## ${repoName}\n\n${artifact}` separator format.
 *   - `createPerRepoStageStep(opts)` — `Step<string, RunPerRepoStageResult>`
 *     factory with `parallelism: 'per-repo'`. Phase 4f.7 will register
 *     this Step so the Pipeline walker drives the per-repo fanout
 *     instead of the manual loop in pipeline-runner.runPerRepoStage.
 *
 * Today (Phase 4f.2) `pipeline-runner.runPerRepoStage` keeps owning the
 * loop — it calls `runPerRepoStageForRepo` once per repo so the dashboard
 * state mutations (state.stages[i].repos[r].status / agentId / cost /
 * artifact / error) and the Promise.all aggregation stay in pipeline-runner.
 *
 * The build stage's per-task fanout is NOT lifted here — see Phase 4f.3
 * (`per-repo-build.step.ts`).
 */
import { spawnAndWait } from './agent-spawner.js';
/**
 * Personas that are allowed to mutate the working tree. Engineers do
 * codegen; testers write tests. Everyone else gets file-mutation tools
 * disabled so reviewers/planners can't accidentally commit code.
 *
 * Mirrors the rule at `pipeline-runner.ts:1744-1749` verbatim. The
 * `Agent` tool is always disabled (P8 — sub-agents inherit context and
 * double the token cost).
 */
const FILE_MUTATING_PERSONAS = new Set(['engineer', 'tester']);
export function disallowedToolsForPersona(persona) {
    if (FILE_MUTATING_PERSONAS.has(persona)) {
        return ['Agent'];
    }
    return ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Agent'];
}
/**
 * Spawn one agent for one repo and resolve when it completes. Throws on
 * cancellation or agent-side error/kill — the caller's loop is expected
 * to catch and apply per-repo state cleanup (status='failed' + error).
 */
export async function runPerRepoStageForRepo(opts) {
    return spawnAndWait({
        agentManager: opts.agentManager,
        spec: {
            name: `${opts.persona}-${opts.repoName}`,
            persona: opts.persona,
            project: opts.project,
            stage: `${opts.stageName}:${opts.repoName}`,
            prompt: opts.prompt,
            model: opts.model,
            cwd: opts.repoPath,
            projectPrompt: opts.projectPrompt,
            permissionMode: 'bypassPermissions',
            disallowedTools: disallowedToolsForPersona(opts.persona),
            maxOutputTokens: opts.maxOutputTokens,
        },
        isCancelled: opts.isCancelled,
        onSpawn: opts.onSpawn,
        onTruncation: opts.onTruncation,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
    });
}
/**
 * Combine per-repo artifacts using the legacy `## ${repoName}\n\n${artifact}`
 * separator. Empty-artifact entries are dropped so the output stays clean
 * for downstream stages that read the combined string.
 *
 * Mirrors `pipeline-runner.ts:1807-1809` verbatim.
 */
export function combinePerRepoArtifacts(results) {
    return results
        .filter((r) => r.artifact)
        .map((r) => `## ${r.repoName}\n\n${r.artifact}`)
        .join('\n\n---\n\n');
}
/**
 * Step factory for the per-repo stage. Declares `parallelism: 'per-repo'`
 * so the Pipeline walker fans `run()` across `ctx.repoPaths` keys
 * (Phase 4a). Each invocation handles one repo and returns its artifact
 * + cost; the walker aggregates into a `Record<string, RunPerRepoStageResult>`.
 *
 * NOT auto-registered in `buildDashboardStepRegistry` — Phase 4f.7 will
 * wire registration once `Pipeline.run()` becomes the orchestrator.
 */
export function createPerRepoStageStep(opts) {
    const id = opts.id ?? `per-repo-stage:${opts.stageName}`;
    return {
        id,
        name: `Per-repo stage (${opts.stageName})`,
        parallelism: 'per-repo',
        async run(ctx) {
            const repoName = ctx.repoName;
            if (!repoName) {
                throw new Error(`[${id}] requires ctx.repoName — did the walker forget to fan out?`);
            }
            const repoPath = ctx.repoPaths?.[repoName];
            if (!repoPath) {
                throw new Error(`[${id}] no repoPath registered for "${repoName}"`);
            }
            const isCancelled = opts.isCancelled
                ? () => opts.isCancelled(ctx)
                : () => ctx.signal.aborted;
            const result = await runPerRepoStageForRepo({
                agentManager: opts.agentManager,
                project: opts.project,
                stageName: opts.stageName,
                persona: opts.persona,
                model: opts.model,
                maxOutputTokens: opts.maxOutputTokens,
                repoName,
                repoPath,
                projectPrompt: opts.buildProjectPrompt(repoName),
                prompt: opts.buildStagePrompt(repoName, ctx.input),
                isCancelled,
                onSpawn: opts.onAgentSpawned
                    ? (agentId) => opts.onAgentSpawned(repoName, agentId)
                    : undefined,
                onTruncation: opts.onTruncation,
                pollIntervalMs: opts.pollIntervalMs,
                sleep: opts.sleep,
            });
            opts.writeRepoArtifact?.(repoName, result.artifact);
            return result;
        },
    };
}
//# sourceMappingURL=per-repo-stage.step.js.map