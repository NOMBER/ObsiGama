# ObsiGama — a game hub for Obsidian

> The display name lives in one constant (`PLATFORM_NAME` in `src/brand.ts`) plus `manifest.json` → `name`.
> The plugin id is `obsigama`: game plugins find ObsiGama by that id, so it should not change after the first release.

ObsiGama is "Steam inside Obsidian": an online hub with your account, profile, game catalog, library, friends,
achievements, badges and leaderboards. Games are **separate Obsidian plugins** (on GitHub) that stay fully
playable offline. A game that opts in (its own **Connect to ObsiGama** toggle, off by default) uses the small
[`@obsigama/sdk`](packages/sdk) to send each finished run to your ObsiGama account.

```
 game plugin (offline)        ObsiGama plugin (online hub)     Supabase (free tier)
 ┌──────────────────────┐ SDK  ┌──────────────────────────┐ HTTPS ┌──────────────────────────┐
 │ local stats / bests / │────▶│ account + session         │──────▶│ Auth, Postgres + RLS,     │
 │ achievements, queue   │ in- │ consent per game          │  RPC  │ ingest_batch() validation │
 │ "Connect to ObsiGama" │◀────│ catalog/library/friends   │◀──────│ badges, activity, Storage │
 └──────────────────────┘proc └──────────────────────────┘       └──────────────────────────┘
```

## Getting started

1. Install **ObsiGama** from *Settings → Community plugins* and enable it.
2. Click the gamepad icon in the ribbon (or run the command *Open ObsiGama*), create an account with your email and
   confirm it from the email you receive.
3. Pick a nickname, browse the **Catalog**, install a game plugin, and turn on **Connect to ObsiGama** in that
   game's settings. Every finished run then shows up in your profile, achievements and leaderboards.
4. Find friends by nickname on the **Friends** tab.

No server setup is needed: the plugin uses the official ObsiGama server.

## What's in this repo

| Path | What |
|---|---|
| `src/` | The ObsiGama Obsidian plugin (TypeScript, esbuild, plain DOM UI) |
| `src/views/hub-view.ts` | Hub: Catalog, Library, Friends, Profile (public profiles, edit, avatar upload) |
| `src/backend.ts` | Supabase client, auth, reads/writes, avatar upload |
| `src/platform-api.ts` | In-process API that game plugins call through the SDK, consent dialog |
| `src/image/` | Any image → small WebP (resize, center-crop, quality search) |
| `packages/sdk/` | Dependency-free SDK for game plugins (offline-first state, queue, sync, settings toggle) |
| `examples/mini-old-games`, `examples/hellvault` | Ready integration code + manifests for the two existing games ([Mini Old Games](https://github.com/NOMBER/Mini-Old-Games), [HELLVAULT](https://github.com/NOMBER/HELLVAULT)) |
| `supabase/migrations/` | Database schema, RLS, RPCs, triggers, storage buckets, seed (badges + 2 games) |
| `supabase/tests/` | SQL smoke tests (run on plain Postgres with a Supabase stub) |
| `scripts/approve-game.mjs` | Maintainer: validates a game submission issue → icon WebP + SQL (never runs SQL) |
| `scripts/manifest-to-sql.mjs` | Registers a game: manifest JSON → SQL |
| `.github/ISSUE_TEMPLATE/add-game.yml` | "Add a game" submission form |
| [`INTEGRATION.md`](INTEGRATION.md) | How to connect any game plugin |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Design notes and decisions |

## Privacy and network use (disclosure)

As required by Obsidian's developer policies:

- **An account is required.** ObsiGama is an online service: sign-up/sign-in with email, then profile, library,
  friends, achievements, badges and leaderboards live on the server. Browsing the catalog works signed out.
- **Where data goes:** only to the official ObsiGama server, a [Supabase](https://supabase.com) project
  (`https://eravzmmusvdtsqsxplij.supabase.co`), over HTTPS. The plugin ships its
  public *publishable* key; access is limited by Row Level Security. No other servers are contacted.
- **What is sent:** your email and password (to Supabase Auth), nickname, display name, bio, avatar (as WebP),
  privacy setting, friend requests, and, only for games you explicitly connect, their stats, best scores,
  achievements and run durations. **Nothing is read from your notes or vault files.** No telemetry, no ads, no analytics.
- **Who sees it:** your profile, games and achievements are public or friends-only (your privacy setting);
  your email is never shown to other players. Uploaded avatars are public images.
- **Off switch:** Settings → ObsiGama → **Online / sync**. When off, ObsiGama makes **no network requests at all**,
  accepts nothing from games, and games keep their results in a local queue until you switch it back on.
- Your login session is stored in Obsidian's per-vault local storage (not in `data.json`, so it does not end up in
  vault sync or git). Game plugins never see it or any key.
- To delete your account and data, open an issue in this repository or contact the author.

## Run your own server (optional)

ObsiGama works out of the box with the official server. To run a private copy of the backend instead:

1. **Create the project.** Go to <https://supabase.com>, sign in, **New project**, pick the Free plan, any name
   (e.g. `s-hub`), a strong database password, and a region close to your players.
2. **Apply the database schema.** Either:
   - **SQL editor (no tools needed):** open *SQL Editor* → *New query*, paste the contents of
     `supabase/migrations/20261111100000_init_schema.sql`, **Run**. Then do the same with
     `supabase/migrations/20261111100100_seed_badges_and_games.sql`.
   - **Supabase CLI:**
     ```bash
     npm i -g supabase            # or: brew install supabase/tap/supabase
     supabase login
     supabase link --project-ref <your-project-ref>   # the ref is in the project URL
     supabase db push             # applies everything in supabase/migrations/
     ```
3. **Auth settings** (*Authentication* → *Sign In / Providers* → *Email*):
   - Keep **Email** enabled. For a small private group you can turn **Confirm email** off so sign-up works instantly.
   - Supabase's built-in email sender is only for testing (a few emails per hour, and only to your project's team
     members). For real users set up custom SMTP (*Authentication* → *Emails* → *SMTP settings*), e.g. a free
     Resend or Brevo account.
   - For **email codes** (the "Email code" tab in ObsiGama), edit the *Magic Link* email template so it contains `{{ .Token }}`
     (the 6-digit code) instead of / in addition to the link.
4. **Copy the keys:** *Project Settings* → *API keys*: **Project URL** and the **publishable** (`sb_publishable_…`)
   or legacy `anon` key. Never use a secret / `service_role` key in the plugin.
5. **In Obsidian:** Settings → ObsiGama → *Advanced: custom server* → paste the URL and key → **Apply**
   (clear both fields to go back to the official server). Open ObsiGama from the ribbon (gamepad icon)
   and create your account.

Free tier fit: fewer than 1,000 players use a tiny share of the free limits (50k monthly users, 500 MB database,
1 GB storage, 5 GB egress). Avatars are ~10–50 KB WebP files. A free project pauses after 7 days without any
requests; open the dashboard to resume it.

## Images: always WebP, as light as possible

- Every image uploaded through ObsiGama is converted **on the device** before upload: decoded, resized (avatars: center-crop
  to 256×256; icons: fit in 256×256; badges: 128×128), then encoded to WebP with a quality search that keeps the
  highest quality under the size budget (avatars < 50 KB, icons < 40 KB, badges < 16 KB) and shrinks the image if
  needed. See `src/image/`.
- The server enforces it: the `avatars` and `game-icons` buckets accept **only `image/webp`**, with hard size limits
  (512 KB / 256 KB). Users can only write `avatars/<their user id>/…`.
- Known gap: Safari/iOS cannot encode WebP from a canvas; ObsiGama shows "This device cannot encode WebP images yet" there.
  Later options: a small WASM encoder, or server-side re-encoding in a Supabase Edge Function.

## Badges

Badges are rows in `public.badges`; the server awards them, never the client:

- `rule_type` = which per-user counter it watches: `on_register`, `count_runs`, `count_games`,
  `count_achievements`, `count_friends`; `threshold` = `{"gte": N}`.
- Counters on `profiles` are updated incrementally by triggers (new run, game added to library, achievement unlocked,
  friendship accepted). After a counter changes, only **active badges of that rule type that the user does not own
  yet** are checked (`award_badges()`); owned badges are never re-checked. Each award is unique per user
  (`ON CONFLICT DO NOTHING`) and writes an activity entry. Newly awarded badges come back in the sync response so the
  game or ObsiGama can show a toast; profiles read badges in the same `get_profile()` call.
- **Add a badge:** insert a row, e.g.
  ```sql
  insert into public.badges (id, name, description, sort_order, rule_type, threshold)
  values ('hundred_runs', '100 runs', 'Finished 100 runs', 35, 'count_runs', '{"gte": 100}');
  ```
  Upload its icon as WebP to `game-icons/badges/hundred_runs.webp` and set `icon_url`. A new *kind* of rule needs one
  counter + one `when` branch in `award_badges()`.

## Develop

```bash
npm install
npm run build        # typecheck (plugin, SDK, examples) + esbuild -> main.js
npm run lint         # eslint with Obsidian's official rules (eslint-plugin-obsidianmd)
npm test             # unit tests (SDK state/queue/client, image math, game submissions)
./scripts/test-sql.sh   # SQL smoke tests; needs a local Postgres 15+ (PGHOST/PGPORT/PGUSER)
```

To try it, copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/obsigama/` and enable it.

Releases: bump `version` in `manifest.json`, `package.json` and `versions.json`, commit, then push a tag that equals the
version exactly (no `v`): `git tag 1.0.1 && git push origin 1.0.1`. The `Release` workflow builds, lints, tests and
attaches `main.js`, `manifest.json` and `styles.css` to the GitHub release.

## Roadmap

- **Now (this version):** account, profile (avatar, bio, privacy, join date), catalog, library, friends + nickname
  search, public profiles with games/stats/achievements/badges/activity, SDK + server-validated sync, WebP images.
- **Next:** leaderboard view in the hub; reviews UI (table and RLS are ready); developer self-service publishing
  (signed manifests with `game_keys`; for now games are submitted by issue and approved by hand); game icons upload tool; pruning old `scores`/`ingest_log` with `pg_cron`.
- **Later:** messaging (only if it stays cheap: polling first, Realtime only in an open chat); community hub
  (postponed); OAuth (GitHub/Discord) sign-in; WebP encoding on iOS; server-side re-encoding Edge Function.

## Add your game / Как добавить свою игру в ObsiGama

Any Obsidian game plugin can join the catalog. **Every game is reviewed by hand by the maintainer** (code read-through
and a play test in a clean vault) before it is listed, and a game can be rejected or delisted later.

1. **Integrate the SDK** as described in [INTEGRATION.md](INTEGRATION.md): an `obsigama-manifest.json`, the
   "Connect to ObsiGama" toggle in your settings, one `endRun` per finished run.
2. **Open a submission issue** with the template:
   [Add a game / Добавить игру](https://github.com/NOMBER/ObsiGama/issues/new?template=add-game.yml).
   It asks for the game name, plugin id, public GitHub repo, community store status, a short description (~200
   characters), the full `obsigama-manifest.json` and a square icon (PNG/JPG/WebP; converted to WebP 128×128).
3. **Review and manual QA**: the maintainer validates the manifest, reads the code, installs the plugin in a test
   vault, plays it offline, turns sync on, finishes a run and checks the profile. Questions go to the issue.
4. **Listed**: the maintainer registers the game on the server and closes the issue. To update the manifest later,
   bump `manifestVersion` and open a new issue (or comment on the old one).

**Acceptance rules** (all required):

- the game plays fully offline and without ObsiGama installed;
- the "Connect to ObsiGama" toggle is opt-in and **off by default**;
- no Supabase keys, tokens or other secrets in the plugin, and no own requests to ObsiGama's server;
- the official SDK is used unmodified (MIT);
- the README discloses network use, as required by
  [Obsidian's developer policies](https://docs.obsidian.md/Developer+policies);
- no telemetry and no ads;
- public source code on GitHub;
- the developer agrees that the maintainer may reject the game or remove it from the catalog.

### Maintainer: approving a game

`scripts/approve-game.mjs` never touches the database: it validates and prints SQL that you run yourself.

```bash
node scripts/approve-game.mjs 12 --check     # validate issue #12, check the repo is public, print the review checklist
node scripts/approve-game.mjs 12 --write     # after manual QA: icon -> supabase/approved/<game-id>.webp,
                                             # SQL -> supabase/approved/<game-id>.sql
node scripts/approve-game.mjs 12 --write --supabase-url https://<ref>.supabase.co   # also puts the icon URL into the SQL
node scripts/approve-game.mjs --manifest path/to/obsigama-manifest.json \
  --repo-url https://github.com/owner/repo --description "Short pitch" [--icon icon.png] [--check|--write]
```

Then: SQL Editor → run the SQL; Storage → `game-icons` → upload the WebP as `games/<game-id>.webp`; close the issue.
Use `--draft` to register a game without listing it. It needs `gh` (logged in) and `npm install` (for `sharp`).
`scripts/manifest-to-sql.mjs` is the bare manifest → SQL tool (also validates) for your own games.

## License

- **Launcher (the ObsiGama plugin, `src/`, `supabase/`)**: [GNU AGPL-3.0](LICENSE).
- **SDK (`packages/sdk/`) and integration examples (`examples/`)**: [MIT](packages/sdk/LICENSE), so any game plugin can bundle them freely.

---

<p align="center">
  Made by <a href="https://nomberobsidian.github.io">NOMBER</a> ·
  <a href="https://donatre.github.io">Support the project</a> 💜
</p>
