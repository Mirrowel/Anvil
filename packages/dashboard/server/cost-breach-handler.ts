/**
 * CostBreachHandler — Phase 8 breach state machine.
 *
 * When `CostLedger.summarize()` crosses a policy limit we create a
 * BreachState and notify the user. The run keeps running during the grace
 * window. The user responds with `raise` (approve a delta), `reject`
 * (stop the run; checkpoint handled by Phase 9), or `extend` (buy more
 * time, capped at 2 extensions).
 *
 * If the grace window expires without a decision the sweeper calls
 * `resolveExpired()` which applies the policy default (typically
 * auto-reject).
 *
 * Storage: per-project, per-run JSON files written atomically via tmp+rename:
 *   <storeDir>/<project>/<runId>.json
 *
 * This handler records *intent*. The effective limit is owned by the
 * caller (policy evaluator) — we just persist what the user approved.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { BreachDecision, BreachState, CostStage } from './cost-types.js';
import type { CostLedger } from './cost-ledger.js';

// ── Constants ────────────────────────────────────────────────────────────

const MAX_EXTENSIONS = 2;
const DEFAULT_GRACE_SECONDS = 60;

// ── Types ────────────────────────────────────────────────────────────────

export interface CostPolicy {
  limits?: {
    perRun?: number;
    perProjectDaily?: number;
  };
  graceWindowSeconds?: number;
  onBreach?: 'ask' | 'auto-approve' | 'auto-reject';
  /**
   * Only meaningful when `onBreach === 'auto-approve'`. If the overage is at
   * or below this value the breach is auto-raised silently.
   */
  autoApproveBelow?: number;
}

export interface BreachHandlerOptions {
  ledger: CostLedger;
  storeDir: string;
  /** Called when a breach is first detected and user input is needed. */
  onNotify: (
    state: BreachState,
    topSpenders: Array<{ stage: CostStage; usd: number }>,
  ) => Promise<void> | void;
  /** Called when the breach resolves to `rejected`. Phase 9 handles checkpoints. */
  onRejectStop: (runId: string) => Promise<void> | void;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function atomicWriteJson(filePath: string, value: unknown): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Handler ──────────────────────────────────────────────────────────────

class CostBreachHandler {
  private ledger: CostLedger;
  private storeDir: string;
  private onNotify: BreachHandlerOptions['onNotify'];
  private onRejectStop: BreachHandlerOptions['onRejectStop'];

  constructor(opts: BreachHandlerOptions) {
    this.ledger = opts.ledger;
    this.storeDir = opts.storeDir;
    this.onNotify = opts.onNotify;
    this.onRejectStop = opts.onRejectStop;
    ensureDir(this.storeDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  private breachPath(project: string, runId: string): string {
    return join(this.storeDir, project, `${runId}.json`);
  }

  private writeState(state: BreachState): BreachState {
    ensureDir(join(this.storeDir, state.project));
    atomicWriteJson(this.breachPath(state.project, state.runId), state);
    return state;
  }

  // ── Public: evaluate ──────────────────────────────────────────────────

  /**
   * Evaluate the current spend of a run against policy. If the limit is
   * breached and no breach is already pending, transitions based on
   * policy.onBreach. Returns the current BreachState (or null if no breach).
   */
  async evaluate(
    runId: string,
    project: string,
    policy: CostPolicy,
  ): Promise<BreachState | null> {
    const summary = this.ledger.summarize(runId, project);
    const perRunLimit = policy.limits?.perRun;
    const perDayLimit = policy.limits?.perProjectDaily;

    // Run-level check
    let effectiveLimit: number | undefined;
    let overage = 0;
    let currentSpend = summary.totalUsd;
    if (typeof perRunLimit === 'number' && summary.totalUsd > perRunLimit) {
      effectiveLimit = perRunLimit;
      overage = summary.totalUsd - perRunLimit;
    }
    // Project-daily check: if exceeded, it trumps the per-run limit.
    if (typeof perDayLimit === 'number') {
      const dailyTotal = this.ledger.projectDailyTotal(project);
      if (dailyTotal > perDayLimit) {
        effectiveLimit = perDayLimit;
        overage = dailyTotal - perDayLimit;
        currentSpend = dailyTotal;
      }
    }

    // Check expiry on any existing breach first.
    const existing = this.getBreach(runId);
    if (existing && existing.status === 'pending' && this.isExpired(existing)) {
      return this.resolveExpired(runId, policy);
    }

    if (effectiveLimit === undefined) return existing;

    // Breach detected — decide what to do.
    if (existing && existing.status !== 'pending') {
      // Already resolved (raised/rejected/auto-resolved) — respect it.
      return existing;
    }
    if (existing && existing.status === 'pending') {
      // Keep the existing pending breach; the sweeper/user will move it.
      return existing;
    }

    const mode = policy.onBreach ?? 'ask';
    const graceSec = policy.graceWindowSeconds ?? DEFAULT_GRACE_SECONDS;
    const now = new Date();
    const base: BreachState = {
      runId,
      project,
      breachedAt: now.toISOString(),
      limitUsdAtBreach: effectiveLimit,
      currentUsdAtBreach: round6(currentSpend),
      graceEndsAt: new Date(now.getTime() + graceSec * 1000).toISOString(),
      extensionsUsed: 0,
      status: 'pending',
    };

    if (mode === 'auto-reject') {
      const next: BreachState = {
        ...base,
        status: 'rejected',
        decision: 'reject',
        decisionAt: now.toISOString(),
      };
      this.writeState(next);
      await this.safeInvoke(() => this.onRejectStop(runId));
      return next;
    }

    if (mode === 'auto-approve') {
      const threshold = policy.autoApproveBelow ?? 0;
      if (overage <= threshold) {
        const next: BreachState = {
          ...base,
          status: 'raised',
          decision: 'raise',
          decisionAt: now.toISOString(),
          deltaUsdApproved: round6(overage),
        };
        return this.writeState(next);
      }
      // overage > auto-approve threshold — fall through to asking the user.
    }

    // ask (or auto-approve that didn't fit) — persist pending + notify.
    this.writeState(base);
    const top = this.ledger.topSpenders(runId, 3);
    await this.safeInvoke(() => this.onNotify(base, top));
    return base;
  }

  // ── Public: respond ───────────────────────────────────────────────────

  /**
   * Apply a user decision to a pending breach. Idempotent on terminal
   * states (does nothing if already raised/rejected/auto-resolved).
   */
  async respond(
    runId: string,
    decision: BreachDecision,
    deltaUsd?: number,
    extendSeconds?: number,
  ): Promise<BreachState> {
    const existing = this.getBreach(runId);
    if (!existing) throw new Error(`No breach found for run ${runId}`);
    if (existing.status !== 'pending') return existing;

    const now = new Date();

    if (decision === 'raise') {
      const next: BreachState = {
        ...existing,
        status: 'raised',
        decision: 'raise',
        decisionAt: now.toISOString(),
        deltaUsdApproved: round6(deltaUsd ?? 0),
      };
      return this.writeState(next);
    }

    if (decision === 'reject') {
      const next: BreachState = {
        ...existing,
        status: 'rejected',
        decision: 'reject',
        decisionAt: now.toISOString(),
      };
      this.writeState(next);
      await this.safeInvoke(() => this.onRejectStop(runId));
      return next;
    }

    // extend
    if (existing.extensionsUsed >= MAX_EXTENSIONS) {
      throw new Error(`Cannot extend — already used ${MAX_EXTENSIONS} extensions`);
    }
    const bumpSec = extendSeconds ?? 30;
    const nextGrace = new Date(
      Math.max(
        Date.parse(existing.graceEndsAt) || now.getTime(),
        now.getTime(),
      ) + bumpSec * 1000,
    ).toISOString();
    const next: BreachState = {
      ...existing,
      graceEndsAt: nextGrace,
      extensionsUsed: existing.extensionsUsed + 1,
    };
    return this.writeState(next);
  }

  // ── Public: queries ───────────────────────────────────────────────────

  /** Read a breach by runId across all projects. */
  getBreach(runId: string): BreachState | null {
    if (!existsSync(this.storeDir)) return null;
    for (const projectEntry of readdirSync(this.storeDir)) {
      const candidate = join(this.storeDir, projectEntry, `${runId}.json`);
      if (!existsSync(candidate)) continue;
      return readJson<BreachState>(candidate);
    }
    return null;
  }

  /** All pending breaches. Used by the sweeper. */
  listPending(): BreachState[] {
    const results: BreachState[] = [];
    if (!existsSync(this.storeDir)) return results;
    for (const projectEntry of readdirSync(this.storeDir)) {
      const projectPath = join(this.storeDir, projectEntry);
      let files: string[];
      try {
        files = readdirSync(projectPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
        const state = readJson<BreachState>(join(projectPath, file));
        if (state && state.status === 'pending') results.push(state);
      }
    }
    return results;
  }

  /**
   * Apply the policy default to a breach whose grace window has elapsed.
   * Called by the sweeper. Defaults to `auto-resolved` with `reject`.
   */
  async resolveExpired(runId: string, policy?: CostPolicy): Promise<BreachState | null> {
    const existing = this.getBreach(runId);
    if (!existing) return null;
    if (existing.status !== 'pending') return existing;

    const now = new Date().toISOString();
    const fallback = policy?.onBreach ?? 'auto-reject';
    // Grace expired — treat as auto-resolved. If policy says auto-approve
    // with a threshold ≥ overage, we'd have already raised above; otherwise
    // default to rejecting to err on the safe side.
    const finalDecision: BreachDecision = fallback === 'auto-approve' ? 'raise' : 'reject';

    const next: BreachState = {
      ...existing,
      status: 'auto-resolved',
      decision: finalDecision,
      decisionAt: now,
      deltaUsdApproved: finalDecision === 'raise'
        ? round6(existing.currentUsdAtBreach - existing.limitUsdAtBreach)
        : undefined,
    };
    this.writeState(next);
    if (finalDecision === 'reject') {
      await this.safeInvoke(() => this.onRejectStop(runId));
    }
    return next;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private isExpired(state: BreachState): boolean {
    const deadline = Date.parse(state.graceEndsAt);
    if (!Number.isFinite(deadline)) return false;
    return deadline < Date.now();
  }

  private async safeInvoke(fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[cost-breach-handler] callback error:', err);
    }
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export { CostBreachHandler, MAX_EXTENSIONS };
