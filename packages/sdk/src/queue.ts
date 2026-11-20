// Offline sync queue. Pure functions, no timers, no I/O.

import type { EventResult, SyncEvent } from "./protocol";

export const MAX_QUEUE = 2000;
export const MAX_BATCH = 200;

let counter = 0;
/** Time-sortable unique id (ULID-like, base36). Idempotency key for one event. */
export function newIdem(now: number = Date.now(), rand: () => number = Math.random): string {
  counter = (counter + 1) % 1296;
  const r = Math.floor(rand() * 36 ** 8).toString(36).padStart(8, "0");
  return now.toString(36).padStart(9, "0") + counter.toString(36).padStart(2, "0") + r;
}

/**
 * Adds events. Returns true if the queue overflowed and dropped old events; the caller must
 * then request a fresh snapshot so totals are not lost.
 */
export function enqueue(q: SyncEvent[], events: SyncEvent[], max = MAX_QUEUE): boolean {
  q.push(...events);
  if (q.length <= max) return false;
  q.splice(0, q.length - max);
  return true;
}

/**
 * Puts a snapshot at the front and drops everything not yet sent that the snapshot already covers
 * (it contains the full local totals). Events already sent once stay, because the server may have
 * applied them; they are idempotent anyway.
 */
export function replaceWithSnapshot(q: SyncEvent[], snap: SyncEvent): SyncEvent[] {
  return [snap, ...q.filter((e) => e.sent && e.type !== "snapshot")];
}

/** Per-event cap the server applies to sum/count deltas when a stat declares no maxDelta. */
export const SERVER_DEFAULT_MAX_DELTA = 1_000_000;

/**
 * Merges never-sent sum/count deltas of the same stat to keep requests small.
 * `mergeCap(id)` returns `false` for stats that must not be merged, or the largest value one event may carry:
 * the server clamps every delta event to the stat's `maxDelta`, so merged events never grow beyond it
 * (two offline wins with maxDelta 1 stay two events; short runs' playtime is packed up to the cap).
 * `true` means "no cap" (merge freely). Only unsent events are merged, so an event whose response got lost
 * is never re-sent under a new key.
 */
export function compact(q: SyncEvent[], mergeCap: (id: string) => number | boolean): SyncEvent[] {
  const out: SyncEvent[] = [];
  const open = new Map<string, number>(); // stat id -> index in out of an unsent delta event that can still grow
  for (const e of q) {
    if (!e.sent && e.type === "stat" && typeof e.payload.value === "number") {
      const c = mergeCap(e.payload.id);
      const cap = c === true ? Infinity : c === false ? 0 : c;
      if (cap > 0) {
        const i = open.get(e.payload.id);
        if (i != null) {
          const prev = out[i] as Extract<SyncEvent, { type: "stat" }>;
          const sum = (prev.payload.value as number) + e.payload.value;
          if (sum <= cap) {
            out[i] = { ...prev, at: e.at, payload: { id: prev.payload.id, value: sum } };
            continue;
          }
        }
        if (e.payload.value < cap) open.set(e.payload.id, out.length);
        else open.delete(e.payload.id);
      }
    }
    out.push(e);
  }
  return out;
}

/** Takes up to `max` events for one request and marks them as sent. */
export function takeBatch(q: SyncEvent[], max = MAX_BATCH): SyncEvent[] {
  const batch = q.slice(0, max);
  for (const e of batch) e.sent = true;
  return batch;
}

const FINAL = new Set(["accepted", "duplicate", "rejected", "flagged", "deferred"]);

/** Removes events the server finished with. Returns the ones it rejected (for the game's log/UI). */
export function applyResults(q: SyncEvent[], results: EventResult[]): { queue: SyncEvent[]; rejected: EventResult[] } {
  const done = new Map(results.filter((r) => FINAL.has(r.status)).map((r) => [r.idem, r]));
  return {
    queue: q.filter((e) => !done.has(e.idem)),
    rejected: results.filter((r) => r.status === "rejected"),
  };
}

/** Retry delay after `attempt` consecutive failures: 30 s, 1 min, 2 min ... capped at 30 min, +-20 % jitter. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
  return Math.round(base * (0.8 + 0.4 * rand()));
}
