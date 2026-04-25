// Client-side mirror of server pipeline pause/resume types. Kept in a
// dedicated module so UI components stay decoupled from server internals.

export type PauseStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';
export type PauseStatus = 'paused-awaiting-user' | 'resumed' | 'cancelled' | 'timed-out';
export type RiskTier = 'low' | 'med' | 'high';

export interface RiskFactor {
  key: string;
  label: string;
  weight: number;
  detail?: string;
}

export interface RiskScore {
  overall: number;
  tier: RiskTier;
  factors: RiskFactor[];
  confidence: number;
  scopeBoundaryRisks: string[];
}

export interface PauseState {
  runId: string;
  project: string;
  stage: PauseStage;
  reason: string;
  matchedRules: string[];
  reviewers: string[];
  pausedAt: string;
  timeoutAt?: string;
  status: PauseStatus;
}

export interface TokenCostEstimate {
  usd: number;
  inTokens: number;
  outTokens: number;
}

export interface PausedRunData {
  pause: PauseState;
  riskScore?: RiskScore;
  planSummary?: string;
  touchedFiles?: string[];
  predictedDiff?: string;
  tokenCostEstimate?: TokenCostEstimate;
}

export type ResumeAction = 'approve' | 'modify' | 'reject-cancel' | 'replan-with-note';

export interface ResumeDecision {
  action: ResumeAction;
  note?: string;
  planPatch?: unknown;
}
