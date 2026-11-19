// How Mini Old Games (plugin id "good-old-games", 12 games, CommonJS, stats in data.json) connects to OBSIGAMA.
// Based on the real structure of the plugin: main.js -> recordSession(id, r) and engine.onSession().
// The plugin is plain JS; the same calls work from JS (drop the types).
//
// 1. Copy packages/sdk/src into the game as e.g. src/s-sdk/ (or add it as a dependency) and bundle it.
// 2. Ship obsigama-manifest.json with the plugin and register it on the OBSIGAMA server once (scripts/manifest-to-sql.mjs).
// 3. Wire three places: onload, recordSession, the settings tab. That's all.

import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { addConnectSetting, SClient, type GameManifest, type SdkLang } from "@obsigama/sdk";
import manifestJson from "./obsigama-manifest.json";

const manifest = manifestJson as GameManifest;

/** Shapes from Mini-Old-Games src/core/stats.js (only the fields we use). */
interface GameStats { played: number; best: number; wins: number; totalTime: number }
interface MiniGamesStats { games: Record<string, GameStats>; ach: Record<string, number> }
/** r = { score, ms, win, diff, extra } from host.js */
interface SessionResult { score?: number; ms?: number; win?: boolean }

export class MiniGamesS {
  client!: SClient;

  /** onload(): after `this.stats` is loaded. Never throws; the game works the same without OBSIGAMA. */
  static async init(plugin: Plugin, stats: MiniGamesStats, lang: SdkLang): Promise<MiniGamesS> {
    const me = new MiniGamesS();
    me.client = await SClient.create({ plugin, manifest });
    // one-time (idempotent) import of progress made before the SDK existed: totals, bests, unlocks
    me.client.importTotals(MiniGamesS.totals(stats));
    me.client.on("badge", (b) => new Notice(lang === "ru" ? `Значок ${b.name} в профиле OBSIGAMA` : `OBSIGAMA badge earned: ${b.name}`, 6000));
    return me;
  }

  static totals(stats: MiniGamesStats) {
    const out: Record<string, number> = { runs: 0, playtime_ms: 0, wins: 0 };
    const best: Record<string, number> = {};
    for (const [id, g] of Object.entries(stats.games ?? {})) {
      if (!g || !g.played) continue;
      out[`${id}.runs`] = g.played;
      out[`${id}.best`] = g.best || 0;
      out[`${id}.wins`] = g.wins || 0;
      out.runs += g.played;
      out.playtime_ms += g.totalTime || 0;
      out.wins += g.wins || 0;
      if (g.best > 0) best[id] = g.best;
    }
    return { stats: out, best, achievements: stats.ach ?? {} };
  }

  /**
   * In MiniGamesPlugin.recordSession(id, r), right after `const fresh = engine.onSession(...)`:
   *   this.s?.onSession(id, r, fresh.map(a => a.id));
   * Sends this one game's result in a single request if "Connect to OBSIGAMA" is on; otherwise only local.
   */
  onSession(gameId: string, r: SessionResult, freshAchievementIds: string[]): void {
    const score = Math.max(0, Math.round(r.score || 0));
    const ms = Math.max(0, Math.round(r.ms || 0));
    const win = r.win === true ? 1 : 0;
    void this.client.endRun({
      durationMs: ms,
      stats: { runs: 1, playtime_ms: ms, wins: win, [`${gameId}.runs`]: 1, [`${gameId}.best`]: score, [`${gameId}.wins`]: win },
      scores: score > 0 ? { [gameId]: score } : {},
      achievements: freshAchievementIds, // Mini Old Games achievements are claim-type in the manifest
    });
  }
}

/**
 * In MiniGamesSettingTab: add the toggle + live status line at the end of display(),
 * and stop status updates in hide().
 */
export class MiniGamesSettingTabWithS extends PluginSettingTab {
  private disposeS: (() => void) | null = null;
  constructor(private p: Plugin & { s?: MiniGamesS; settings: { language: SdkLang } }) { super(p.app, p); }
  display(): void {
    const el = this.containerEl;
    el.empty();
    // ... existing settings ...
    if (this.p.s) {
      new Setting(el).setName("OBSIGAMA").setHeading();
      this.disposeS = addConnectSetting(el, this.p.s.client, Setting, { lang: this.p.settings.language });
    }
  }
  hide(): void {
    this.disposeS?.();
    this.disposeS = null;
  }
}
