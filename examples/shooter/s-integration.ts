// How Vault Shards (the Doom-style 3D shooter, TypeScript) connects to S.
// Based on its real structure: progress.stats are cumulative counters (kills, k_quill, max_shards...),
// progress.achievements is { id: timestamp }, progress.lore lists found Codex pages.
//
// A "run" here = one play session in the game view: from opening the game tab to closing it,
// winning, or starting a new run. At the end we send the deltas of that session in ONE request.

import { Notice, Plugin, Setting } from "obsidian";
import { addConnectSetting, SClient, statusText, type GameManifest, type SdkLang } from "@s-platform/sdk";
import manifestJson from "./s-manifest.json";

const manifest = manifestJson as GameManifest;
const SUM = new Set(manifest.stats!.filter((s) => s.agg === "sum" || s.agg === "count").map((s) => s.id));
const MAXS = manifest.stats!.filter((s) => s.agg === "max").map((s) => s.id);

/** Shapes from vault-shards src/game/types.ts (only what we use). */
interface Progress { achievements: Record<string, number>; stats: Record<string, number>; lore: string[] }

const pages = (p: Progress) => p.lore.filter((l) => l.startsWith("d")).length;

export class ShooterS {
  client!: SClient;
  private start: Record<string, number> = {};
  private startedAt = 0;

  static async init(plugin: Plugin, progress: Progress, lang: SdkLang): Promise<ShooterS> {
    const me = new ShooterS();
    me.client = await SClient.create({ plugin, manifest });
    me.client.importTotals({
      stats: { ...pick(progress.stats, [...SUM, ...MAXS]), lore_pages: pages(progress) },
      best: progress.stats.best_time ? { fastest_win_s: progress.stats.best_time } : {},
      achievements: progress.achievements,
    });
    me.client.on("badge", (b) => new Notice(lang === "ru" ? `Значок S: ${b.name}` : `S badge: ${b.name}`, 6000));
    return me;
  }

  /** Call when the game view opens / a new run starts (ShardsView.onOpen, engine.startNew). */
  beginRun(progress: Progress): void {
    this.start = { ...progress.stats };
    this.startedAt = Date.now();
  }

  /**
   * Call when the session ends: engine.win(), ShardsView.onClose(), or before startNew().
   * Sum stats are sent as deltas since beginRun, max stats as current values.
   */
  endRun(progress: Progress, run: { kills: number; time: number; won: boolean }): void {
    if (!this.startedAt) return;
    const stats: Record<string, number> = { runs: 1, playtime_ms: Date.now() - this.startedAt, lore_pages: pages(progress) };
    for (const id of SUM) {
      if (id === "runs" || id === "playtime_ms") continue;
      const d = (progress.stats[id] || 0) - (this.start[id] || 0);
      if (d > 0) stats[id] = d;
    }
    for (const id of MAXS) if (progress.stats[id]) stats[id] = progress.stats[id];
    const scores: Record<string, number> = {};
    if (run.kills > 0) scores.kills_per_run = run.kills;
    if (run.won && run.time >= 60) scores.fastest_win_s = Math.round(run.time);
    const newAch = Object.keys(progress.achievements).filter((id) => !(id in this.client.getAchievements()));
    this.startedAt = 0;
    void this.client.endRun({ durationMs: stats.playtime_ms, stats, scores, achievements: newAch });
  }

  /** In ShardsSettingTab.display(); returns a dispose function for hide(). */
  addSettings(containerEl: HTMLElement, lang: SdkLang): () => void {
    new Setting(containerEl).setName("S").setHeading();
    return addConnectSetting(containerEl, this.client, Setting, { lang });
  }

  /** Optional: one line for the in-game menu. */
  statusLine(lang: SdkLang): string {
    return statusText(this.client.getStatus(), lang);
  }
}

function pick(o: Record<string, number>, keys: string[]): Record<string, number> {
  const r: Record<string, number> = {};
  for (const k of keys) if (typeof o[k] === "number") r[k] = o[k];
  return r;
}
