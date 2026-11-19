// Local, offline-first game progress kept by the SDK itself. Pure functions, no I/O.
// Works with or without OBSIGAMA: this is the source of truth on the device.

import type { GameManifest, StatDef } from "./manifest";
import { findAchievement, findBoard, findStat } from "./manifest";
import type { StatValue, SyncEvent } from "./protocol";

export interface LocalState {
  v: 1;
  /** the game's "Connect to OBSIGAMA" toggle (opt-in, default off) */
  connect: boolean;
  /** OBSIGAMA account this device's progress was backfilled to, null = not linked yet */
  linkedUserId: string | null;
  /** user id the last full snapshot was queued for; null forces a new backfill snapshot */
  snapshotFor: string | null;
  /** the player said "no" in OBSIGAMA's consent dialog; cleared when the toggle is switched again */
  linkDenied: boolean;
  stats: Record<string, StatValue>;
  /** client time of the last "latest" stat write (conflict rule: newest wins) */
  statAt: Record<string, number>;
  achievements: Record<string, number>;
  best: Record<string, { value: number; at: number }>;
  queue: SyncEvent[];
  attempts: number;
  lastSyncAt: number | null;
  lastError: string | null;
  /** account-wide values from the last successful sync */
  server: Record<string, StatValue>;
}

export function emptyState(): LocalState {
  return {
    v: 1, connect: false, linkedUserId: null, snapshotFor: null, linkDenied: false,
    stats: {}, statAt: {}, achievements: {}, best: {}, queue: [], attempts: 0,
    lastSyncAt: null, lastError: null, server: {},
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Loads anything (old/corrupt/missing) into a valid state without throwing. */
export function normalizeState(raw: unknown): LocalState {
  const s = emptyState();
  if (!isObj(raw)) return s;
  s.connect = raw.connect === true;
  s.linkedUserId = typeof raw.linkedUserId === "string" ? raw.linkedUserId : null;
  s.snapshotFor = typeof raw.snapshotFor === "string" ? raw.snapshotFor : null;
  s.linkDenied = raw.linkDenied === true;
  if (isObj(raw.stats)) for (const [k, v] of Object.entries(raw.stats)) if (finite(v) || typeof v === "string") s.stats[k] = v;
  if (isObj(raw.statAt)) for (const [k, v] of Object.entries(raw.statAt)) if (finite(v)) s.statAt[k] = v;
  if (isObj(raw.achievements)) for (const [k, v] of Object.entries(raw.achievements)) if (finite(v)) s.achievements[k] = v;
  if (isObj(raw.best)) for (const [k, v] of Object.entries(raw.best)) if (isObj(v) && finite(v.value)) s.best[k] = { value: v.value, at: finite(v.at) ? v.at : 0 };
  if (Array.isArray(raw.queue)) s.queue = raw.queue.filter((e) => isObj(e) && typeof e.idem === "string" && typeof e.type === "string") as SyncEvent[];
  s.attempts = finite(raw.attempts) ? raw.attempts : 0;
  s.lastSyncAt = finite(raw.lastSyncAt) ? raw.lastSyncAt : null;
  s.lastError = typeof raw.lastError === "string" ? raw.lastError : null;
  if (isObj(raw.server)) for (const [k, v] of Object.entries(raw.server)) if (finite(v) || typeof v === "string") s.server[k] = v;
  return s;
}

/**
 * Conflict rule for one stat. `incoming` is a delta for sum/count and an absolute value otherwise.
 * Returns the new value, or undefined when nothing changes / the input is invalid.
 */
export function mergeStat(def: StatDef, current: StatValue | undefined, incoming: StatValue, opts: { at?: number; prevAt?: number; asTotal?: boolean } = {}): StatValue | undefined {
  if (def.agg === "latest") {
    if (def.type === "string" ? typeof incoming !== "string" : !finite(incoming)) return undefined;
    if (opts.prevAt != null && opts.at != null && opts.at < opts.prevAt) return undefined; // older write loses
    return incoming;
  }
  if (!finite(incoming)) return undefined;
  const cur = finite(current) ? current : 0;
  let next: number;
  switch (def.agg) {
    case "sum":
    case "count":
      if (opts.asTotal) next = Math.max(cur, incoming); // backfill/import of totals: never double count
      else {
        if (incoming < 0) return undefined; // totals never go down
        next = cur + (def.maxDelta != null ? Math.min(incoming, def.maxDelta) : incoming);
      }
      break;
    case "max":
      next = current === undefined ? incoming : Math.max(cur, incoming);
      break;
    case "min":
      next = current === undefined ? incoming : Math.min(cur, incoming);
      break;
    default:
      return undefined;
  }
  if (def.max != null) next = Math.min(next, def.max);
  return next === current ? undefined : next;
}

/** Applies a stat report to local state. Returns true if it was valid (even if the value did not change). */
export function applyStat(s: LocalState, m: GameManifest, id: string, value: StatValue, at: number, asTotal = false): boolean {
  const def = findStat(m, id);
  if (!def) return false;
  if (def.agg !== "latest" && !finite(value)) return false;
  const next = mergeStat(def, s.stats[id], value, { at, prevAt: s.statAt[id], asTotal });
  if (next !== undefined) {
    s.stats[id] = next;
    if (def.agg === "latest") s.statAt[id] = at;
  }
  return true;
}

/** Keeps the best score per leaderboard. Returns "best" if it is a new personal best, "ok" if valid, "invalid". */
export function applyScore(s: LocalState, m: GameManifest, lb: string, value: number, at: number): "best" | "ok" | "invalid" {
  const def = findBoard(m, lb);
  if (!def || !finite(value)) return "invalid";
  if ((def.min != null && value < def.min) || (def.max != null && value > def.max)) return "invalid";
  const cur = s.best[lb];
  const better = !cur || (def.sort === "desc" ? value > cur.value : value < cur.value);
  if (better) s.best[lb] = { value, at };
  return better ? "best" : "ok";
}

/** Union rule for achievements: once unlocked, always unlocked; the earliest time wins. */
export function applyAchievement(s: LocalState, m: GameManifest, id: string, at: number): boolean {
  if (!findAchievement(m, id)) return false;
  const cur = s.achievements[id];
  if (cur != null && cur <= at) return false;
  s.achievements[id] = at;
  return cur == null;
}

/** Stat-rule achievements evaluated locally (the server does the same). Returns new unlocks. */
export function evaluateRules(s: LocalState, m: GameManifest, at: number): string[] {
  const fresh: string[] = [];
  for (const a of m.achievements ?? []) {
    if (s.achievements[a.id] != null || !("stat" in a.rule)) continue;
    const v = s.stats[a.rule.stat];
    if (finite(v) && v >= a.rule.gte) { s.achievements[a.id] = at; fresh.push(a.id); }
  }
  return fresh;
}

export function mergeAchievementMaps(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) if (out[k] == null || v < out[k]) out[k] = v;
  return out;
}

/** Full progress snapshot used for backfill when linking (server merges with max/union rules). */
export function snapshotPayload(s: LocalState): Extract<SyncEvent, { type: "snapshot" }>["payload"] {
  const best: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.best)) best[k] = v.value;
  return { stats: { ...s.stats }, achievements: { ...s.achievements }, best };
}
