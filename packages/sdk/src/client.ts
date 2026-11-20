// SClient: the one object a game plugin creates. Offline-first: every call updates local
// progress immediately and works without OBSIGAMA. When the player turns on "Connect to OBSIGAMA",
// the SDK links to OBSIGAMA (in the same vault) and sends each finished run in one batch.

import type { GameManifest, StatDef } from "./manifest";
import { findStat, validateManifest } from "./manifest";
import {
  PLATFORM_PLUGIN_ID, PLATFORM_READY_EVENT, PLATFORM_UNLOAD_EVENT, PROTOCOL_VERSION,
  type AwardedBadge, type EventResult, type PlatformAPI, type PlatformStatus, type StatValue, type SyncEvent,
} from "./protocol";
import { applyResults, backoffMs, compact, enqueue, newIdem, replaceWithSnapshot, SERVER_DEFAULT_MAX_DELTA, takeBatch } from "./queue";
import {
  applyAchievement, applyScore, applyStat, evaluateRules, normalizeState, snapshotPayload,
  type LocalState,
} from "./state";
import { pluginFileStorage, type PluginLike, type SdkStorage } from "./storage";

export type SyncState =
  | "off" // "Connect to OBSIGAMA" is off: local only
  | "no-platform" // OBSIGAMA is not installed / not enabled in this vault
  | "platform-disabled" // OBSIGAMA's "Online / sync" switch is off
  | "not-configured" // OBSIGAMA has no server configured
  | "signed-out" // nobody is signed in to OBSIGAMA
  | "needs-link" // player must approve this game in OBSIGAMA (press "Sync now")
  | "link-denied"
  | "syncing"
  | "synced" // nothing pending
  | "pending" // something queued, will be sent after the next run / when OBSIGAMA is back
  | "error";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncAt: number | null;
  lastError: string | null;
  platformName: string;
  username: string | null;
}

/** Result of one finished match/run. Everything optional. */
export interface RunResult {
  durationMs?: number;
  /** sum/count stats: deltas for this run; max/min/latest: values */
  stats?: Record<string, StatValue>;
  /** leaderboard id -> score of this run */
  scores?: Record<string, number>;
  /** claim-type achievements the game unlocked during this run */
  achievements?: string[];
}

export interface SClientOptions {
  plugin: PluginLike;
  manifest: GameManifest;
  storage?: SdkStorage;
  /** for tests */
  now?: () => number;
  /** for tests: replaces discovery through app.plugins */
  platform?: () => PlatformAPI | null;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** log rejected events etc. Default: console.warn */
  log?: (...a: unknown[]) => void;
}

type Events = {
  status: SyncStatus;
  achievement: { id: string; source: "local" | "server" };
  badge: AwardedBadge;
  synced: { accepted: number; rejected: EventResult[] };
};

const DEFAULT_PLATFORM_NAME = "OBSIGAMA";

export class SClient {
  readonly manifest: GameManifest;
  private state: LocalState = normalizeState(null);
  private storage: SdkStorage;
  private now: () => number;
  private listeners: Partial<Record<keyof Events, Set<(d: never) => void>>> = {};
  private flushing = false;
  private again = false;
  private retryTimer: unknown = null;
  private saveTimer: unknown = null;
  private saving: Promise<void> = Promise.resolve();
  private unsubPlatform: (() => void) | null = null;
  private boundApi: PlatformAPI | null = null;
  private destroyed = false;
  private busy = false;
  private lastStatusKey = "";

  private constructor(private opts: SClientOptions) {
    this.manifest = opts.manifest;
    this.storage = opts.storage ?? pluginFileStorage(opts.plugin);
    this.now = opts.now ?? Date.now;
    const errs = validateManifest(opts.manifest);
    if (errs.length) this.log("[OBSIGAMA SDK] manifest problems:", errs);
  }

  /** Creates the client and loads local progress. Never throws. */
  static async create(opts: SClientOptions): Promise<SClient> {
    const c = new SClient(opts);
    try {
      c.state = normalizeState(await c.storage.load());
    } catch (e) {
      c.log("[OBSIGAMA SDK] could not load local state", e);
    }
    c.watchPlatform();
    opts.plugin.register?.(() => c.destroy());
    if (c.state.connect && c.state.queue.length) void c.flush();
    return c;
  }

  // ---------- local progress (works offline, without OBSIGAMA) ----------

  getStats(): Readonly<Record<string, StatValue>> { return this.state.stats; }
  getAchievements(): Readonly<Record<string, number>> { return this.state.achievements; }
  getBest(lb: string): number | null { return this.state.best[lb]?.value ?? null; }
  /** account-wide values from the last sync (empty until synced) */
  getServerStats(): Readonly<Record<string, StatValue>> { return this.state.server; }

  /** Report a stat outside a run. Sent with the next run end / sync. */
  reportStat(id: string, value: StatValue): void {
    this.safe(() => {
      const at = this.now();
      if (!applyStat(this.state, this.manifest, id, value, at)) return this.log(`[OBSIGAMA SDK] unknown or invalid stat "${id}"`);
      this.queue([{ idem: newIdem(at), at, type: "stat", payload: { id, value } }]);
      this.afterLocalChange(at);
    });
  }

  submitScore(lb: string, value: number): void {
    this.safe(() => {
      const at = this.now();
      if (applyScore(this.state, this.manifest, lb, value, at) === "invalid") return this.log(`[OBSIGAMA SDK] invalid score for "${lb}"`);
      this.queue([{ idem: newIdem(at), at, type: "score", payload: { lb, value } }]);
      this.saveSoon();
    });
  }

  unlockAchievement(id: string): void {
    this.safe(() => {
      const at = this.now();
      if (!applyAchievement(this.state, this.manifest, id, at)) return;
      this.queue([{ idem: newIdem(at), at, type: "achievement", payload: { id, unlockedAt: at } }]);
      this.emit("achievement", { id, source: "local" });
      this.saveSoon();
    });
  }

  /**
   * Call once when a match/run ends. Applies the results locally and, when connected,
   * sends them right away in one request. If OBSIGAMA is off or offline they wait in the queue
   * and go out with the next run or when OBSIGAMA comes back. Never throws.
   */
  async endRun(r: RunResult): Promise<void> {
    try {
      const at = this.now();
      const ev: SyncEvent[] = [];
      const dur = r.durationMs != null && Number.isFinite(r.durationMs) ? Math.max(0, Math.round(r.durationMs)) : 0;
      ev.push({ idem: newIdem(at), at, type: "session", payload: { durationMs: dur } });
      for (const [id, v] of Object.entries(r.stats ?? {})) {
        if (applyStat(this.state, this.manifest, id, v, at)) ev.push({ idem: newIdem(at), at, type: "stat", payload: { id, value: v } });
        else this.log(`[OBSIGAMA SDK] unknown or invalid stat "${id}"`);
      }
      for (const [lb, v] of Object.entries(r.scores ?? {})) {
        if (applyScore(this.state, this.manifest, lb, v, at) !== "invalid") ev.push({ idem: newIdem(at), at, type: "score", payload: { lb, value: v } });
        else this.log(`[OBSIGAMA SDK] invalid score for "${lb}"`);
      }
      for (const id of r.achievements ?? []) {
        if (applyAchievement(this.state, this.manifest, id, at)) {
          ev.push({ idem: newIdem(at), at, type: "achievement", payload: { id, unlockedAt: at } });
          this.emit("achievement", { id, source: "local" });
        }
      }
      this.queue(ev);
      this.afterLocalChange(at, false);
      await this.persist();
      if (this.state.connect) await this.flush();
    } catch (e) {
      this.log("[OBSIGAMA SDK] endRun failed", e);
    }
  }

  /**
   * One-time import of progress the game already had before it used the SDK (totals, bests,
   * unlocked achievements). Merge rules: totals and maxima take the larger value, achievements union.
   */
  importTotals(data: { stats?: Record<string, StatValue>; best?: Record<string, number>; achievements?: Record<string, number> | string[] }): void {
    this.safe(() => {
      const at = this.now();
      let changed = false;
      for (const [id, v] of Object.entries(data.stats ?? {})) {
        const before = this.state.stats[id];
        applyStat(this.state, this.manifest, id, v, at, true);
        changed ||= before !== this.state.stats[id];
      }
      for (const [lb, v] of Object.entries(data.best ?? {})) changed = applyScore(this.state, this.manifest, lb, v, at) === "best" || changed;
      const ach = Array.isArray(data.achievements) ? Object.fromEntries(data.achievements.map((id) => [id, at])) : data.achievements ?? {};
      for (const [id, t] of Object.entries(ach)) changed = applyAchievement(this.state, this.manifest, id, Number.isFinite(t) ? t : at) || changed;
      evaluateRules(this.state, this.manifest, at);
      if (changed) {
        this.state.snapshotFor = null; // next sync backfills the new totals
        this.saveSoon();
      }
    });
  }

  // ---------- connection to OBSIGAMA ----------

  isConnectEnabled(): boolean { return this.state.connect; }

  /** The game's own "Connect to OBSIGAMA" toggle. Turning it on asks OBSIGAMA for consent and backfills everything. */
  async setConnect(on: boolean): Promise<void> {
    this.state.connect = on;
    this.state.linkDenied = false;
    this.state.snapshotFor = null; // resend a full snapshot: covers anything played while off
    if (!on) this.clearRetry();
    await this.persist();
    this.notifyStatus(true);
    if (on) await this.flush({ interactive: true });
  }

  /** Manual "Sync now" (may show OBSIGAMA's consent dialog). */
  syncNow(): Promise<void> {
    this.state.linkDenied = false;
    return this.flush({ interactive: true });
  }

  openPlatform(): void {
    try { this.platform()?.openHub(); } catch { /* ignore */ }
  }

  get platformName(): string {
    try { return this.platform()?.platformName ?? DEFAULT_PLATFORM_NAME; } catch { return DEFAULT_PLATFORM_NAME; }
  }

  getStatus(): SyncStatus {
    const base = { pending: this.state.queue.length, lastSyncAt: this.state.lastSyncAt, lastError: this.state.lastError, platformName: this.platformName, username: null as string | null };
    if (!this.state.connect) return { ...base, state: "off" };
    const api = this.platform();
    if (!api) return { ...base, state: "no-platform" };
    let ps: PlatformStatus;
    try { ps = api.getStatus(); } catch { return { ...base, state: "no-platform" }; }
    base.username = ps.username;
    if (!ps.enabled) return { ...base, state: "platform-disabled" };
    if (!ps.configured) return { ...base, state: "not-configured" };
    if (!ps.signedIn) return { ...base, state: "signed-out" };
    if (this.state.linkDenied) return { ...base, state: "link-denied" };
    if (this.state.linkedUserId !== ps.userId || !safeBool(() => api.isLinked(this.manifest.gameId))) return { ...base, state: "needs-link" };
    if (this.busy) return { ...base, state: "syncing" };
    if (this.state.lastError && this.state.queue.length) return { ...base, state: "error" };
    return { ...base, state: this.state.queue.length || this.state.snapshotFor !== ps.userId ? "pending" : "synced" };
  }

  on<K extends keyof Events>(ev: K, cb: (d: Events[K]) => void): () => void {
    const set = (this.listeners[ev] ??= new Set()) as unknown as Set<(d: Events[K]) => void>;
    set.add(cb);
    return () => { set.delete(cb); };
  }

  /** Sends what is queued. Safe to call any time; does nothing when not connected. */
  async flush(o: { interactive?: boolean } = {}): Promise<void> {
    if (!this.state.connect || this.destroyed) return this.notifyStatus();
    if (this.flushing) { this.again = true; return; }
    this.flushing = true;
    try {
      do {
        this.again = false;
        await this.flushOnce(!!o.interactive);
      } while (this.again && !this.destroyed);
    } finally {
      this.flushing = false;
      this.busy = false;
      this.notifyStatus();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearRetry();
    if (this.saveTimer != null) { this.clear(this.saveTimer); this.saveTimer = null; void this.persist(); }
    this.unsubPlatform?.();
    this.unsubPlatform = null;
  }

  // ---------- internals ----------

  private async flushOnce(interactive: boolean): Promise<void> {
    const api = this.platform();
    if (!api) return;
    const ps = safe(() => api.getStatus());
    if (!ps || !ps.enabled || !ps.configured || !ps.signedIn || !ps.userId) return;
    if (this.state.linkDenied && !interactive) return;

    if (this.state.linkedUserId !== ps.userId || !safeBool(() => api.isLinked(this.manifest.gameId))) {
      if (!interactive) return; // never pop a dialog by itself after a run
      const res = await api.requestLink({ gameId: this.manifest.gameId, pluginId: this.manifest.pluginId, name: this.manifest.name, manifest: this.manifest });
      if (!res.ok) {
        if (res.error === "denied") this.state.linkDenied = true;
        this.state.lastError = res.message ?? res.error;
        await this.persist();
        return;
      }
      this.state.linkedUserId = res.userId;
      this.state.linkDenied = false;
      this.state.snapshotFor = null;
    }

    if (this.state.snapshotFor !== ps.userId) {
      const at = this.now();
      this.state.queue = replaceWithSnapshot(this.state.queue, { idem: newIdem(at), at, type: "snapshot", payload: snapshotPayload(this.state) });
      this.state.snapshotFor = ps.userId;
    }
    this.state.queue = compact(this.state.queue, (id) => mergeCap(findStat(this.manifest, id)));
    if (!this.state.queue.length) { await this.persist(); return; }

    this.busy = true;
    this.notifyStatus();
    const batch = takeBatch(this.state.queue);
    await this.persist();
    let resp;
    try {
      resp = await api.submit({
        gameId: this.manifest.gameId, pluginId: this.manifest.pluginId, manifestVersion: this.manifest.manifestVersion,
        events: batch.map(({ sent: _s, ...e }) => e),
      });
    } catch (e) {
      resp = { ok: false as const, error: "network" as const, message: String((e as Error)?.message ?? e) };
    }
    this.busy = false;
    if (resp.ok) {
      const { queue, rejected } = applyResults(this.state.queue, resp.results);
      const accepted = this.state.queue.length - queue.length - rejected.length;
      this.state.queue = queue;
      this.state.attempts = 0;
      this.state.lastError = null;
      this.state.lastSyncAt = this.now();
      this.state.server = { ...resp.stats };
      for (const id of resp.unlocked) {
        if (applyAchievement(this.state, this.manifest, id, this.now())) this.emit("achievement", { id, source: "server" });
      }
      for (const b of resp.badges ?? []) this.emit("badge", b);
      if (rejected.length) this.log("[OBSIGAMA SDK] rejected by server:", rejected);
      this.clearRetry();
      await this.persist();
      this.emit("synced", { accepted, rejected });
      if (this.state.queue.length && resp.results.length) this.again = true; // more than one batch
      return;
    }
    // failure: keep everything queued
    this.state.lastError = resp.message ?? resp.error;
    if (resp.error === "not-linked") this.state.linkedUserId = null;
    if (resp.error === "network" || resp.error === "server" || resp.error === "rate-limited") {
      this.state.attempts++;
      this.scheduleRetry(resp.retryAfterMs ?? backoffMs(this.state.attempts));
    }
    await this.persist();
  }

  private queue(events: SyncEvent[]): void {
    if (!this.state.connect || !events.length) return; // not connected: progress stays local, backfilled on connect
    if (enqueue(this.state.queue, events)) this.state.snapshotFor = null; // overflow: resend totals
  }

  private afterLocalChange(at: number, save = true): void {
    for (const id of evaluateRules(this.state, this.manifest, at)) this.emit("achievement", { id, source: "local" });
    if (save) this.saveSoon();
    this.notifyStatus();
  }

  private platform(): PlatformAPI | null {
    if (this.opts.platform) return this.opts.platform();
    try {
      const app = this.opts.plugin.app as { plugins?: { getPlugin?(id: string): unknown } };
      const p = app.plugins?.getPlugin?.(PLATFORM_PLUGIN_ID) as { api?: PlatformAPI } | null | undefined;
      const api = p?.api;
      return api && api.protocol === PROTOCOL_VERSION ? api : null;
    } catch {
      return null;
    }
  }

  private watchPlatform(): void {
    const attach = () => {
      const api = this.platform();
      if (api === this.boundApi) return;
      this.unsubPlatform?.();
      this.unsubPlatform = null;
      this.boundApi = api;
      if (api) {
        this.unsubPlatform = safe(() => api.onStatusChange(() => this.onPlatformChange())) ?? null;
        this.onPlatformChange();
      }
    };
    const ws = (this.opts.plugin.app as { workspace?: { on?(n: string, cb: () => void): unknown; onLayoutReady?(cb: () => void): void } }).workspace;
    try {
      const r1 = ws?.on?.(PLATFORM_READY_EVENT, attach);
      const r2 = ws?.on?.(PLATFORM_UNLOAD_EVENT, () => { this.unsubPlatform?.(); this.unsubPlatform = null; this.boundApi = null; this.notifyStatus(); });
      if (r1) this.opts.plugin.registerEvent?.(r1);
      if (r2) this.opts.plugin.registerEvent?.(r2);
      ws?.onLayoutReady?.(attach);
    } catch { /* not in Obsidian (tests) */ }
    attach();
  }

  /** OBSIGAMA came online / signed in / was switched back on: send what waited. */
  private onPlatformChange(): void {
    this.notifyStatus();
    const st = this.getStatus();
    if (st.state === "pending" || st.state === "error") void this.flush();
  }

  private notifyStatus(force = false): void {
    const s = this.getStatus();
    const key = JSON.stringify(s);
    if (!force && key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.emit("status", s);
  }

  private emit<K extends keyof Events>(ev: K, d: Events[K]): void {
    for (const cb of (this.listeners[ev] ?? []) as Iterable<(x: Events[K]) => void>) {
      try { cb(d); } catch (e) { this.log("[OBSIGAMA SDK] listener error", e); }
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.state)) as LocalState;
    this.saving = this.saving.then(() => this.storage.save(snapshot)).catch((e) => this.log("[OBSIGAMA SDK] save failed", e));
    return this.saving;
  }

  private saveSoon(): void {
    if (this.saveTimer != null || this.destroyed) return;
    this.saveTimer = this.timer(() => { this.saveTimer = null; void this.persist(); }, 1000);
  }

  private scheduleRetry(ms: number): void {
    this.clearRetry();
    this.retryTimer = this.timer(() => { this.retryTimer = null; void this.flush(); }, ms);
  }

  private clearRetry(): void {
    if (this.retryTimer != null) { this.clear(this.retryTimer); this.retryTimer = null; }
  }

  private timer(cb: () => void, ms: number): unknown {
    if (this.opts.setTimer) return this.opts.setTimer(cb, ms);
    return window.setTimeout(cb, ms); // popout-safe; tests inject setTimer
  }
  private clear(h: unknown): void {
    if (this.opts.clearTimer) this.opts.clearTimer(h);
    else window.clearTimeout(h as number);
  }

  private safe(fn: () => void): void {
    try { fn(); } catch (e) { this.log("[OBSIGAMA SDK] error", e); }
  }

  private log(...a: unknown[]): void {
    (this.opts.log ?? console.warn)(...a);
  }
}

/** How far unsent deltas of a stat may be merged: never past the per-event cap the server applies. */
function mergeCap(d: StatDef | undefined): number | false {
  if (!d || (d.agg !== "sum" && d.agg !== "count")) return false;
  const cap = d.maxDelta ?? SERVER_DEFAULT_MAX_DELTA;
  return Number.isFinite(cap) && cap > 0 ? cap : false;
}
function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}
function safeBool(fn: () => boolean): boolean {
  return safe(fn) === true;
}

