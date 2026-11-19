# Connecting a game plugin to OBSIGAMA

Your game stays a normal, fully offline Obsidian plugin. The SDK adds:

- **local progress** kept by the SDK itself (stats, best scores, achievements) in `obsigama-sync.json` next to your
  `data.json`; works with or without OBSIGAMA installed, never throws;
- an opt-in **"Connect to OBSIGAMA"** toggle for your settings tab (off by default) with a live sync status line;
- after **every finished run**, one small request with that run's results (only when connected);
- an offline **queue** with idempotency keys, backfill of everything earned before connecting, and retries.

Accounts exist only in OBSIGAMA. Your game never sees a password, token or Supabase key.

## 1. Add the SDK

The SDK is plain TypeScript with zero dependencies (`packages/sdk/src`, about 22 KB minified). Either copy that folder
into your plugin (e.g. `src/s-sdk/`) or add the package from git, and let esbuild bundle it.

## 2. Describe your game: `obsigama-manifest.json`

```json
{
  "gameId": "my-game",            // [a-z0-9-]{3,40}, unique on OBSIGAMA, never change it
  "pluginId": "my-game",          // your Obsidian plugin id
  "name": "My Game",
  "manifestVersion": 1,           // bump when you add things; old versions keep working
  "stats": [
    { "id": "runs",        "agg": "count" },
    { "id": "kills",       "agg": "sum",    "maxDelta": 2000 },
    { "id": "best_wave",   "agg": "max",    "max": 500 },
    { "id": "fastest_ms",  "agg": "min" },
    { "id": "last_weapon", "agg": "latest", "type": "string" }
  ],
  "leaderboards": [
    { "id": "score", "sort": "desc", "min": 0, "max": 5000000 },
    { "id": "time",  "sort": "asc",  "min": 1000 }
  ],
  "achievements": [
    { "id": "first_blood", "name": "First blood", "rule": { "stat": "kills", "gte": 1 } },
    { "id": "no_damage",   "name": "Untouchable", "rule": { "claim": true } }
  ]
}
```

**Stats (`agg`) — also the conflict rules:**

| agg | the game reports | merge on device and server |
|---|---|---|
| `sum` | a delta (e.g. kills this run) | added; one report capped by `maxDelta`; never decreases |
| `count` | usually `1` | same as sum |
| `max` / `min` | a value | the best one is kept; `max` caps it |
| `latest` | a value (number or string) | the newest by time wins |

Backfill (first connect, or switching the toggle off and on) sends **totals**: the server keeps the larger value for
sum/count, so nothing is counted twice. Achievements are a **union**: once unlocked, always unlocked (earliest date).

**Achievements:** prefer `{"stat": x, "gte": n}` — the **server** unlocks them from its own copy of your stats, so
a modified client can't just claim them. `{"claim": true}` is for moments stats can't express; the server accepts
claims with rate limits and marks them as claimed.

**Leaderboards:** `min`/`max` are hard bounds; scores outside are rejected. Choose them realistically.

The server validates against **its registered copy** of the manifest, not what the client sends.

## 3. Wire it in (three places)

```ts
import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { SClient, addConnectSetting } from "./s-sdk";
import manifest from "./obsigama-manifest.json";

export default class MyGame extends Plugin {
  s!: SClient;

  async onload() {
    // ...load your own data first...
    this.s = await SClient.create({ plugin: this, manifest });          // never throws
    this.s.importTotals({ stats: { kills: this.data.kills }, best: { score: this.data.best } }); // optional, idempotent
    this.s.on("badge", (b) => new Notice(`OBSIGAMA badge: ${b.name}`));        // optional toasts
    this.s.on("achievement", (a) => { /* a.source: "local" | "server" */ });
    this.addSettingTab(new MySettings(this));
  }

  // when a match/run ends:
  onRunEnd(r: { score: number; kills: number; ms: number; noDamage: boolean }) {
    void this.s.endRun({
      durationMs: r.ms,
      stats: { runs: 1, kills: r.kills },
      scores: { score: r.score },
      achievements: r.noDamage ? ["no_damage"] : [],
    });
  }
}

class MySettings extends PluginSettingTab {
  private dispose: (() => void) | null = null;
  constructor(private p: MyGame) { super(p.app, p); }
  display() {
    this.containerEl.empty();
    // ...your settings...
    this.dispose = addConnectSetting(this.containerEl, this.p.s, Setting, { lang: "en" }); // or "ru"
  }
  hide() { this.dispose?.(); }
}
```

`endRun()` updates local progress, evaluates local achievements, and if **Connect to OBSIGAMA** is on, sends this run in one
request right away. If OBSIGAMA is missing, switched offline, signed out, or the network fails, the run stays queued and
goes out with the next run or as soon as OBSIGAMA reports it is back (no polling). Failed requests also retry with backoff
(30 s → 30 min).

Other calls: `reportStat(id, value)`, `submitScore(lb, value)`, `unlockAchievement(id)` (go out with the next sync),
`syncNow()`, `getStatus()` / `on("status")` / `statusText(status, lang)`, `getStats()`, `getBest(lb)`,
`getAchievements()`, `getServerStats()` (account-wide values from the last sync), `openPlatform()`.

## 4. What the player sees

1. Plays offline as always. Nothing is sent.
2. Turns on **Connect to OBSIGAMA** in your settings. If OBSIGAMA isn't installed: the status line says so, progress stays local.
3. With OBSIGAMA installed and signed in, OBSIGAMA asks once: *"Connect My Game to OBSIGAMA?"* → **Allow**.
4. The SDK sends one snapshot with everything earned so far (backfill), then one request per finished run.
5. The game shows up in their OBSIGAMA library and public profile; OBSIGAMA badges may pop up as toasts.

Status values: `off`, `no-platform`, `platform-disabled` (OBSIGAMA switched offline), `not-configured`, `signed-out`,
`needs-link`, `link-denied`, `syncing`, `pending`, `synced`, `error`.

## 5. Register the game on OBSIGAMA

```bash
node scripts/manifest-to-sql.mjs path/to/obsigama-manifest.json --listed --repo https://github.com/you/my-game --description "Short pitch"
```
Run the output in the Supabase SQL editor. Re-run it whenever you bump `manifestVersion` (additive changes only;
removed stats/boards are marked retired, never deleted).

## How it works inside

- Discovery: `app.plugins.getPlugin("obsigama")?.api` (undocumented Obsidian API, guarded) plus the workspace
  events `obsigama:ready` / `obsigama:unload`, so load order doesn't matter.
- The SDK hands batches to OBSIGAMA (`api.submit`). OBSIGAMA checks its master switch, the session and the player's consent for
  this game, then calls the `ingest_batch` Postgres function with the player's JWT.
- `ingest_batch` (SECURITY DEFINER): dedups by `(user, idem)`, rate-limits (1,000 events / 10 min), clamps
  stats per the registered manifest, rejects out-of-bounds scores, records runs, unlocks stat-rule achievements,
  bumps counters, awards badges, writes activity, and returns per-event results + new unlocks + new badges + the
  account's stats for this game.
- Trust model: anything in a plugin can be read and modified, so the server never trusts the client for rules it
  can check itself. For single-player offline games this is plausibility checking, not real anti-cheat.

## The two existing games

- `examples/mini-old-games/` — [Mini Old Games](https://github.com/NOMBER/Mini-Old-Games) (plugin id `good-old-games`,
  12 games): manifest generated from the real game list and its 67 achievement ids, `importTotals` from its
  `stats.games`, `onSession` hook for `recordSession()`, settings toggle.
- `examples/hellvault/` — [HELLVAULT](https://github.com/NOMBER/HELLVAULT) (plugin id `vault-shards`, Doom-like shooter
  with story, linear path and endless arena): manifest from its real `progress.stats` counters and 21 achievements
  (all server-evaluated stat rules), per-run deltas, arena wave / arena kills / fastest story boards.
