/**
 * `LlmRouter` — single source of truth for routing, retries, fallbacks,
 * rate-limits, spend tracking, and circuit breaking.
 *
 * Phase 1 ships only the type-safe skeleton. Subsequent phases fill in:
 *   - Phase 2 — per-error retry engine
 *   - Phase 3 — token-bucket rate limiter
 *   - Phase 4 — SQLite spend ledger
 *   - Phase 5 — fallback chain walker
 *   - Phase 6 — circuit breaker
 *   - Phase 7 — YAML config loader
 *   - Phase 8 — OTel parent/child spans
 */

import type { InvokeOpts, RouteOutcome, RouterConfig } from './types.js';

export interface LlmRouterDeps {
  config: RouterConfig;
}

export class LlmRouter {
  protected readonly config: RouterConfig;

  constructor(deps: LlmRouterDeps) {
    this.config = deps.config;
  }

  /**
   * Resolve a tag (or pinned model id) and execute the route walk.
   *
   * @throws RouterError with full attempt history on terminal failure.
   */
  async invoke(_opts: InvokeOpts): Promise<RouteOutcome> {
    throw new Error('LlmRouter.invoke not implemented (Phase 1 stub)');
  }

  /** Inspect the active config (immutable snapshot). */
  getConfig(): Readonly<RouterConfig> {
    return this.config;
  }
}
