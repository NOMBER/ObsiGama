-- S game hub: initial schema (Supabase / Postgres 15+)
-- Single-player offline games sync stats/scores/achievements through the S plugin.
-- All writes to game progress go through SECURITY DEFINER RPCs; clients never write those tables.
-- Messaging and the community hub are intentionally NOT here (later migrations).

-- =====================================================================
-- Profiles
-- =====================================================================
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  username           text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  display_name       text check (char_length(display_name) <= 40),
  bio                text check (char_length(bio) <= 300),
  avatar_url         text check (char_length(avatar_url) <= 500
                             -- only your own file in the avatars bucket
                             and position('/storage/v1/object/public/avatars/' || id::text || '/' in avatar_url) > 0),
  privacy            text not null default 'public' check (privacy in ('public', 'friends')),
  -- counters maintained by triggers / RPCs (clients cannot update them, see grants below)
  runs_count         integer not null default 0,
  games_count        integer not null default 0,
  achievements_count integer not null default 0,
  friends_count      integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_seen_at       timestamptz
);
-- unique, case-insensitive nickname + fast prefix search (lower(username) LIKE 'abc%')
create unique index profiles_username_lower_key on public.profiles (lower(username));
create index profiles_username_prefix_idx on public.profiles (lower(username) text_pattern_ops);

-- =====================================================================
-- Catalog: games and their manifests ("connect any game plugin")
-- =====================================================================
create table public.games (
  id                       text primary key check (id ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  plugin_id                text not null unique,
  name                     text not null check (char_length(name) between 1 and 80),
  description              text check (char_length(description) <= 1000),
  repo_url                 text check (repo_url is null or repo_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'),
  icon_url                 text,
  developer_id             uuid references public.profiles (id) on delete set null,
  status                   text not null default 'draft' check (status in ('draft', 'listed', 'delisted')),
  current_manifest_version integer,
  sort_order               integer not null default 100,
  created_at               timestamptz not null default now()
);

-- publish keys for future signed manifest publishing from a dev CLI (public halves only)
create table public.game_keys (
  key_id     text primary key,
  game_id    text not null references public.games (id) on delete cascade,
  public_key text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index game_keys_game_idx on public.game_keys (game_id);

create table public.game_manifests (
  game_id      text not null references public.games (id) on delete cascade,
  version      integer not null check (version >= 1),
  manifest     jsonb not null,
  signature    text,
  published_at timestamptz not null default now(),
  primary key (game_id, version)
);

create table public.stat_defs (
  game_id    text not null references public.games (id) on delete cascade,
  stat_id    text not null,
  agg        text not null check (agg in ('sum', 'count', 'max', 'min', 'latest')),
  value_type text not null default 'number' check (value_type in ('number', 'string')),
  max_value  numeric,
  max_delta  numeric,
  name       text,
  retired    boolean not null default false,
  primary key (game_id, stat_id)
);

create table public.leaderboards (
  game_id   text not null references public.games (id) on delete cascade,
  lb_id     text not null,
  name      text,
  sort      text not null check (sort in ('asc', 'desc')),
  min_value numeric,
  max_value numeric,
  retired   boolean not null default false,
  primary key (game_id, lb_id)
);

create table public.achievements (
  game_id     text not null references public.games (id) on delete cascade,
  ach_id      text not null,
  name        text not null,
  description text,
  icon        text,          -- emoji or a WebP URL in the game-icons bucket
  hidden      boolean not null default false,
  rule        jsonb not null, -- {"stat": "...", "gte": n} (server-evaluated) or {"claim": true}
  sort_order  integer not null default 0,
  primary key (game_id, ach_id)
);

-- =====================================================================
-- Per-user game data
-- =====================================================================
create table public.user_library (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  game_id         text not null references public.games (id) on delete cascade,
  added_at        timestamptz not null default now(),
  first_played_at timestamptz,
  last_played_at  timestamptz,
  runs            integer not null default 0,
  playtime_ms     bigint not null default 0,
  primary key (user_id, game_id)
);
create index user_library_game_idx on public.user_library (game_id);

create table public.reviews (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  game_id    text not null references public.games (id) on delete cascade,
  rating     smallint not null check (rating between 1 and 5),
  body       text check (char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index reviews_game_idx on public.reviews (game_id, updated_at desc);

create table public.user_stats (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  game_id    text not null,
  stat_id    text not null,
  value      numeric,
  value_text text check (char_length(value_text) <= 200),
  client_at  timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id, stat_id),
  foreign key (game_id, stat_id) references public.stat_defs (game_id, stat_id) on delete cascade
);

create table public.user_achievements (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  game_id     text not null,
  ach_id      text not null,
  unlocked_at timestamptz not null,
  source      text not null check (source in ('rule', 'claim')),
  created_at  timestamptz not null default now(), -- server time; "unlocked by this batch" = created_at = now()
  primary key (user_id, game_id, ach_id),
  foreign key (game_id, ach_id) references public.achievements (game_id, ach_id) on delete cascade
);
create index user_achievements_ach_idx on public.user_achievements (game_id, ach_id); -- "% of players"

create table public.play_sessions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  game_id     text not null references public.games (id) on delete cascade,
  duration_ms integer not null default 0,
  client_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index play_sessions_user_idx on public.play_sessions (user_id, created_at desc);

create table public.scores (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  game_id      text not null,
  lb_id        text not null,
  value        numeric not null,
  trust        text not null default 'offline' check (trust in ('verified', 'offline', 'flagged')),
  client_at    timestamptz,
  submitted_at timestamptz not null default now(),
  foreign key (game_id, lb_id) references public.leaderboards (game_id, lb_id) on delete cascade
);
create index scores_user_idx on public.scores (user_id, game_id, lb_id, submitted_at desc);

create table public.leaderboard_best (
  game_id     text not null,
  lb_id       text not null,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  value       numeric not null,
  trust       text not null default 'offline',
  achieved_at timestamptz not null,
  primary key (game_id, lb_id, user_id),
  foreign key (game_id, lb_id) references public.leaderboards (game_id, lb_id) on delete cascade
);
create index leaderboard_best_rank_idx on public.leaderboard_best (game_id, lb_id, value);

-- idempotency keys of synced events (+ rate limiting). Safe to prune after 30 days.
create table public.ingest_log (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  idem        text not null,
  game_id     text not null,
  status      text,
  received_at timestamptz not null default now(),
  primary key (user_id, idem)
);
create index ingest_log_recent_idx on public.ingest_log (user_id, received_at desc);

-- =====================================================================
-- Social: friends, badges, activity
-- =====================================================================
create table public.friendships (
  user_a       uuid not null references public.profiles (id) on delete cascade,
  user_b       uuid not null references public.profiles (id) on delete cascade,
  status       text not null check (status in ('pending', 'accepted')),
  requested_by uuid not null,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  primary key (user_a, user_b),
  check (user_a < user_b),
  check (requested_by in (user_a, user_b))
);
create index friendships_b_idx on public.friendships (user_b);

-- Platform badges. Adding a badge = inserting a row. A new rule_type needs one branch in award_badges().
create table public.badges (
  id          text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  name        text not null,
  description text,
  icon_url    text, -- WebP in the game-icons bucket, e.g. .../game-icons/badges/welcome.webp
  sort_order  integer not null default 0,
  active      boolean not null default true,
  rule_type   text not null check (rule_type in ('on_register', 'count_runs', 'count_games', 'count_achievements', 'count_friends')),
  threshold   jsonb not null default '{"gte": 1}',
  created_at  timestamptz not null default now()
);
create index badges_rule_idx on public.badges (rule_type) where active;

create table public.user_badges (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  badge_id   text not null references public.badges (id) on delete cascade,
  awarded_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

create table public.activity (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('joined', 'first_play', 'achievement', 'badge', 'new_best', 'friend')),
  game_id    text,
  ref        text,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index activity_user_idx on public.activity (user_id, id desc);

-- =====================================================================
-- Helpers
-- =====================================================================

-- Can the current user see this user's profile details? (public, self, or accepted friend)
create or replace function public.can_view(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_user = auth.uid(), false)
      or exists (select 1 from public.profiles p where p.id = p_user and p.privacy = 'public')
      or exists (select 1 from public.friendships f
                 where f.status = 'accepted'
                   and f.user_a = least(p_user, auth.uid()) and f.user_b = greatest(p_user, auth.uid()));
$$;

-- Awards every not-yet-owned active badge of one rule type whose threshold the user now meets.
-- Called only when the matching counter changed; badges already owned are skipped by the anti-join.
create or replace function public.award_badges(p_user uuid, p_rule text)
returns setof public.badges language plpgsql security definer set search_path = '' as $$
declare
  v_value numeric;
  b public.badges%rowtype;
begin
  select case p_rule
           when 'on_register'        then 1
           when 'count_runs'         then p.runs_count
           when 'count_games'        then p.games_count
           when 'count_achievements' then p.achievements_count
           when 'count_friends'      then p.friends_count
         end
    into v_value from public.profiles p where p.id = p_user;
  if v_value is null then return; end if;

  for b in
    select bd.* from public.badges bd
    where bd.active and bd.rule_type = p_rule
      and v_value >= coalesce((bd.threshold ->> 'gte')::numeric, 1)
      and not exists (select 1 from public.user_badges ub where ub.user_id = p_user and ub.badge_id = bd.id)
    order by bd.sort_order
  loop
    insert into public.user_badges (user_id, badge_id) values (p_user, b.id) on conflict do nothing;
    if found then
      insert into public.activity (user_id, kind, ref, payload)
      values (p_user, 'badge', b.id, jsonb_build_object('name', b.name, 'icon_url', b.icon_url));
      return next b;
    end if;
  end loop;
end $$;

-- Copies a manifest into the normalized definition tables. Additive: removed items are marked retired.
create or replace function public.apply_manifest(p_game_id text, p_manifest jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_version int := (p_manifest ->> 'manifestVersion')::int;
  s jsonb; l jsonb; a jsonb; i int := 0;
begin
  if v_version is null or v_version < 1 then raise exception 'manifestVersion missing'; end if;
  if p_manifest ->> 'gameId' is distinct from p_game_id then raise exception 'gameId mismatch'; end if;

  insert into public.game_manifests (game_id, version, manifest) values (p_game_id, v_version, p_manifest)
  on conflict (game_id, version) do update set manifest = excluded.manifest, published_at = now();

  update public.stat_defs set retired = true where game_id = p_game_id;
  for s in select value from jsonb_array_elements(coalesce(p_manifest -> 'stats', '[]')) loop
    insert into public.stat_defs (game_id, stat_id, agg, value_type, max_value, max_delta, name, retired)
    values (p_game_id, s ->> 'id', s ->> 'agg', coalesce(s ->> 'type', 'number'), (s ->> 'max')::numeric,
            -- counts without an explicit cap still get one, so one event cannot add a billion
            coalesce((s ->> 'maxDelta')::numeric, case when s ->> 'agg' in ('sum', 'count') then 1000000 end),
            s ->> 'name', false)
    on conflict (game_id, stat_id) do update set agg = excluded.agg, value_type = excluded.value_type,
      max_value = excluded.max_value, max_delta = excluded.max_delta, name = excluded.name, retired = false;
  end loop;

  update public.leaderboards set retired = true where game_id = p_game_id;
  for l in select value from jsonb_array_elements(coalesce(p_manifest -> 'leaderboards', '[]')) loop
    insert into public.leaderboards (game_id, lb_id, name, sort, min_value, max_value, retired)
    values (p_game_id, l ->> 'id', l ->> 'name', l ->> 'sort', (l ->> 'min')::numeric, (l ->> 'max')::numeric, false)
    on conflict (game_id, lb_id) do update set name = excluded.name, sort = excluded.sort,
      min_value = excluded.min_value, max_value = excluded.max_value, retired = false;
  end loop;

  for a in select value from jsonb_array_elements(coalesce(p_manifest -> 'achievements', '[]')) loop
    i := i + 1;
    insert into public.achievements (game_id, ach_id, name, description, icon, hidden, rule, sort_order)
    values (p_game_id, a ->> 'id', a ->> 'name', a ->> 'description', a ->> 'icon',
            coalesce((a ->> 'hidden')::boolean, false), a -> 'rule', i)
    on conflict (game_id, ach_id) do update set name = excluded.name, description = excluded.description,
      icon = excluded.icon, hidden = excluded.hidden, rule = excluded.rule, sort_order = excluded.sort_order;
  end loop;

  update public.games set current_manifest_version = greatest(coalesce(current_manifest_version, 0), v_version)
  where id = p_game_id;
end $$;

-- =====================================================================
-- Triggers: profile on sign-up, counters, badges, activity
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text := new.raw_user_meta_data ->> 'username';
  v_try int := 0;
begin
  if v_name is null or v_name !~ '^[A-Za-z0-9_]{3,20}$'
     or exists (select 1 from public.profiles where lower(username) = lower(v_name)) then
    loop
      v_name := 'player_' || substr(md5(new.id::text || v_try::text), 1, 8);
      exit when not exists (select 1 from public.profiles where lower(username) = lower(v_name));
      v_try := v_try + 1;
    end loop;
  end if;
  insert into public.profiles (id, username) values (new.id, v_name);
  insert into public.activity (user_id, kind) values (new.id, 'joined');
  perform public.award_badges(new.id, 'on_register');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.profiles_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.profiles_touch();

create or replace function public.on_library_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set games_count = games_count + 1 where id = new.user_id;
  perform public.award_badges(new.user_id, 'count_games');
  return new;
end $$;
create trigger library_counter after insert on public.user_library for each row execute function public.on_library_insert();

create or replace function public.on_library_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set games_count = greatest(games_count - 1, 0) where id = old.user_id;
  return old;
end $$;
create trigger library_counter_del after delete on public.user_library for each row execute function public.on_library_delete();

create or replace function public.on_play_session()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set runs_count = runs_count + 1, last_seen_at = now() where id = new.user_id;
  update public.user_library set runs = runs + 1, playtime_ms = playtime_ms + new.duration_ms,
         last_played_at = now(), first_played_at = coalesce(first_played_at, now())
   where user_id = new.user_id and game_id = new.game_id;
  if not found then -- first run of this game: add it to the library
    insert into public.user_library (user_id, game_id, first_played_at, last_played_at, runs, playtime_ms)
    values (new.user_id, new.game_id, now(), now(), 1, new.duration_ms);
  end if;
  perform public.award_badges(new.user_id, 'count_runs');
  return new;
end $$;
create trigger play_session_counter after insert on public.play_sessions for each row execute function public.on_play_session();

create or replace function public.on_achievement()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set achievements_count = achievements_count + 1 where id = new.user_id;
  insert into public.activity (user_id, kind, game_id, ref, payload)
  select new.user_id, 'achievement', new.game_id, new.ach_id,
         jsonb_build_object('name', a.name, 'icon', a.icon, 'source', new.source)
    from public.achievements a where a.game_id = new.game_id and a.ach_id = new.ach_id;
  perform public.award_badges(new.user_id, 'count_achievements');
  return new;
end $$;
create trigger achievement_counter after insert on public.user_achievements for each row execute function public.on_achievement();

create or replace function public.on_friendship_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'accepted' then
      update public.profiles set friends_count = greatest(friends_count - 1, 0) where id in (old.user_a, old.user_b);
    end if;
    return old;
  end if;
  if new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from 'accepted') then
    update public.profiles set friends_count = friends_count + 1 where id in (new.user_a, new.user_b);
    insert into public.activity (user_id, kind, ref) values (new.user_a, 'friend', new.user_b::text), (new.user_b, 'friend', new.user_a::text);
    perform public.award_badges(new.user_a, 'count_friends');
    perform public.award_badges(new.user_b, 'count_friends');
  end if;
  return new;
end $$;
create trigger friendship_counter after insert or update or delete on public.friendships
  for each row execute function public.on_friendship_change();

-- =====================================================================
-- Sync RPC: one call per finished run (or backfill snapshot)
-- =====================================================================

-- Applies one stat value. Returns null when accepted, otherwise the reason.
create or replace function public._apply_stat(p_user uuid, p_game text, p_stat text, p_value jsonb, p_at timestamptz, p_as_total boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  sd public.stat_defs%rowtype;
  n numeric;
begin
  select * into sd from public.stat_defs where game_id = p_game and stat_id = p_stat;
  if not found or sd.retired then return 'unknown stat'; end if;

  if sd.agg = 'latest' and sd.value_type = 'string' then
    if jsonb_typeof(p_value) <> 'string' then return 'bad value'; end if;
    insert into public.user_stats (user_id, game_id, stat_id, value_text, client_at)
    values (p_user, p_game, p_stat, left(p_value #>> '{}', 200), p_at)
    on conflict (user_id, game_id, stat_id) do update
      set value_text = excluded.value_text, client_at = excluded.client_at, updated_at = now()
      where public.user_stats.client_at is null or excluded.client_at >= public.user_stats.client_at;
    return null;
  end if;

  if jsonb_typeof(p_value) <> 'number' then return 'bad value'; end if;
  n := (p_value #>> '{}')::numeric;

  if sd.agg in ('sum', 'count') then
    if n < 0 then return 'negative'; end if;
    if not p_as_total and sd.max_delta is not null then n := least(n, sd.max_delta); end if;
  end if;
  if sd.max_value is not null then n := least(n, sd.max_value); end if;

  insert into public.user_stats as us (user_id, game_id, stat_id, value, client_at)
  values (p_user, p_game, p_stat, n, p_at)
  on conflict (user_id, game_id, stat_id) do update set
    value = case
      when sd.agg in ('sum', 'count') and not p_as_total
        then case when sd.max_value is null then us.value + excluded.value else least(us.value + excluded.value, sd.max_value) end
      when sd.agg in ('sum', 'count', 'max') then greatest(us.value, excluded.value)  -- backfill totals: never double count
      when sd.agg = 'min' then least(us.value, excluded.value)
      when sd.agg = 'latest' then case when us.client_at is null or excluded.client_at >= us.client_at then excluded.value else us.value end
    end,
    client_at = greatest(us.client_at, excluded.client_at),
    updated_at = now();
  return null;
end $$;

create or replace function public._apply_score(p_user uuid, p_game text, p_lb text, p_value jsonb, p_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  lb public.leaderboards%rowtype;
  n numeric;
  v_rows int;
begin
  select * into lb from public.leaderboards where game_id = p_game and lb_id = p_lb;
  if not found or lb.retired then return 'unknown leaderboard'; end if;
  if jsonb_typeof(p_value) <> 'number' then return 'bad value'; end if;
  n := (p_value #>> '{}')::numeric;
  if (lb.min_value is not null and n < lb.min_value) or (lb.max_value is not null and n > lb.max_value) then
    return 'out of bounds';
  end if;
  insert into public.scores (user_id, game_id, lb_id, value, client_at) values (p_user, p_game, p_lb, n, p_at);
  insert into public.leaderboard_best as b (game_id, lb_id, user_id, value, achieved_at)
  values (p_game, p_lb, p_user, n, p_at)
  on conflict (game_id, lb_id, user_id) do update set value = excluded.value, achieved_at = excluded.achieved_at
    where (lb.sort = 'desc' and excluded.value > b.value) or (lb.sort = 'asc' and excluded.value < b.value);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    insert into public.activity (user_id, kind, game_id, ref, payload)
    values (p_user, 'new_best', p_game, p_lb, jsonb_build_object('value', n, 'name', lb.name));
  end if;
  return null;
end $$;

create or replace function public._apply_claim(p_user uuid, p_game text, p_ach text, p_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  a public.achievements%rowtype;
  v_recent int;
begin
  select * into a from public.achievements where game_id = p_game and ach_id = p_ach;
  if not found then return 'unknown achievement'; end if;
  if a.rule ? 'stat' then return 'deferred'; end if; -- rule-based: the server decides from stats
  select count(*) into v_recent from public.user_achievements
   where user_id = p_user and source = 'claim' and created_at > now() - interval '1 hour';
  if v_recent >= 100 then return 'claim rate'; end if;
  insert into public.user_achievements (user_id, game_id, ach_id, unlocked_at, source)
  values (p_user, p_game, p_ach, least(coalesce(p_at, now()), now()), 'claim')
  on conflict do nothing;
  return null;
end $$;

create or replace function public.ingest_batch(p_game_id text, p_manifest_version int, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_game    public.games%rowtype;
  v_now     timestamptz := now();
  v_n       int;
  v_recent  int;
  e         jsonb;
  p         jsonb;
  v_idem    text;
  v_type    text;
  v_at      timestamptz;
  v_reason  text;
  v_status  text;
  v_results jsonb := '[]'::jsonb;
  k         text;
  val       jsonb;
begin
  if v_uid is null then return jsonb_build_object('error', 'signed-out'); end if;
  select * into v_game from public.games where id = p_game_id;
  if not found or (v_game.status <> 'listed' and v_game.developer_id is distinct from v_uid) then
    return jsonb_build_object('error', 'unknown-game');
  end if;
  if jsonb_typeof(p_events) is distinct from 'array' then return jsonb_build_object('error', 'server', 'message', 'events must be an array'); end if;
  v_n := jsonb_array_length(p_events);
  if v_n > 200 then return jsonb_build_object('error', 'server', 'message', 'max 200 events per batch'); end if;

  -- rate limit: 1,000 events per 10 minutes per user
  select count(*) into v_recent from public.ingest_log where user_id = v_uid and received_at > v_now - interval '10 minutes';
  if v_recent + v_n > 1000 then return jsonb_build_object('error', 'rate-limited', 'retryAfterMs', 600000); end if;

  update public.profiles set last_seen_at = v_now where id = v_uid;

  for e in select value from jsonb_array_elements(p_events) loop
    v_idem := e ->> 'idem';
    v_type := e ->> 'type';
    p := e -> 'payload';
    if v_idem is null or char_length(v_idem) > 64 or jsonb_typeof(p) is distinct from 'object' then
      v_results := v_results || jsonb_build_object('idem', coalesce(v_idem, ''), 'status', 'rejected', 'reason', 'malformed');
      continue;
    end if;
    begin
      v_at := least(to_timestamp((e ->> 'at')::double precision / 1000), v_now); -- never in the future
    exception when others then
      v_at := v_now;
    end;

    insert into public.ingest_log (user_id, idem, game_id) values (v_uid, v_idem, p_game_id) on conflict do nothing;
    if not found then
      v_results := v_results || jsonb_build_object('idem', v_idem, 'status', 'duplicate');
      continue;
    end if;

    v_reason := null;
    case v_type
      when 'stat' then
        v_reason := public._apply_stat(v_uid, p_game_id, p ->> 'id', p -> 'value', v_at, false);
      when 'score' then
        v_reason := public._apply_score(v_uid, p_game_id, p ->> 'lb', p -> 'value', v_at);
      when 'achievement' then
        v_reason := public._apply_claim(v_uid, p_game_id, p ->> 'id',
                      coalesce(to_timestamp((p ->> 'unlockedAt')::double precision / 1000), v_at));
      when 'session' then
        insert into public.play_sessions (user_id, game_id, duration_ms, client_at)
        values (v_uid, p_game_id, least(greatest(coalesce((p ->> 'durationMs')::numeric, 0), 0), 86400000)::int, v_at);
      when 'snapshot' then
        -- backfill of everything earned before linking: totals take the larger value, achievements union
        for k, val in select key, value from jsonb_each(coalesce(p -> 'stats', '{}')) loop
          perform public._apply_stat(v_uid, p_game_id, k, val, v_at, true);
        end loop;
        for k, val in select key, value from jsonb_each(coalesce(p -> 'best', '{}')) loop
          perform public._apply_score(v_uid, p_game_id, k, val, v_at);
        end loop;
        for k, val in select key, value from jsonb_each(coalesce(p -> 'achievements', '{}')) loop
          perform public._apply_claim(v_uid, p_game_id, k, least(to_timestamp((val #>> '{}')::double precision / 1000), v_now));
        end loop;
        insert into public.user_library (user_id, game_id, first_played_at, last_played_at)
        values (v_uid, p_game_id, v_now, v_now) on conflict do nothing;
      else
        v_reason := 'unknown type';
    end case;

    v_status := case when v_reason is null then 'accepted' when v_reason = 'deferred' then 'deferred' else 'rejected' end;
    update public.ingest_log set status = v_status where user_id = v_uid and idem = v_idem;
    v_results := v_results || case when v_reason is null
      then jsonb_build_object('idem', v_idem, 'status', v_status)
      else jsonb_build_object('idem', v_idem, 'status', v_status, 'reason', v_reason) end;
  end loop;

  -- server-side rule achievements ({"stat": x, "gte": n}) for this game
  insert into public.user_achievements (user_id, game_id, ach_id, unlocked_at, source)
  select v_uid, a.game_id, a.ach_id, v_now, 'rule'
    from public.achievements a
    join public.user_stats us on us.user_id = v_uid and us.game_id = a.game_id and us.stat_id = a.rule ->> 'stat'
   where a.game_id = p_game_id and a.rule ? 'stat' and us.value >= (a.rule ->> 'gte')::numeric
  on conflict do nothing;

  return jsonb_build_object(
    'results', v_results,
    'unlocked', coalesce((select jsonb_agg(ua.ach_id) from public.user_achievements ua
                           where ua.user_id = v_uid and ua.game_id = p_game_id and ua.created_at = v_now), '[]'::jsonb),
    'badges', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'description', b.description, 'iconUrl', b.icon_url) order by b.sort_order)
                          from public.user_badges ub join public.badges b on b.id = ub.badge_id
                         where ub.user_id = v_uid and ub.awarded_at = v_now), '[]'::jsonb),
    'stats', coalesce((select jsonb_object_agg(us.stat_id, coalesce(to_jsonb(us.value), to_jsonb(us.value_text)))
                         from public.user_stats us where us.user_id = v_uid and us.game_id = p_game_id), '{}'::jsonb)
  );
end $$;

-- =====================================================================
-- Read RPCs (one call per screen)
-- =====================================================================

-- Nickname search: prefix match on the unique lower(username) index, public fields only.
create or replace function public.search_users(p_query text, p_limit int default 20)
returns table (id uuid, username text, display_name text, avatar_url text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, p.display_name, p.avatar_url
    from public.profiles p
   where char_length(trim(p_query)) >= 2
     and lower(p.username) like replace(replace(replace(lower(trim(p_query)), '\', '\\'), '%', '\%'), '_', '\_') || '%'
   order by lower(p.username)
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- Everything the profile screen needs in one round trip. Respects privacy (public / friends only).
create or replace function public.get_profile(p_username text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  pr public.profiles%rowtype;
  v_me uuid := auth.uid();
  v_rel text := 'none';
  f public.friendships%rowtype;
begin
  select * into pr from public.profiles where lower(username) = lower(p_username);
  if not found then return null; end if;

  if v_me = pr.id then v_rel := 'self';
  elsif v_me is not null then
    select * into f from public.friendships where user_a = least(v_me, pr.id) and user_b = greatest(v_me, pr.id);
    if found then
      v_rel := case when f.status = 'accepted' then 'friend' when f.requested_by = v_me then 'request_sent' else 'request_received' end;
    end if;
  end if;

  if not public.can_view(pr.id) then
    return jsonb_build_object('id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
      'avatar_url', pr.avatar_url, 'created_at', pr.created_at, 'privacy', pr.privacy, 'relation', v_rel, 'restricted', true);
  end if;

  return jsonb_build_object(
    'id', pr.id, 'username', pr.username, 'display_name', pr.display_name, 'bio', pr.bio,
    'avatar_url', pr.avatar_url, 'created_at', pr.created_at, 'privacy', pr.privacy, 'relation', v_rel,
    'restricted', false, 'last_seen_at', pr.last_seen_at,
    'counts', jsonb_build_object('runs', pr.runs_count, 'games', pr.games_count,
                                 'achievements', pr.achievements_count, 'friends', pr.friends_count),
    'badges', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'description', b.description,
                          'icon_url', b.icon_url, 'awarded_at', ub.awarded_at) order by b.sort_order)
                          from public.user_badges ub join public.badges b on b.id = ub.badge_id where ub.user_id = pr.id), '[]'::jsonb),
    'games', coalesce((select jsonb_agg(jsonb_build_object(
                          'game_id', g.id, 'name', g.name, 'icon_url', g.icon_url,
                          'runs', l.runs, 'playtime_ms', l.playtime_ms, 'last_played_at', l.last_played_at,
                          'achievements', (select count(*) from public.user_achievements ua where ua.user_id = pr.id and ua.game_id = g.id),
                          'achievements_total', (select count(*) from public.achievements a where a.game_id = g.id),
                          'stats', (select jsonb_object_agg(us.stat_id, coalesce(to_jsonb(us.value), to_jsonb(us.value_text)))
                                      from public.user_stats us where us.user_id = pr.id and us.game_id = g.id),
                          'best', (select jsonb_object_agg(lb.lb_id, lb.value) from public.leaderboard_best lb
                                    where lb.user_id = pr.id and lb.game_id = g.id))
                        order by l.last_played_at desc nulls last)
                        from public.user_library l join public.games g on g.id = l.game_id where l.user_id = pr.id), '[]'::jsonb),
    'recent_achievements', coalesce((select jsonb_agg(x) from (
                          select jsonb_build_object('game_id', ua.game_id, 'ach_id', ua.ach_id, 'name', a.name,
                                   'icon', a.icon, 'unlocked_at', ua.unlocked_at) x
                            from public.user_achievements ua
                            join public.achievements a on a.game_id = ua.game_id and a.ach_id = ua.ach_id
                           where ua.user_id = pr.id order by ua.unlocked_at desc limit 12) t), '[]'::jsonb),
    'friends', coalesce((select jsonb_agg(x) from (
                          select jsonb_build_object('id', o.id, 'username', o.username, 'avatar_url', o.avatar_url) x
                            from public.friendships fr
                            join public.profiles o on o.id = case when fr.user_a = pr.id then fr.user_b else fr.user_a end
                           where fr.status = 'accepted' and pr.id in (fr.user_a, fr.user_b)
                           order by fr.accepted_at desc limit 50) t), '[]'::jsonb),
    'activity', coalesce((select jsonb_agg(x) from (
                          select jsonb_build_object('kind', ac.kind, 'game_id', ac.game_id, 'ref', ac.ref, 'payload', ac.payload,
                                   'created_at', ac.created_at,
                                   'friend', case when ac.kind = 'friend' then (select o.username from public.profiles o where o.id::text = ac.ref) end) x
                            from public.activity ac where ac.user_id = pr.id order by ac.id desc limit 30) t), '[]'::jsonb)
  );
end $$;

create or replace function public.get_leaderboard(p_game_id text, p_lb_id text, p_limit int default 50)
returns table (rank bigint, user_id uuid, username text, avatar_url text, value numeric, achieved_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select rank() over (order by case when l.sort = 'desc' then -b.value else b.value end), b.user_id, p.username, p.avatar_url, b.value, b.achieved_at
    from public.leaderboard_best b
    join public.leaderboards l on l.game_id = b.game_id and l.lb_id = b.lb_id
    join public.profiles p on p.id = b.user_id
   where b.game_id = p_game_id and b.lb_id = p_lb_id and b.trust <> 'flagged' and public.can_view(b.user_id)
   order by 1
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- =====================================================================
-- Friends RPCs
-- =====================================================================
create or replace function public.send_friend_request(p_username text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_other uuid;
  f public.friendships%rowtype;
  v_today int;
begin
  if v_me is null then raise exception 'not signed in'; end if;
  select id into v_other from public.profiles where lower(username) = lower(p_username);
  if v_other is null then return 'not_found'; end if;
  if v_other = v_me then return 'self'; end if;
  select count(*) into v_today from public.friendships where requested_by = v_me and created_at > now() - interval '1 day';
  if v_today >= 30 then return 'rate_limited'; end if;
  select * into f from public.friendships where user_a = least(v_me, v_other) and user_b = greatest(v_me, v_other);
  if found then
    if f.status = 'accepted' then return 'already_friends'; end if;
    if f.requested_by = v_me then return 'already_sent'; end if;
    -- they asked me before: accept
    update public.friendships set status = 'accepted', accepted_at = now() where user_a = f.user_a and user_b = f.user_b;
    return 'accepted';
  end if;
  insert into public.friendships (user_a, user_b, status, requested_by)
  values (least(v_me, v_other), greatest(v_me, v_other), 'pending', v_me);
  return 'sent';
end $$;

create or replace function public.respond_friend_request(p_user uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid();
begin
  if p_accept then
    update public.friendships set status = 'accepted', accepted_at = now()
     where user_a = least(v_me, p_user) and user_b = greatest(v_me, p_user) and status = 'pending' and requested_by = p_user;
  else
    delete from public.friendships
     where user_a = least(v_me, p_user) and user_b = greatest(v_me, p_user) and status = 'pending' and requested_by = p_user;
  end if;
  return case when found then 'ok' else 'not_found' end;
end $$;

-- removes a friend, or cancels my own pending request
create or replace function public.remove_friend(p_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid();
begin
  delete from public.friendships where user_a = least(v_me, p_user) and user_b = greatest(v_me, p_user)
    and (status = 'accepted' or requested_by = v_me);
  return case when found then 'ok' else 'not_found' end;
end $$;

create or replace function public.my_friends()
returns table (user_id uuid, username text, display_name text, avatar_url text, status text, direction text, since timestamptz, last_seen_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.username, o.display_name, o.avatar_url, f.status,
         case when f.status = 'accepted' then 'mutual' when f.requested_by = auth.uid() then 'outgoing' else 'incoming' end,
         coalesce(f.accepted_at, f.created_at), o.last_seen_at
    from public.friendships f
    join public.profiles o on o.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
   where auth.uid() in (f.user_a, f.user_b)
   order by f.status desc, o.username;
$$;

-- =====================================================================
-- Row Level Security + grants
-- =====================================================================
alter table public.profiles          enable row level security;
alter table public.games             enable row level security;
alter table public.game_keys         enable row level security;
alter table public.game_manifests    enable row level security;
alter table public.stat_defs         enable row level security;
alter table public.leaderboards      enable row level security;
alter table public.achievements      enable row level security;
alter table public.user_library      enable row level security;
alter table public.reviews           enable row level security;
alter table public.user_stats        enable row level security;
alter table public.user_achievements enable row level security;
alter table public.play_sessions     enable row level security;
alter table public.scores            enable row level security;
alter table public.leaderboard_best  enable row level security;
alter table public.ingest_log        enable row level security; -- no policies: RPC only
alter table public.friendships       enable row level security;
alter table public.badges            enable row level security;
alter table public.user_badges       enable row level security;
alter table public.activity          enable row level security;

-- Clients may only write the few columns/tables below; everything else goes through RPCs.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
grant update (username, display_name, bio, avatar_url, privacy) on public.profiles to authenticated;
grant insert (user_id, game_id) on public.user_library to authenticated;
grant delete on public.user_library to authenticated;
grant insert (user_id, game_id, rating, body), update (rating, body, updated_at), delete on public.reviews to authenticated;

-- profiles: only the basic card (username, avatar, join date, privacy) is readable directly;
-- bio, counters and last_seen go through get_profile(), which applies the privacy setting.
revoke select on public.profiles from anon, authenticated;
grant select (id, username, display_name, avatar_url, privacy, created_at) on public.profiles to anon, authenticated;
create policy "profiles readable" on public.profiles for select using (true);
create policy "own profile update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- catalog / definitions: public read
create policy "listed games readable" on public.games for select
  using (status = 'listed' or developer_id = (select auth.uid()));
create policy "manifests readable" on public.game_manifests for select using (true);
create policy "stat defs readable" on public.stat_defs for select using (true);
create policy "leaderboards readable" on public.leaderboards for select using (true);
create policy "achievements readable" on public.achievements for select using (true);
create policy "badges readable" on public.badges for select using (true);
create policy "dev reads own keys" on public.game_keys for select to authenticated
  using (exists (select 1 from public.games g where g.id = game_id and g.developer_id = (select auth.uid())));

-- per-user data: visible per privacy setting
create policy "library visible" on public.user_library for select using (public.can_view(user_id));
create policy "own library add" on public.user_library for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own library remove" on public.user_library for delete to authenticated using (user_id = (select auth.uid()));
create policy "stats visible" on public.user_stats for select using (public.can_view(user_id));
create policy "achievements visible" on public.user_achievements for select using (public.can_view(user_id));
create policy "badges visible" on public.user_badges for select using (public.can_view(user_id));
create policy "activity visible" on public.activity for select using (public.can_view(user_id));
create policy "best visible" on public.leaderboard_best for select using (public.can_view(user_id));
create policy "own scores" on public.scores for select to authenticated using (user_id = (select auth.uid()));
create policy "own sessions" on public.play_sessions for select to authenticated using (user_id = (select auth.uid()));
create policy "own friendships" on public.friendships for select to authenticated
  using ((select auth.uid()) in (user_a, user_b));

-- reviews: public read; one per user per game, only for games in your library
create policy "reviews readable" on public.reviews for select using (true);
create policy "own review insert" on public.reviews for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.user_library l where l.user_id = (select auth.uid()) and l.game_id = reviews.game_id));
create policy "own review update" on public.reviews for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own review delete" on public.reviews for delete to authenticated using (user_id = (select auth.uid()));

-- functions: internal helpers are not callable from the API; RPCs only for signed-in users
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.can_view(uuid) to anon, authenticated;
grant execute on function public.ingest_batch(text, int, jsonb) to authenticated;
grant execute on function public.search_users(text, int) to authenticated;
grant execute on function public.get_profile(text) to anon, authenticated;
grant execute on function public.get_leaderboard(text, text, int) to anon, authenticated;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.my_friends() to authenticated;

-- =====================================================================
-- Storage: WebP-only public buckets
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true, 524288, array['image/webp']),       -- 512 KB hard cap; the client aims for < 50 KB
  ('game-icons', 'game-icons', true, 262144, array['image/webp'])  -- game icons and badges/; written by admins only
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- avatars/{user_id}/avatar.webp : users write only inside their own folder (upsert needs select+insert+update)
create policy "avatar read own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatar insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatar update own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatar delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
