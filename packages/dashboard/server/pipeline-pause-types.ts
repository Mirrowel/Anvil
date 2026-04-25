/**
 * Types for Anvil's pipeline pause/resume primitives — Phase 3 of the
 * confidence-gated pipeline.
 *
 * When policy decides a stage must pause, a PauseState record is created and
 * persisted. Reviewers resume it via a ResumeDecision. A sweeper advances
 * stale pauses to 'timed-out'.
 */

export type PauseStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';

export type PauseStatus =
  | 'paused-awaiting-user'
  | 'resumed'
  | 'cancelled'
  | 'timed-out';

export interface ResumeDecision {
  action: 'approve' | 'modify' | 'cancel';
  note?: string;
  /** JSON patch for plan modification when action === 'modify'. */
  planPatch?: unknown;
}

export interface PauseState {
  runId: string;
  project: string;
  stage: PauseStage;
  /** Free-form reason shown in UI (usually carried from PolicyDecision.reason). */
  reason: string;
  /** Rule identifiers / globs from the policy evaluation that caused the pause. */
  matchedRules: string[];
  /** Usernames or group tags expected to approve. */
  reviewers: string[];
  /** ISO timestamp when the pause was recorded. */
  pausedAt: string;
  /** ISO timestamp at which the sweeper will fire, if any. */
  timeoutAt?: string;
  status: PauseStatus;
  resumeDecision?: ResumeDecision;
  /** ISO timestamp of resume/cancel/timeout transition. */
  resumedAt?: string;
  /** Username or 'system' (for sweeper). */
  resumedBy?: string;
}

export interface PauseQueryFilters {
  project?: string;
  status?: PauseStatus;
  stage?: PauseStage;
}

/** Lightweight record stored in the global index.json. */
export interface PausePointer {
  runId: string;
  project: string;
  status: PauseStatus;
  pausedAt: string;
}
