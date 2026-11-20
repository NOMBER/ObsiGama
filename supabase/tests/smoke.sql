-- End-to-end checks of the schema, RLS and RPCs. Run on a scratch database (see scripts/test-sql.sh).
\set ON_ERROR_STOP on
\set QUIET on
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as
  $$ begin if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if; raise notice 'ok - %', msg; end $$;

-- sign-up creates profiles, Welcome badge and "joined" activity
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'a@x', '{"username": "Alice"}'),
  ('00000000-0000-0000-0000-00000000000b', 'b@x', '{"username": "alice"}'),  -- taken (case-insensitive): gets player_xxx
  ('00000000-0000-0000-0000-00000000000c', 'c@x', '{}');
select pg_temp.ok((select username from profiles where id = '00000000-0000-0000-0000-00000000000a') = 'Alice', 'username from sign-up metadata');
select pg_temp.ok((select username from profiles where id = '00000000-0000-0000-0000-00000000000b') like 'player\_%', 'duplicate nickname gets a generated one');
select pg_temp.ok((select count(*) from user_badges where badge_id = 'welcome') = 3, 'welcome badge on register');

-- act as Alice
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

-- clients cannot write progress tables or counters directly
do $$ begin
  begin insert into user_stats (user_id, game_id, stat_id, value) values (auth.uid(), 'hellvault', 'kills', 999);
        raise exception 'FAIL: direct stat insert allowed';
  exception when insufficient_privilege then raise notice 'ok - direct stat insert denied'; end;
  begin update profiles set runs_count = 999 where id = auth.uid();
        raise exception 'FAIL: counter update allowed';
  exception when insufficient_privilege then raise notice 'ok - counter update denied'; end;
  begin update profiles set bio = repeat('x', 301) where id = auth.uid();
        raise exception 'FAIL: long bio allowed';
  exception when check_violation then raise notice 'ok - bio max 300'; end;
  begin update profiles set avatar_url = 'https://evil.example/x.webp' where id = auth.uid();
        raise exception 'FAIL: foreign avatar url allowed';
  exception when check_violation then raise notice 'ok - avatar_url must point to own avatar folder'; end;
end $$;
update profiles set avatar_url = 'https://p.supabase.co/storage/v1/object/public/avatars/00000000-0000-0000-0000-00000000000a/avatar.webp?v=1' where id = auth.uid();
update profiles set bio = '<b>hi</b>', display_name = 'Al' where id = auth.uid();
-- other users' rows are not updatable
update profiles set bio = 'hacked' where id = '00000000-0000-0000-0000-00000000000c';
do $$ begin
  perform bio from profiles limit 1;
  raise exception 'FAIL: bio readable directly';
exception when insufficient_privilege then raise notice 'ok - private columns only via get_profile()'; end $$;
reset role;
select pg_temp.ok((select count(*) from profiles where bio = 'hacked') = 0, 'cannot edit other profiles');
set role authenticated;

-- backfill snapshot + a run
select ingest_batch('hellvault', 1, '[
  {"idem": "e1", "at": 1700000000000, "type": "snapshot", "payload": {
     "stats": {"kills": 60, "max_shards": 3, "lore_pages": 6, "nope": 1},
     "achievements": {"first_blood": 1700000000000, "pages6": 1700000000000},
     "best": {"arena_kills": 40}}},
  {"idem": "e2", "at": 1700000001000, "type": "session", "payload": {"durationMs": 600000}},
  {"idem": "e3", "at": 1700000001000, "type": "stat", "payload": {"id": "kills", "value": 5}},
  {"idem": "e4", "at": 1700000001000, "type": "score", "payload": {"lb": "arena_kills", "value": 99999}},
  {"idem": "e5", "at": 1700000001000, "type": "score", "payload": {"lb": "arena_kills", "value": 45}}
]'::jsonb) as r \gset
\echo :r
select pg_temp.ok((:'r'::jsonb -> 'stats' ->> 'kills')::numeric = 65, 'snapshot total + run delta = 65');
select pg_temp.ok(:'r'::jsonb -> 'unlocked' ? 'kills50', 'kills50 unlocked server-side from stats');
select pg_temp.ok(:'r'::jsonb -> 'unlocked' ? 'pages6', 'rule-based pages6 unlocked from lore_pages stat');
select pg_temp.ok((select count(*) from jsonb_array_elements(:'r'::jsonb -> 'results') x where x ->> 'status' = 'rejected') = 1, 'out-of-bounds score rejected');
select pg_temp.ok((select value from leaderboard_best where user_id = auth.uid() and lb_id = 'arena_kills') = 45, 'best score kept');
select pg_temp.ok(:'r'::jsonb -> 'badges' @> '[{"id": "first_game"}, {"id": "first_achievement"}]', 'badges returned in sync response');

-- replay is idempotent; snapshot again does not double count
select ingest_batch('hellvault', 1, '[{"idem": "e3", "at": 1700000001000, "type": "stat", "payload": {"id": "kills", "value": 5}},
  {"idem": "e6", "at": 1700000002000, "type": "snapshot", "payload": {"stats": {"kills": 65}, "achievements": {}, "best": {}}}]'::jsonb) as r2 \gset
select pg_temp.ok((:'r2'::jsonb -> 'results' -> 0 ->> 'status') = 'duplicate', 'duplicate idem detected');
select pg_temp.ok((:'r2'::jsonb -> 'stats' ->> 'kills')::numeric = 65, 'second snapshot does not double count');
select pg_temp.ok(jsonb_array_length(:'r2'::jsonb -> 'badges') = 0, 'badges are awarded once');

-- 9 more runs -> "10 runs" badge
select ingest_batch('mini-old-games', 1, (select jsonb_agg(jsonb_build_object('idem', 'm' || i, 'at', 1700000003000, 'type', 'session', 'payload', '{"durationMs": 1000}'::jsonb)) from generate_series(1, 9) i)) as r3 \gset
select pg_temp.ok(:'r3'::jsonb -> 'badges' @> '[{"id": "ten_runs"}]', 'ten_runs badge after 10 runs');
select pg_temp.ok((get_profile('alice') -> 'counts' ->> 'games')::int = 2, 'library counter');
-- per-run caps (maxDelta): separate delta events count separately, a merged one is clamped
-- (sdk-v0.1.1 never merges past maxDelta; sdk-v0.1.0 merged offline wins into one event and lost them)
select coalesce((select value from user_stats where user_id = auth.uid() and game_id = 'mini-old-games' and stat_id = 'wins'), 0) as w0 \gset
select ingest_batch('mini-old-games', 1, '[
  {"idem": "w1", "at": 1700000004000, "type": "session", "payload": {"durationMs": 1000}},
  {"idem": "w2", "at": 1700000004000, "type": "stat", "payload": {"id": "wins", "value": 1}},
  {"idem": "w3", "at": 1700000005000, "type": "session", "payload": {"durationMs": 1000}},
  {"idem": "w4", "at": 1700000005000, "type": "stat", "payload": {"id": "wins", "value": 1}},
  {"idem": "w5", "at": 1700000005000, "type": "stat", "payload": {"id": "pong.wins", "value": 1}},
  {"idem": "w6", "at": 1700000005000, "type": "stat", "payload": {"id": "pong.wins", "value": 1}}]'::jsonb) as rw \gset
select pg_temp.ok((:'rw'::jsonb -> 'stats' ->> 'wins')::numeric = :w0 + 2, 'two offline wins sent as two events count as 2');
select pg_temp.ok((:'rw'::jsonb -> 'stats' ->> 'pong.wins')::numeric = 2, 'per-game wins: two events count as 2');
select ingest_batch('mini-old-games', 1, '[{"idem": "w7", "at": 1700000006000, "type": "stat", "payload": {"id": "wins", "value": 2}}]'::jsonb) as rw2 \gset
select pg_temp.ok((:'rw2'::jsonb -> 'stats' ->> 'wins')::numeric = :w0 + 3, 'one merged event is still clamped to maxDelta');
select ingest_batch('mini-old-games', 1, '[{"idem": "pt1", "at": 1700000006000, "type": "stat", "payload": {"id": "playtime_ms", "value": 14400000}},
  {"idem": "pt2", "at": 1700000006000, "type": "stat", "payload": {"id": "playtime_ms", "value": 3600000}}]'::jsonb) as rw3 \gset
select pg_temp.ok((:'rw3'::jsonb -> 'stats' ->> 'playtime_ms')::numeric >= 18000000, 'playtime packed up to the cap is not lost');

-- manifest v2 score caps
select pg_temp.ok((select max(version) from game_manifests where game_id = 'mini-old-games') = 2, 'mini-old-games manifest v2 applied');
select ingest_batch('mini-old-games', 1, '[{"idem": "c1", "at": 1700000007000, "type": "score", "payload": {"lb": "pong", "value": 8}},
  {"idem": "c2", "at": 1700000007000, "type": "score", "payload": {"lb": "pong", "value": 7}},
  {"idem": "c3", "at": 1700000007000, "type": "stat", "payload": {"id": "pong.best", "value": 9}},
  {"idem": "c4", "at": 1700000007000, "type": "score", "payload": {"lb": "memory", "value": 281}},
  {"idem": "c5", "at": 1700000007000, "type": "score", "payload": {"lb": "snake", "value": 99999}}]'::jsonb) as rc \gset
select pg_temp.ok((select array_agg(x ->> 'status' order by x ->> 'idem') from jsonb_array_elements(:'rc'::jsonb -> 'results') x)
  = array['rejected', 'accepted', 'accepted', 'rejected', 'accepted'], 'pong 8 / memory 281 rejected, uncapped snake accepted');
select pg_temp.ok((:'rc'::jsonb -> 'stats' ->> 'pong.best')::numeric = 7, 'pong.best clamped to 7');
select ingest_batch('no-such-game', 1, '[]') as r4 \gset
select pg_temp.ok(:'r4'::jsonb ->> 'error' = 'unknown-game', 'unknown game rejected');

-- friends: search by prefix, request, accept
select pg_temp.ok((select count(*) from search_users('pla')) = 2, 'prefix search (case-insensitive)');
select pg_temp.ok((select count(*) from search_users('a%')) = 0, 'LIKE wildcards are escaped');
select username as cname from profiles where id = '00000000-0000-0000-0000-00000000000c' \gset
select pg_temp.ok(send_friend_request(:'cname') = 'sent', 'friend request sent');
select pg_temp.ok(send_friend_request(:'cname') = 'already_sent', 'no duplicate request');
update profiles set privacy = 'friends' where id = auth.uid();

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select pg_temp.ok((get_profile('alice') ->> 'restricted')::boolean, 'friends-only profile hidden from non-friends');
select pg_temp.ok((select count(*) from user_stats where user_id = '00000000-0000-0000-0000-00000000000a') = 0, 'RLS hides friends-only stats');
select pg_temp.ok((select direction from my_friends()) = 'incoming', 'incoming request listed');
select pg_temp.ok(respond_friend_request('00000000-0000-0000-0000-00000000000a', true) = 'ok', 'request accepted');
select get_profile('alice') as p \gset
select pg_temp.ok(not (:'p'::jsonb ->> 'restricted')::boolean and :'p'::jsonb ->> 'relation' = 'friend', 'friend sees full profile');
select pg_temp.ok(:'p'::jsonb ->> 'bio' = '<b>hi</b>', 'bio stored as plain text');
select pg_temp.ok((:'p'::jsonb -> 'counts' ->> 'friends')::int = 1, 'friend counter');
select pg_temp.ok(:'p'::jsonb -> 'badges' @> '[{"id": "first_friend"}]', 'first_friend badge on accept');
select pg_temp.ok(jsonb_array_length(:'p'::jsonb -> 'games') = 2 and jsonb_array_length(:'p'::jsonb -> 'activity') > 3, 'games and activity in profile');
select pg_temp.ok((select count(*) from get_leaderboard('hellvault', 'arena_kills')) = 1, 'leaderboard visible to friend');
select pg_temp.ok(remove_friend('00000000-0000-0000-0000-00000000000a') = 'ok', 'friend removed');

-- anon
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.ok((select count(*) from games) = 2, 'catalog is public');
select pg_temp.ok((select string_agg(plugin_id, ',' order by plugin_id) from games) = 'good-old-games,vault-shards', 'real plugin ids');
select pg_temp.ok((select count(*) from games where repo_url like 'https://github.com/NOMBER/%') = 2, 'repo urls set');
select pg_temp.ok((select count(*) from achievements where game_id = 'mini-old-games') = 67 and (select count(*) from achievements where game_id = 'hellvault') = 21, 'real achievement lists');
select pg_temp.ok((select count(*) from leaderboards where game_id = 'hellvault' and not retired) = 3, 'hellvault boards incl. arena_wave');
select pg_temp.ok((get_profile('alice') ->> 'restricted')::boolean, 'anon sees restricted card');
do $$ begin
  perform ingest_batch('hellvault', 1, '[]');
  raise exception 'FAIL: anon can call ingest_batch';
exception when insufficient_privilege then raise notice 'ok - anon cannot sync'; end $$;
do $$ begin
  perform award_badges('00000000-0000-0000-0000-00000000000a', 'on_register');
  raise exception 'FAIL: award_badges callable';
exception when insufficient_privilege then raise notice 'ok - award_badges is internal'; end $$;
reset role;

-- storage policies: own folder only
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into storage.objects (bucket_id, name) values ('avatars', '00000000-0000-0000-0000-00000000000a/avatar.webp');
do $$ begin
  insert into storage.objects (bucket_id, name) values ('avatars', '00000000-0000-0000-0000-00000000000c/avatar.webp');
  raise exception 'FAIL: wrote into another user''s avatar folder';
exception when insufficient_privilege then raise notice 'ok - avatar folder is per user'; end $$;
reset role;
select pg_temp.ok((select allowed_mime_types = array['image/webp'] from storage.buckets where id = 'avatars'), 'avatars bucket is webp-only');
\echo ALL SMOKE TESTS PASSED
