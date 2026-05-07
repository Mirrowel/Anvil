// Shared types for pipeline stages
//
// AgentRunner now lives in @esankhan3/anvil-core-pipeline so the same
// interface drives both cli and dashboard stage logic. Re-exported here
// so existing cli imports keep working without churn.

import type { AgentRunner } from '@esankhan3/anvil-core-pipeline';

export type { AgentRunner, AgentRunRequest, AgentRunResult } from '@esankhan3/anvil-core-pipeline';

export interface StageContext {
  runDir: string;
  project: string;
  feature: string;
  agentRunner: AgentRunner;
  projectYamlPath?: string;
  conventionsPath?: string;
  /** Workspace directory containing cloned repos for this project. */
  workspaceDir?: string;
  /** Map of repo name → local disk path for all repos in this project. */
  repoPaths?: Record<string, string>;
}

export interface StageOutput {
  artifact: string;       // the markdown content
  artifactName: string;   // e.g., "CLARIFICATION.md"
  tokenEstimate: number;
}
