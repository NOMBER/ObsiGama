# OBSIGAMA — architecture notes

OBSIGAMA was called "S" (placeholder) until 19 Nov 2026.

Source design: "Steam for Obsidian: backend architecture" (Grok Bot page). This file records what was built and what
changed since.

## What changed in the plan

| Before | Now |
|---|---|
| Platform plugin owns an offline queue for games | **Each game owns its local progress and queue** (SDK); works with no OBSIGAMA installed |
| Generic "platform" | **OBSIGAMA** = always-online hub (account, profile, catalog, library, friends, leaderboards on Supabase) |
| Games sync whenever the platform is present | **Opt-in per game:** "Connect to OBSIGAMA" toggle in the game, off by default, plus a consent dialog in OBSIGAMA |
| — | **OBSIGAMA master switch "Online / sync"**: off = zero network requests, games' results wait |
| Batches on focus / every 5 minutes | **One request per finished run** (`endRun`), retry on next run / when OBSIGAMA comes back; no polling |
| Server sessions + nonces | Deferred: offline single-player games get plausibility checks (bounds, clamps, rate limits, dedup) |
| Friends + messaging + presence in phase 2 | Friends and nickname search **now**; messaging and community hub **later** |
| — | **Badges**: data-driven rules, counters, server-awarded, returned in the sync response |
| — | **Public profiles**: join date, bio (≤ 300, plain text), privacy (public / friends), activity feed |
| — | **All images WebP**, encoded on the device, enforced by the buckets |

## Components

- **OBSIGAMA plugin** (`src/`): `Backend` (supabase-js, vault-scoped session storage, fetch guard), `SPlatformAPI`
  (in-process API for games, consent), `HubView` (Catalog, Library, Friends, Profile; plain DOM),
  settings (server, master switch, connected games).
- **SDK** (`packages/sdk/`): `SClient` (local state, queue, flush), pure `state.ts` (merge rules) and `queue.ts`
  (idempotency keys, compaction, snapshot, batching, backoff), `settings-ui.ts` (toggle + status).
- **Database** (`supabase/migrations/`): profiles, games, game_keys, game_manifests, stat_defs, leaderboards,
  achievements, user_library, reviews, user_stats, user_achievements, play_sessions, scores, leaderboard_best,
  ingest_log, friendships, badges, user_badges, activity. RLS on every table; progress tables are written only by
  SECURITY DEFINER functions; clients may update only their profile's editable columns, their library and reviews.

## Requests per screen (free-tier friendly)

| Screen | Requests |
|---|---|
| Catalog | 1 (`games`), +1 cached profile when signed in |
| Library / own profile / any profile | 1 (`get_profile` returns games, stats, achievements, badges, friends, activity) |
| Friends | 1 (`my_friends`) + debounced `search_users` |
| A finished run in a connected game | 1 (`ingest_batch`) |

Client cache: 60 s per screen. No websockets, no polling.

## Privacy

`profiles` exposes only id, username, display name, avatar, privacy and join date directly. Everything else (bio,
counters, last seen, games, stats, achievements, badges, friends, activity) is behind `can_view()`: self, public
profile, or accepted friend.

## Open items

- Obsidian `app.plugins` is undocumented; discovery is guarded and backed by workspace events.
- Safari/iOS can't encode WebP from canvas (WASM encoder or Edge Function re-encode later).
- `scores` and `ingest_log` grow by one row per run/event; add `pg_cron` pruning before it matters (not at < 1,000 users).
