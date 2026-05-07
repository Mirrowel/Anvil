/**
 * Stage-level chain fallback — wraps an `attempt(model)` callback and
 * retries with a fresh model when the inner call throws a retryable
 * upstream error (HTTP 429 / 502 / 503 / 504, or any error with
 * `name === 'UpstreamError' && retryable === true`).
 *
 * Lives in core-pipeline so cli and dashboard share the same retry
 * semantics. The model resolver is injected — dashboard plugs in its
 * liveness-aware `pickAliveModelFromChainSync`; cli plugs in a no-op
 * resolver that returns the same model each call (effectively no
 * fallback for cli today, but the surface is identical).
 */

export interface ChainFallbackOptions {
  /** Stage name for telemetry. */
  stageName: string;
  /** Resolves the next model to try, given the burned-set so it can skip. */
  resolveModel: (excludeModels: ReadonlySet<string>) => string;
  /**
   * Optional callback fired when a model gets burned. Lets the caller emit
   * a project-event / log line so the UI surfaces the fallback decision.
   */
  onBurn?: (info: BurnInfo) => void;
  /** Cap on attempts. Default 5. */
  maxAttempts?: number;
}

export interface BurnInfo {
  stageName: string;
  model: string;
  status: number | string;
  message: string;
}

/**
 * Run `attempt(model)` with chain fallback. On a retryable failure,
 * burn the failing model and retry with the next one resolveModel
 * picks. Non-retryable errors propagate immediately. Returns the
 * first attempt that succeeds, or throws the last error after
 * exhausting `maxAttempts`.
 */
export async function runWithChainFallback<T>(
  opts: ChainFallbackOptions,
  attempt: (model: string) => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const burned = new Set<string>();
  let lastErr: unknown;

  for (let i = 0; i < maxAttempts; i += 1) {
    const model = opts.resolveModel(burned);
    try {
      return await attempt(model);
    } catch (err) {
      lastErr = err;
      if (!isRetryableUpstreamError(err)) {
        throw err;
      }
      burned.add(model);
      const status = (err as { status?: number | string }).status ?? '?';
      const message = (err as Error).message?.slice(0, 200) ?? 'unknown';
      opts.onBurn?.({ stageName: opts.stageName, model, status, message });
    }
  }
  throw lastErr;
}

/**
 * Duck-type detector for the agent-core `UpstreamError` shape. Uses
 * structural matching instead of `instanceof` because module bundling
 * can desync class identity across packages.
 */
export function isRetryableUpstreamError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; retryable?: unknown; status?: unknown };
  if (e.retryable === true) return true;
  if (e.name === 'UpstreamError' && typeof e.status === 'number') {
    return e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504;
  }
  return false;
}
