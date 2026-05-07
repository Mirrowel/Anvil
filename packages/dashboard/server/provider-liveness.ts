/**
 * Provider liveness — re-exports from `@esankhan3/anvil-agent-core`.
 *
 * The implementation moved into agent-core so cli + dashboard share
 * one module-scoped cache and one set of probes. This shim keeps
 * existing dashboard imports working without churn; the back-compat
 * surface deletes after the consumers migrate to importing from
 * agent-core directly.
 */

export {
  setLivenessTtlMs,
  getLivenessTtlMs,
  isProviderAlive,
  pickAliveModelFromChain,
  pickAliveModelFromChainSync,
  prefetchLiveness,
  _resetLivenessCache,
} from '@esankhan3/anvil-agent-core';
