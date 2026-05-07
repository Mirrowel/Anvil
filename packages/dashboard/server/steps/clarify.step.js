/**
 * `clarify.step` — Q&A orchestration Step for the dashboard's interactive
 * clarify stage.
 *
 * Phase 4e of the dashboard consolidation. Lifts the **deterministic** part
 * of `pipeline-runner.ts:runClarifyStage()` — parsing questions out of the
 * explore-phase output, dispatching them through the dashboard's WebSocket
 * userMessage path one at a time, and assembling the synthesis prompt — into
 * a `Step<string, ClarifyResult>`.
 *
 * What this Step does NOT do:
 *   - Spawn the explore-phase agent (Phase 4f's per-stage Step does that)
 *   - Run the synthesis LLM call (Phase 4f does that, consuming the
 *     `synthesisPrompt` field of `ClarifyResult`)
 *
 * What it DOES:
 *   - parseClarifyQuestions(input)  — same logic as parseQuestions()
 *   - For each question, awaits a user reply via the supplied
 *     `inputResolver` and emits Q/A bus events so the dashboard's WS
 *     client can render them. The resolver shape matches
 *     `DashboardStepRegistryDeps.clarifyInputResolver`.
 *   - Aborts cleanly on `ctx.signal` so cancellation propagates
 *   - Returns `{ qaPairs, synthesisPrompt }` for downstream consumers
 *
 * Bus events (fire-and-forget):
 *   - `clarify:question`  payload `{ questionIndex, totalQuestions, question }`
 *   - `clarify:answer`    payload `{ questionIndex, answer }`
 *   - `clarify:complete`  payload `{ qaPairs }`
 *
 * These are NOT canonical `StepHookPoint`s — they're emitted via
 * `ctx.bus.emitFireAndForget` with hook `'artifact:emitted'` and a typed
 * payload, so existing core-pipeline subscribers don't need new hook
 * support. Phase 4f will land first-class hook points if the dashboard
 * UI needs them.
 */
export const CLARIFY_QA_ARTIFACT_ID = 'CLARIFY-QA.json';
/**
 * Parse questions out of the clarifier agent's exploration output.
 * Lifted verbatim from `pipeline-runner.ts:parseQuestions()` so the
 * dedup + length filter behavior matches byte-for-byte.
 */
// Helpers moved to @esankhan3/anvil-core-pipeline. Re-exported here so
// existing dashboard consumers don't break.
import { parseClarifyQuestions as _parseClarifyQuestions, formatQAPairs as _formatQAPairs, buildClarifySynthesisPrompt as _buildClarifySynthesisPrompt, } from '@esankhan3/anvil-core-pipeline';
export const parseClarifyQuestions = _parseClarifyQuestions;
export const formatQAPairs = _formatQAPairs;
export const buildClarifySynthesisPrompt = _buildClarifySynthesisPrompt;
const SYNTHESIS_PROMPT_TEMPLATE = (qaText) => _buildClarifySynthesisPrompt(qaText);
/**
 * Build the clarify Q&A Step. The Step's input is the explore-phase
 * output (raw markdown emitted by the clarifier agent). Output is a
 * `ClarifyResult` carrying the qaPairs + synthesis prompt.
 */
export function createClarifyStep(opts) {
    const id = opts.id ?? 'clarify-qa';
    return {
        id,
        name: 'Clarify Q&A',
        parallelism: 'serial',
        async run(ctx) {
            const exploreOutput = typeof ctx.input === 'string' ? ctx.input : '';
            const parsed = parseClarifyQuestions(exploreOutput);
            // Mirror the legacy fallback: when no questions parse out, treat the
            // entire output as a single block. Only do this when the output is
            // non-empty so an empty input doesn't trigger a meaningless prompt.
            const questions = parsed.length > 0
                ? parsed
                : (exploreOutput.trim() ? [exploreOutput] : []);
            const qaPairs = [];
            let cancelled = false;
            for (let i = 0; i < questions.length; i += 1) {
                if (ctx.signal.aborted) {
                    cancelled = true;
                    break;
                }
                const question = questions[i];
                opts.onEvent?.({
                    type: 'question',
                    questionIndex: i,
                    totalQuestions: questions.length,
                    question,
                });
                let answer;
                try {
                    answer = await opts.inputResolver(question, i, questions.length);
                }
                catch (error) {
                    // Resolver rejection is treated as cancellation — same as legacy
                    // runClarifyStage where the readline path's reject-on-cancel
                    // breaks the loop without a synthesis call.
                    cancelled = true;
                    ctx.bus.emitFireAndForget({
                        hook: 'artifact:emitted',
                        runId: ctx.runId,
                        stepId: id,
                        ts: new Date().toISOString(),
                        payload: { artifactId: 'clarify:resolver-error', data: { error: String(error) } },
                    });
                    break;
                }
                if (!answer) {
                    cancelled = true;
                    break;
                }
                qaPairs.push({ question, answer });
                opts.onEvent?.({ type: 'answer', questionIndex: i, answer });
            }
            const synthesisPrompt = qaPairs.length > 0
                ? SYNTHESIS_PROMPT_TEMPLATE(formatQAPairs(qaPairs))
                : '';
            const result = {
                questions,
                qaPairs,
                synthesisPrompt,
                cancelled,
            };
            opts.onEvent?.({ type: 'complete', qaPairs });
            ctx.emit(CLARIFY_QA_ARTIFACT_ID, result);
            return result;
        },
    };
}
//# sourceMappingURL=clarify.step.js.map