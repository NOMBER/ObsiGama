# Connecting a game plugin to S

Your game stays a normal, fully offline Obsidian plugin. The SDK adds:

- **local progress** kept by the SDK itself (stats, best scores, achievements) in `s-sync.json` next to your
  `data.json`; works with or without S installed, never throws;
- an opt-in **"Connect to S"** toggle for your settings tab (off by default) with a live sync status line;
- after **every finished run**, one small request with that run's results (only when connected);
- an offline **queue** with idempotency keys, backfill of everything earned before connecting, and retries.

Accounts exist only in S. Your game never sees a password, token or Supabase key.

## 1. Add the SDK

The SDK is plain TypeScript with zero dependencies (`packages/sdk/src`, about 22 KB minified). Either copy that folder
into your plugin (e.g. `src/s-sdk/`) or add the package from git, and let esbuild bundle it.

## 2. Describe your game: `s-manifest.json`

```json
{
  "gameId": "my-game",            // [a-z0-9-]{3,40}, unique on S, never change it
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
import manifest from "./s-manifest.json";

export default class MyGame extends Plugin {
  s!: SClient;

  async onload() {
    // ...load your own data first...
    this.s = await SClient.create({ plugin: this, manifest });          // never throws
    this.s.importTotals({ stats: { kills: this.data.kills }, best: { score: this.data.best } }); // optional, idempotent
    this.s.on("badge", (b) => new Notice(`S badge: ${b.name}`));        // optional toasts
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

`endRun()` updates local progress, evaluates local achievements, and if **Connect to S** is on, sends this run in one
request right away. If S is missing, switched offline, signed out, or the network fails, the run stays queued and
goes out with the next run or as soon as S reports it is back (no polling). Failed requests also retry with backoff
(30 s → 30 min).

Other calls: `reportStat(id, value)`, `submitScore(lb, value)`, `unlockAchievement(id)` (go out with the next sync),
`syncNow()`, `getStatus()` / `on("status")` / `statusText(status, lang)`, `getStats()`, `getBest(lb)`,
`getAchievements()`, `getServerStats()` (account-wide values from the last sync), `openPlatform()`.

## 4. What the player sees

1. Plays offline as always. Nothing is sent.
2. Turns on **Connect to S** in your settings. If S isn't installed: the status line says so, progress stays local.
3. With S installed and signed in, S asks once: *"Connect My Game to S?"* → **Allow**.
4. The SDK sends one snapshot with everything earned so far (backfill), then one request per finished run.
5. The game shows up in their S library and public profile; S badges may pop up as toasts.

Status values: `off`, `no-platform`, `platform-disabled` (S switched offline), `not-configured`, `signed-out`,
`needs-link`, `link-denied`, `syncing`, `pending`, `synced`, `error`.

## 5. Register the game on S

```bash
node scripts/manifest-to-sql.mjs path/to/s-manifest.json --listed --repo https://github.com/you/my-game --description "Short pitch"
```
Run the output in the Supabase SQL editor. Re-run it whenever you bump `manifestVersion` (additive changes only;
removed stats/boards are marked retired, never deleted).

## How it works inside

- Discovery: `app.plugins.getPlugin("game-platform")?.api` (undocumented Obsidian API, guarded) plus the workspace
  events `game-platform:ready` / `game-platform:unload`, so load order doesn't matter.
- The SDK hands batches to S (`api.submit`). S checks its master switch, the session and the player's consent for
  this game, then calls the `ingest_batch` Postgres function with the player's JWT.
- `ingest_batch` (SECURITY DEFINER): dedups by `(user, idem)`, rate-limits (1,000 events / 10 min), clamps
  stats per the registered manifest, rejects out-of-bounds scores, records runs, unlocks stat-rule achievements,
  bumps counters, awards badges, writes activity, and returns per-event results + new unlocks + new badges + the
  account's stats for this game.
- Trust model: anything in a plugin can be read and modified, so the server never trusts the client for rules it
  can check itself. For single-player offline games this is plausibility checking, not real anti-cheat.

## The two existing games

- `examples/minigames/` — Mini Games (12 games): manifest generated from the real game list and its 67 achievement
  ids, `importTotals` from its `stats.games`, `onSession` hook for `recordSession()`, settings toggle.
- `examples/shooter/` — Vault Shards (Doom-style shooter): manifest from its real counters and 21 achievements
  (all server-evaluated stat rules), per-session deltas, fastest-win and kills-per-run boards.
