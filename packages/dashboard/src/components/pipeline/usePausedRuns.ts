// React hook that tracks paused pipeline runs for a project over a WebSocket
// connection. All setState calls inside the message handler are functional to
// avoid the stale-closure bug class we fight elsewhere in the dashboard.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PausedRunData, ResumeAction } from './pipeline-ui-types.js';

export interface UsePausedRunsResult {
  pauses: PausedRunData[];
  resume: (
    runId: string,
    action: ResumeAction,
    note?: string,
    patch?: unknown,
  ) => void;
  loading: boolean;
}

interface WsEnvelope {
  type?: string;
  payload?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function extractPauseList(payload: unknown): PausedRunData[] | null {
  if (!isRecord(payload)) return null;
  const list = payload.pauses;
  if (Array.isArray(list)) return list as PausedRunData[];
  return null;
}

function extractPausedRun(payload: unknown): PausedRunData | null {
  if (!isRecord(payload)) return null;
  // Server may either wrap the record under `pause` or inline `pause` +
  // optional extras at the top level.
  const candidate = isRecord(payload.pause) ? payload : null;
  if (!candidate) return null;
  return candidate as unknown as PausedRunData;
}

function extractRunId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.runId === 'string') return payload.runId;
  const pause = isRecord(payload.pause) ? payload.pause : null;
  if (pause && typeof pause.runId === 'string') return pause.runId;
  return null;
}

export function usePausedRuns(
  ws: WebSocket | null,
  project: string | null,
): UsePausedRunsResult {
  const [pauses, setPauses] = useState<PausedRunData[]>([]);
  const [loading, setLoading] = useState(false);

  // Keep project available inside the message handler without re-subscribing.
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  // Initial fetch on mount (and when ws/project changes).
  useEffect(() => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    setLoading(true);
    setPauses([]);
    ws.send(JSON.stringify({ action: 'list-pipeline-pauses', project }));
  }, [ws, project]);

  // WS subscription — scoped to `ws` only; all state reads go through
  // functional setState to keep this handler free of stale closures.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      let msg: WsEnvelope;
      try { msg = JSON.parse(event.data as string) as WsEnvelope; } catch { return; }
      const t = msg.type;
      if (!t) return;

      switch (t) {
        case 'pipeline-pauses': {
          const list = extractPauseList(msg.payload);
          if (list) {
            // Only accept lists that match the current project, if the server
            // echoes it. Otherwise trust the server-side filter.
            const scoped = isRecord(msg.payload) && typeof msg.payload.project === 'string'
              ? msg.payload.project === projectRef.current
              : true;
            if (scoped) {
              setPauses(() => list);
              setLoading(false);
            }
          }
          break;
        }
        case 'pipeline-paused': {
          const incoming = extractPausedRun(msg.payload);
          if (!incoming) break;
          if (projectRef.current && incoming.pause.project !== projectRef.current) break;
          setPauses((prev) => {
            const i = prev.findIndex((p) => p.pause.runId === incoming.pause.runId);
            if (i === -1) return [incoming, ...prev];
            const next = prev.slice();
            next[i] = incoming;
            return next;
          });
          break;
        }
        case 'pipeline-resumed': {
          const runId = extractRunId(msg.payload);
          if (!runId) break;
          setPauses((prev) => prev.filter((p) => p.pause.runId !== runId));
          break;
        }
        case 'pipeline-resume-error': {
          // Clear the in-flight flag but keep the pause visible so the user
          // can try again.
          setLoading(false);
          break;
        }
        default: break;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
    // Deliberately exclude `project` — functional setState + projectRef keep
    // this stable without re-subscribing on every project change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const resume = useCallback(
    (runId: string, action: ResumeAction, note?: string, patch?: unknown) => {
      if (!ws) return;
      ws.send(JSON.stringify({
        action: 'resume-pipeline',
        runId,
        decision: { action, note, planPatch: patch },
      }));
    },
    [ws],
  );

  return { pauses, resume, loading };
}

export default usePausedRuns;
