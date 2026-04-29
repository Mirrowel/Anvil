/**
 * `@anvil/agent-core/router` — barrel.
 *
 * Public surface for the LLM router subsystem. See
 * `AGENT-CORE-LLM-ROUTER-PLAN.md` for the phased rollout.
 */

export type {
  ErrorClass,
  RetryPolicy,
  RouteFallback,
  RouteConfig,
  BudgetConfig,
  CircuitBreakerConfig,
  RateLimitProviderConfig,
  RouterConfig,
  InvokeOpts,
  RouteAttempt,
  RouteOutcome,
} from './types.js';
export { ALL_ERROR_CLASSES } from './types.js';
export { LlmRouter } from './router.js';
export type { LlmRouterDeps } from './router.js';
export { RouterError, classifyError, parseRetryAfterMs } from './errors.js';
