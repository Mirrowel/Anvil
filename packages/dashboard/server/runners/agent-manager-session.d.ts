/**
 * `AgentManagerSession` — implements `AgentSession` over the dashboard's
 * `AgentManager`. Used by stages that need multi-turn agent semantics
 * (clarify's explore→Q&A→synthesize, fix-loop's iterative fixes).
 *
 * The session id we expose is the same agentId the underlying
 * AgentManager assigns on `spawn()`. `sendInput` calls
 * `agentManager.sendInput(sessionId, text)` which spawns a NEW adapter
 * with `resume:true` against the same session id, then we wait via
 * `waitForAgent`.
 */
import type { AgentSession, AgentSessionResult, AgentRunRequest } from '@esankhan3/anvil-core-pipeline';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
export interface AgentManagerSessionOptions {
    agentManager: AgentManager;
    project: string;
    workspaceDir: string;
    isCancelled: () => boolean;
    /** Resolves the model to use for the initial spawn. */
    resolveModel: (stageName: string) => string;
    onSpawn?: (agentId: string, req: AgentRunRequest) => void;
    onTruncation?: (agentName: string, outputTokens: number) => void;
}
export declare class AgentManagerSession implements AgentSession {
    private readonly opts;
    constructor(opts: AgentManagerSessionOptions);
    start(req: AgentRunRequest): Promise<AgentSessionResult>;
    sendInput(sessionId: string, text: string): Promise<AgentSessionResult>;
    kill(sessionId: string): void;
}
//# sourceMappingURL=agent-manager-session.d.ts.map