// How HELLVAULT (plugin id "vault-shards", Doom-like shooter: story, linear path, endless arena) connects to OBSIGAMA.
// Based on its real structure (HELLVAULT 2.0.1, src/main.ts + src/game/*):
//   data.progress.stats        cumulative counters: kills, k_<enemy>, deaths, wins, linear_wins, max_shards, ...
//   data.progress.achievements { id: timestamp }, data.progress.lore = found Codex ids ("d..." = diary pages)
//   data.records               top-10 arena runs { wave, reached, kills, time, difficulty, date }
// Run ends: Game.win() (story), Game.finishLinear() (linear path), Game.finishArena() (arena death).
// The game keeps working exactly the same without OBSIGAMA; this file only reads its data.

import { Notice, Plugin, Setting } from "obsidian";
import { addConnectSetting, SClient, statusText, type GameManifest, type SdkLang } from "@obsigama/sdk";
import manifestJson from "./obsigama-manifest.json";

const manifest = manifestJson as GameManifest;
const DEFS = manifest.stats!;
/** counters we read from progress.stats and send as deltas (runs/playtime/arena_runs are added by us) */
const SUM = DEFS.filter((s) => (s.agg === "sum" || s.agg === "count") && !["runs", "playtime_ms", "arena_runs"].includes(s.id)).map((s) => s.id);
/** flags and per-run maxima, sent as values, clamped to the manifest max (k_boss is incremented per boss kill) */
const MAXS = DEFS.filter((s) => s.agg === "max" && !["lore_pages", "best_arena_wave"].includes(s.id)).map((s) => ({ id: s.id, max: s.max ?? Infinity }));

/** Shapes from HELLVAULT src/game/types.ts (only what we use). */
interface ArenaRecord { wave: number; kills: number; time: number }
interface HellvaultData {
  progress: { achievements: Record<string, number>; stats: Record<string, number>; lore: string[] };
  records: ArenaRecord[];
}
export type RunKind = "story" | "linear" | "arena";
/** Game.run fields we use: kills and time (seconds) of this run, completedWave for the arena. */
export interface RunInfo { kills: number; time: number; completedWave?: number }

const pages = (d: HellvaultData) => d.progress.lore.filter((l) => l.startsWith("d")).length;
const bestWave = (d: HellvaultData) => d.records.reduce((m, r) => Math.max(m, r.wave || 0), 0);

export class HellvaultObsigama {
  client!: SClient;
  /** progress.stats at the moment of the last report; deltas are computed against it */
  private base: Record<string, number> = {};
  private since = Date.now();

  /** VaultShardsPlugin.onload(), right after `this.data = mergeData(...)`. Never throws. */
  static async init(plugin: Plugin, data: HellvaultData): Promise<HellvaultObsigama> {
    const me = new HellvaultObsigama();
    me.client = await SClient.create({ plugin, manifest });
    me.client.importTotals(HellvaultObsigama.totals(data)); // idempotent backfill of earlier progress
    me.rebase(data);
    me.client.on("badge", (b) => new Notice(`Значок OBSIGAMA: ${b.name}`, 6000));
    return me;
  }

  static totals(d: HellvaultData) {
    const s = d.progress.stats;
    const stats: Record<string, number> = { lore_pages: pages(d), best_arena_wave: bestWave(d) };
    for (const id of SUM) if (s[id]) stats[id] = s[id];
    for (const { id, max } of MAXS) if (s[id]) stats[id] = Math.min(s[id], max);
    const best: Record<string, number> = {};
    if (bestWave(d) > 0) best.arena_wave = bestWave(d);
    const k = d.records.reduce((m, r) => Math.max(m, r.kills || 0), 0);
    if (k > 0) best.arena_kills = k;
    if (s.best_time >= 60) best.fastest_win_s = s.best_time;
    return { stats, best, achievements: d.progress.achievements };
  }

  /** After "reset all progress" in the settings tab: start counting from the new (empty) data. */
  rebase(d: HellvaultData): void {
    this.base = { ...d.progress.stats };
    this.since = Date.now();
  }

  private collect(d: HellvaultData): Record<string, number> {
    const s = d.progress.stats;
    const out: Record<string, number> = { lore_pages: pages(d), best_arena_wave: bestWave(d) };
    for (const id of SUM) {
      const delta = (s[id] || 0) - (this.base[id] || 0);
      if (delta > 0) out[id] = delta;
    }
    for (const { id, max } of MAXS) if (s[id]) out[id] = Math.min(s[id], max);
    this.base = { ...s };
    return out;
  }

  /**
   * Call once when a run ends, AFTER the game updated its own data:
   *   story  -> end of Game.win() (only when `first` is true, so a replayed win screen does not count twice)
   *   linear -> end of Game.finishLinear()
   *   arena  -> end of Game.finishArena() (after the record was pushed)
   * One lightweight request when "Подключить к OBSIGAMA" is on; otherwise it is only queued locally.
   */
  endRun(d: HellvaultData, kind: RunKind, run: RunInfo): void {
    const playtime = Math.max(0, Date.now() - this.since);
    this.since = Date.now();
    const stats: Record<string, number> = { ...this.collect(d), runs: 1, playtime_ms: Math.min(playtime, 14_400_000) };
    const scores: Record<string, number> = {};
    if (kind === "arena") {
      stats.arena_runs = 1;
      scores.arena_wave = Math.max(0, Math.floor(run.completedWave || 0));
      if (run.kills > 0) scores.arena_kills = Math.floor(run.kills);
    }
    if (kind === "story" && run.time >= 60) scores.fastest_win_s = Math.round(run.time);
    // All 21 HELLVAULT achievements are stat rules in the manifest: the SDK and the server unlock them
    // from the stats above, so no achievement ids are sent (claims for rule achievements would be rejected).
    void this.client.endRun({ durationMs: stats.playtime_ms, stats, scores });
  }

  /** ShardsView.onClose(): progress made in an unfinished run is queued (no network, not counted as a run). */
  flushPartial(d: HellvaultData): void {
    for (const [id, v] of Object.entries(this.collect(d))) this.client.reportStat(id, v);
  }

  /** In ShardsSettingTab.display(); returns a dispose function for hide(). */
  addSettings(containerEl: HTMLElement, lang: SdkLang = "ru"): () => void {
    new Setting(containerEl).setName("OBSIGAMA").setHeading();
    return addConnectSetting(containerEl, this.client, Setting, { lang });
  }

  statusLine(lang: SdkLang = "ru"): string {
    return statusText(this.client.getStatus(), lang);
  }
}
