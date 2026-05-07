/**
 * `AgentSession` — multi-turn agent invocation surface.
 *
 * Extends the one-shot `AgentRunner` shape to model stages that need to
 * resume the same agent across multiple user turns (clarify's
 * explore→Q&A→synthesize loop, fix-loop's iterative fix attempts).
 *
 * The contract:
 *   - `start(req)` — spawn an agent and run it through its first turn.
 *     Returns the same shape as `AgentRunner.run` plus a `sessionId`
 *     handle the caller passes back into `sendInput`.
 *   - `sendInput(sessionId, text)` — feed a follow-up user message to
 *     the same agent. Returns the next turn's result.
 *   - `kill(sessionId)` — abort and clean up.
 *
 * Both consumers (cli's lightweight runner and dashboard's
 * AgentManager-backed runner) implement this same shape so stage logic
 * — clarify, fix-loop — can drive multi-turn agents without caring
 * which substrate is underneath.
 */

import type { AgentRunRequest, AgentRunResult } from './agent-runner.js';

export interface AgentSession {
  /**
   * Start a new agent session. Runs the agent through its first turn
   * and returns the result plus a sessionId handle.
   */
  start(req: AgentRunRequest): Promise<AgentSessionResult>;
  /**
   * Resume an existing session with a follow-up user message. The
   * sessionId must match a prior `start` call. Returns the next turn's
   * result.
   */
  sendInput(sessionId: string, text: string): Promise<AgentSessionResult>;
  /** Abort and clean up an in-flight session. */
  kill(sessionId: string): void;
}

export interface AgentSessionResult extends AgentRunResult {
  /** Handle to pass back into `sendInput`. */
  sessionId: string;
}
