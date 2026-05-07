/**
 * Per-stage / per-repo forensic telemetry. Writes JSONL records under
 * `~/.anvil/runs/<runId>/per-repo-telemetry.jsonl` so silent-empty
 * artifacts and cost anomalies leave a trail next to the run record.
 *
 * Both cli and dashboard share this writer — the only difference is how
 * each consumer surfaces the synthesized "X bytes / Y tokens / $Z" line
 * back into its UI. cli echoes via stdout; dashboard fires a
 * project-event so the activity log catches it.
 *
 * Failures are non-fatal — telemetry MUST NOT break a run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PerRepoTelemetryRecord {
  /** Stage name (build, validate, repo-requirements, …). */
  stage: string;
  /** Repo identifier (or '__root__' for non-per-repo stages). */
  repo: string;
  /** Bytes in the final artifact written for this stage+repo. */
  outputBytes: number;
  /** Output token count from the adapter. */
  outputTokens: number;
  /** Input token count (prompt + cache hits). */
  inputTokens: number;
  /** Prompt cache read tokens — when 0, the prompt cache didn't hit. */
  cacheReadTokens?: number;
  /** Prompt cache write tokens — when non-zero, this run primed the cache. */
  cacheWriteTokens?: number;
  /** USD cost for this stage/repo. */
  costUsd: number;
  /** Adapter stop reason (end_turn, max_tokens, aborted, …). */
  stopReason?: string;
  /** Resolved model id used for this run. */
  model?: string;
}

export interface TelemetryWriterOptions {
  /** Run id — used to scope the JSONL file under `runs/<runId>/`. */
  runId: string;
  /** Override for the `.anvil` home directory. */
  anvilHome?: string;
  /** Optional callback for surfacing the record in the UI. */
  onRecord?: (record: PerRepoTelemetryRecord) => void;
}

/**
 * Append a single record to the run's telemetry JSONL file. Idempotent
 * mkdir + read-modify-write pattern — race-free for a single Node
 * process. If two pipelines wrote to the same file (they shouldn't),
 * the last write wins on the trailing newline. Acceptable for forensics.
 */
export function writePerRepoTelemetry(
  opts: TelemetryWriterOptions,
  record: PerRepoTelemetryRecord,
): void {
  try {
    const home = opts.anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    const runDir = join(home, 'runs', opts.runId);
    mkdirSync(runDir, { recursive: true });
    const file = join(runDir, 'per-repo-telemetry.jsonl');
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, existing + line);
    opts.onRecord?.(record);
  } catch {
    /* defensive — telemetry MUST NOT break the run */
  }
}

/** Format a one-line summary suitable for project-event activity logs. */
export function formatTelemetrySummary(record: PerRepoTelemetryRecord): string {
  const cost = record.costUsd.toFixed(5);
  return `[per-repo] ${record.stage}/${record.repo}: ${record.outputBytes} bytes, ${record.outputTokens} out tokens, $${cost}`;
}
