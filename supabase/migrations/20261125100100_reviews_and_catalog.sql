-- Reviews RPCs (thumbs up/down + text), launch_command / in_store on games, icon URLs.
-- New migration; do not edit earlier ones. Safe to run more than once.
-- After: 20261125100000_notifications.sql
--
-- Game icons: after uploading the WebP files to the public game-icons bucket
-- (see /workspace path in the copy at obsigama-sql/icons/), these URLs start working.
-- Running this SQL before the upload is fine; the catalog will show the icons once the files are there.
-- Self-hosted servers should change the icon_url prefix to their own Supabase URL.

alter table public.games add column if not exists launch_command text;
alter table public.games add column if not exists in_store boolean not null default false;

update public.games set
  launch_command = 'good-old-games:open-hub',
  in_store = true,
  icon_url = 'https://eravzmmusvdtsqsxplij.supabase.co/storage/v1/object/public/game-icons/games/mini-old-games.webp'
where id = 'mini-old-games';

update public.games set
  launch_command = 'vault-shards:open',
  in_store = true,
  icon_url = 'https://eravzmmusvdtsqsxplij.supabase.co/storage/v1/object/public/game-icons/games/hellvault.webp'
where id = 'hellvault';

-- reviews already exist (one row per user per game, public read, write only if the game is in the library).
-- Tighten to thumbs (rating 1 or 5) and 1000-character bodies; writes go through RPCs (rate limit).
alter table public.reviews drop constraint if exists reviews_body_check;
alter table public.reviews add constraint reviews_body_check check (body is null or char_length(body) <= 1000);
alter table public.reviews drop constraint if exists reviews_rating_check;
-- 5 = thumbs up, 1 = thumbs down
alter table public.reviews add constraint reviews_rating_check check (rating in (1, 5));

revoke insert, update, delete on public.reviews from anon, authenticated;
grant select on public.reviews to anon, authenticated;

create or replace function public.get_game_reviews(p_game_id text, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_me uuid := (select auth.uid());
  v_up integer;
  v_down integer;
  v_mine jsonb;
  v_list jsonb;
begin
  if p_game_id is null or p_game_id = '' then
    return jsonb_build_object('game_id', p_game_id, 'up', 0, 'down', 0, 'total', 0, 'mine', null, 'reviews', '[]'::jsonb);
  end if;

  select count(*) filter (where rating = 5)::integer,
         count(*) filter (where rating = 1)::integer
    into v_up, v_down
    from public.reviews where game_id = p_game_id;

  if v_me is not null then
    select jsonb_build_object(
             'recommend', r.rating = 5,
             'body', r.body,
             'created_at', r.created_at,
             'updated_at', r.updated_at
           )
      into v_mine
      from public.reviews r
     where r.game_id = p_game_id and r.user_id = v_me;
  end if;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    into v_list
    from (
      select r.user_id, p.username, p.display_name, p.avatar_url,
             (r.rating = 5) as recommend, r.body, r.created_at, r.updated_at
      from public.reviews r
      join public.profiles p on p.id = r.user_id
      where r.game_id = p_game_id
      order by r.updated_at desc
      limit v_limit
    ) x;

  return jsonb_build_object(
    'game_id', p_game_id,
    'up', coalesce(v_up, 0),
    'down', coalesce(v_down, 0),
    'total', coalesce(v_up, 0) + coalesce(v_down, 0),
    'mine', v_mine,
    'reviews', v_list
  );
end $$;

create or replace function public.upsert_review(p_game_id text, p_recommend boolean, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_rating smallint := case when p_recommend then 5 else 1 end;
  v_row public.reviews%rowtype;
begin
  if v_me is null then raise exception 'Sign in first.'; end if;
  if p_recommend is null then raise exception 'Choose thumbs up or thumbs down.'; end if;
  if p_game_id is null or not exists (select 1 from public.games g where g.id = p_game_id and g.status = 'listed') then
    raise exception 'Unknown game.';
  end if;
  if not exists (select 1 from public.user_library l where l.user_id = v_me and l.game_id = p_game_id) then
    raise exception 'Add the game to your library to write a review.';
  end if;
  if v_body is not null and char_length(v_body) > 1000 then
    raise exception 'Review text can be at most 1000 characters.';
  end if;
  if exists (
    select 1 from public.reviews r
     where r.user_id = v_me and r.updated_at > now() - interval '15 seconds'
  ) then
    raise exception 'Please wait a moment before posting another review.';
  end if;

  insert into public.reviews (user_id, game_id, rating, body)
  values (v_me, p_game_id, v_rating, v_body)
  on conflict (user_id, game_id) do update
    set rating = excluded.rating, body = excluded.body, updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'recommend', v_row.rating = 5,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'updated_at', v_row.updated_at
  );
end $$;

create or replace function public.delete_review(p_game_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then raise exception 'Sign in first.'; end if;
  delete from public.reviews where user_id = v_me and game_id = p_game_id;
end $$;

revoke all on function public.get_game_reviews(text, integer) from public;
revoke all on function public.upsert_review(text, boolean, text) from public;
revoke all on function public.delete_review(text) from public;
grant execute on function public.get_game_reviews(text, integer) to anon, authenticated;
grant execute on function public.upsert_review(text, boolean, text) to authenticated;
grant execute on function public.delete_review(text) to authenticated;
