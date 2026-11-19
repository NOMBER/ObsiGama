# OBSIGAMA — a game hub for Obsidian

> The display name lives in one constant (`PLATFORM_NAME` in `src/brand.ts`) plus `manifest.json` → `name`.
> The plugin id is `obsigama`: game plugins find OBSIGAMA by that id, so it should not change after the first release.

OBSIGAMA is "Steam inside Obsidian": an online hub with your account, profile, game catalog, library, friends,
achievements, badges and leaderboards. Games are **separate Obsidian plugins** (on GitHub) that stay fully
playable offline. A game that opts in (its own **Connect to OBSIGAMA** toggle, off by default) uses the small
[`@obsigama/sdk`](packages/sdk) to send each finished run to your OBSIGAMA account.

```
 game plugin (offline)        OBSIGAMA plugin (online hub)     Supabase (free tier)
 ┌──────────────────────┐ SDK  ┌──────────────────────────┐ HTTPS ┌──────────────────────────┐
 │ local stats / bests / │────▶│ account + session         │──────▶│ Auth, Postgres + RLS,     │
 │ achievements, queue   │ in- │ consent per game          │  RPC  │ ingest_batch() validation │
 │ "Connect to OBSIGAMA" │◀────│ catalog/library/friends   │◀──────│ badges, activity, Storage │
 └──────────────────────┘proc └──────────────────────────┘       └──────────────────────────┘
```

## What's in this repo

| Path | What |
|---|---|
| `src/` | The OBSIGAMA Obsidian plugin (TypeScript, esbuild, plain DOM UI) |
| `src/views/hub-view.ts` | Hub: Catalog, Library, Friends, Profile (public profiles, edit, avatar upload) |
| `src/backend.ts` | Supabase client, auth, reads/writes, avatar upload |
| `src/platform-api.ts` | In-process API that game plugins call through the SDK, consent dialog |
| `src/image/` | Any image → small WebP (resize, center-crop, quality search) |
| `packages/sdk/` | Dependency-free SDK for game plugins (offline-first state, queue, sync, settings toggle) |
| `examples/mini-old-games`, `examples/hellvault` | Ready integration code + manifests for the two existing games ([Mini Old Games](https://github.com/NOMBER/Mini-Old-Games), [HELLVAULT](https://github.com/NOMBER/HELLVAULT)) |
| `supabase/migrations/` | Database schema, RLS, RPCs, triggers, storage buckets, seed (badges + 2 games) |
| `supabase/tests/` | SQL smoke tests (run on plain Postgres with a Supabase stub) |
| `scripts/manifest-to-sql.mjs` | Registers a game: manifest JSON → SQL |
| [`INTEGRATION.md`](INTEGRATION.md) | How to connect any game plugin |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Design notes and decisions |

## Network use (disclosure)

As required by Obsidian's developer policies:

- **OBSIGAMA connects to the internet.** It talks only to the Supabase project whose URL you enter in its settings
  (your own project; nothing is preconfigured). It is used for: your account (sign-up/sign-in), profile and
  avatar, the game catalog, your library, friends, achievements, badges, leaderboards, and the results that
  connected games send.
- **An account is required** for everything except browsing the catalog.
- **What is sent:** email and password (to Supabase Auth), your nickname, display name, bio, avatar image (as WebP),
  privacy setting, friend requests, and for each game you explicitly connect: stats, best scores, achievements
  and run durations. Nothing is read from your notes. No telemetry, no ads, no analytics.
- **Online / sync switch:** in OBSIGAMA settings. When **off**, OBSIGAMA makes **no network requests at all**, accepts
  nothing from games, and games keep their results in a local queue until you switch it back on. It is on by default.
- Your login session is stored in Obsidian's per-vault local storage (not in `data.json`, so it does not end up in
  vault sync or git). Game plugins never see it.
- Images you upload are public (anyone with the link can see your avatar).

## Set up your free Supabase project (once, ~10 minutes)

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
   - For **email codes** (the "Email code" tab in OBSIGAMA), edit the *Magic Link* email template so it contains `{{ .Token }}`
     (the 6-digit code) instead of / in addition to the link.
4. **Copy the keys:** *Project Settings* → *API*: **Project URL** and the **anon / publishable** key.
   Never use the `service_role` / secret key in the plugin.
5. **In Obsidian:** Settings → OBSIGAMA → paste the URL and anon key → **Apply**. Open OBSIGAMA from the ribbon (gamepad icon)
   and create your account.

Free tier fit: fewer than 1,000 players use a tiny share of the free limits (50k monthly users, 500 MB database,
1 GB storage, 5 GB egress). Avatars are ~10–50 KB WebP files. A free project pauses after 7 days without any
requests; open the dashboard to resume it.

## Images: always WebP, as light as possible

- Every image uploaded through OBSIGAMA is converted **on the device** before upload: decoded, resized (avatars: center-crop
  to 256×256; icons: fit in 256×256; badges: 128×128), then encoded to WebP with a quality search that keeps the
  highest quality under the size budget (avatars < 50 KB, icons < 40 KB, badges < 16 KB) and shrinks the image if
  needed. See `src/image/`.
- The server enforces it: the `avatars` and `game-icons` buckets accept **only `image/webp`**, with hard size limits
  (512 KB / 256 KB). Users can only write `avatars/<their user id>/…`.
- Known gap: Safari/iOS cannot encode WebP from a canvas; OBSIGAMA shows "This device cannot encode WebP images yet" there.
  Later options: a small WASM encoder, or server-side re-encoding in a Supabase Edge Function.

## Badges

Badges are rows in `public.badges`; the server awards them, never the client:

- `rule_type` = which per-user counter it watches: `on_register`, `count_runs`, `count_games`,
  `count_achievements`, `count_friends`; `threshold` = `{"gte": N}`.
- Counters on `profiles` are updated incrementally by triggers (new run, game added to library, achievement unlocked,
  friendship accepted). After a counter changes, only **active badges of that rule type that the user does not own
  yet** are checked (`award_badges()`); owned badges are never re-checked. Each award is unique per user
  (`ON CONFLICT DO NOTHING`) and writes an activity entry. Newly awarded badges come back in the sync response so the
  game or OBSIGAMA can show a toast; profiles read badges in the same `get_profile()` call.
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
npm test             # unit tests (SDK state/queue/client, image math)
./scripts/test-sql.sh   # SQL smoke tests; needs a local Postgres 15+ (PGHOST/PGPORT/PGUSER)
```

To try it, copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/obsigama/` and enable it.

## Register a game

```bash
node scripts/manifest-to-sql.mjs path/to/obsigama-manifest.json --listed --repo https://github.com/owner/repo --description "..."
```
Run the printed SQL in the SQL editor (or save it as a new migration). See [INTEGRATION.md](INTEGRATION.md).

## Roadmap

- **Now (this version):** account, profile (avatar, bio, privacy, join date), catalog, library, friends + nickname
  search, public profiles with games/stats/achievements/badges/activity, SDK + server-validated sync, WebP images.
- **Next:** leaderboard view in the hub; reviews UI (table and RLS are ready); developer self-registration of games
  (signed manifests with `game_keys`); game icons upload tool; pruning old `scores`/`ingest_log` with `pg_cron`.
- **Later:** messaging (only if it stays cheap: polling first, Realtime only in an open chat); community hub
  (postponed); OAuth (GitHub/Discord) sign-in; WebP encoding on iOS; server-side re-encoding Edge Function.

## License

- **Launcher (the OBSIGAMA plugin, `src/`, `supabase/`)**: [GNU AGPL-3.0](LICENSE).
- **SDK (`packages/sdk/`) and integration examples (`examples/`)**: [MIT](packages/sdk/LICENSE), so any game plugin can bundle them freely.

---

<p align="center">
  Made by <a href="https://nomberobsidian.github.io">NOMBER</a> ·
  <a href="https://donatre.github.io">Support the project</a> 💜
</p>
