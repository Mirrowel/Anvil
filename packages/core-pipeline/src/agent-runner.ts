/**
 * `AgentRunner` — the canonical agent invocation surface used by
 * stage logic in this package.
 *
 * Both consumers (cli's lightweight runner backed by `single-shot.ts`
 * and dashboard's heavyweight runner backed by `AgentManager.spawn`)
 * implement this same shape, so a single `runXxxStage` function works
 * unchanged for both. The result type is widened from the previous
 * cli-only `{output, tokenEstimate}` to expose what dashboard needs
 * (cost, cache, stop reason, agentId for live updates).
 *
 * Lives in core-pipeline because stage logic is owned here; the cli
 * and dashboard packages re-export this for back-compat with their
 * existing imports.
 */

export interface AgentRunRequest {
  /** Persona name (clarifier, analyst, architect, lead, engineer, …). */
  persona: string;
  /** System prompt — persona + project + KB context. */
  projectPrompt: string;
  /** Stage-specific user prompt. */
  userPrompt: string;
  /** Working directory the agent runs in (per-repo or workspace root). */
  workingDir: string;
  /** Stage label for telemetry (clarify, repo-requirements, build, …). */
  stage: string;
  /** Optional model override; resolver picks one when omitted. */
  model?: string;
  /** Optional provider override (claude, openrouter, opencode, …). */
  provider?: string;
  /** Stage-scoped tool permissions; respected by non-Claude agentic adapters. */
  allowedTools?: readonly string[];
  /** Tools the agent must NOT call this stage. */
  disallowedTools?: readonly string[];
  /** Cap on output tokens; honored where the adapter exposes a flag. */
  maxOutputTokens?: number;
  /** Optional fan-out hint — repo name when this run is per-repo. */
  repoName?: string;
}

export interface AgentRunResult {
  /**
   * Canonical artifact text — comes from the adapter's terminal `result`
   * frame (claude-cli stream-json) or the final assistant text (HTTP
   * adapters). Empty string when the adapter never reached its result
   * frame; Step 1 / Step 7 / Step B's empty-throws turn that case into
   * a retryable upstream error before reaching here.
   */
  output: string;
  /**
   * Streaming transcript — every text chunk the agent emitted across
   * tool turns. Used by the Activity tab. Optional: cli's lightweight
   * runner doesn't track this and leaves it as `output`.
   */
  transcript?: string;
  /** Legacy field — total tokens (input + output). Kept for back-compat. */
  tokenEstimate: number;
  /**
   * Detailed token + cost fields. Optional so cli's lightweight runner
   * (which only tracks `tokenEstimate`) stays compatible. Dashboard's
   * AgentManager-backed runner populates the full set.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** USD cost for this run, computed from adapter pricing. */
  costUsd?: number;
  /** Wall-clock ms. */
  durationMs?: number;
  /** Adapter-reported stop reason (end_turn, max_tokens, aborted, …). */
  stopReason?: string;
  /** Resolved model id. */
  model?: string;
  /** Live agent id — only the dashboard runner exposes this. */
  agentId?: string;
}

export interface AgentRunner {
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}
