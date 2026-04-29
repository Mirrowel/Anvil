/**
 * Minimal in-process EventBus — Phase 1 scaffold.
 *
 * Phase 2 matures this with priority ordering, listener-isolation guarantees,
 * and adapter for cli's existing `state-machine.ts` emitter. This stub exists
 * so Pipeline + StepRegistry compile against it.
 */

import type { EventBus, EventListener, PipelineEvent, StepHookPoint } from './types.js';

export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Map<StepHookPoint, EventListener[]>();

  on(hook: StepHookPoint, listener: EventListener): () => void {
    const arr = this.listeners.get(hook) ?? [];
    arr.push(listener);
    this.listeners.set(hook, arr);
    return () => this.off(hook, listener);
  }

  once(hook: StepHookPoint, listener: EventListener): () => void {
    const wrapped: EventListener = async (e) => {
      this.off(hook, wrapped);
      await listener(e);
    };
    return this.on(hook, wrapped);
  }

  off(hook: StepHookPoint, listener: EventListener): void {
    const arr = this.listeners.get(hook);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
  }

  async emit(event: PipelineEvent): Promise<void> {
    const arr = this.listeners.get(event.hook);
    if (!arr || arr.length === 0) return;
    const snapshot = arr.slice();
    for (const listener of snapshot) {
      await listener(event);
    }
  }

  emitFireAndForget(event: PipelineEvent): void {
    const arr = this.listeners.get(event.hook);
    if (!arr || arr.length === 0) return;
    for (const listener of arr.slice()) {
      try {
        const ret = listener(event);
        if (ret && typeof (ret as Promise<void>).then === 'function') {
          (ret as Promise<void>).catch(() => {
            /* swallow — fire-and-forget */
          });
        }
      } catch {
        /* swallow — fire-and-forget */
      }
    }
  }
}
