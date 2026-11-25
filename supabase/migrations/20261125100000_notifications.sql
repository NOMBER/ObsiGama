-- Notifications for friend requests, accepted friendships, and platform badges (not achievements).
-- New migration; do not edit earlier ones. Safe to run more than once.
-- After: 20261120120000_mini_old_games_caps.sql

create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('friend_request', 'friend_accepted', 'badge')),
  actor_id   uuid references public.profiles (id) on delete set null,
  badge_id   text references public.badges (id) on delete set null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

revoke all on public.notifications from anon, authenticated;
grant select, update (read_at) on public.notifications to authenticated;

drop policy if exists "own notifications read" on public.notifications;
create policy "own notifications read" on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own notifications mark read" on public.notifications;
create policy "own notifications mark read" on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Incoming request → notify the recipient. Acceptance → notify the original requester.
-- Unread request notices are removed when the request is accepted, declined or cancelled.
create or replace function public.on_friendship_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_recipient uuid;
  v_accepter uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.notifications
      where kind = 'friend_request' and read_at is null
        and (
          (user_id = old.user_a and actor_id = old.user_b) or
          (user_id = old.user_b and actor_id = old.user_a)
        );
    return old;
  end if;

  if new.status = 'pending' and (tg_op = 'INSERT' or old.status is distinct from 'pending') then
    v_recipient := case when new.requested_by = new.user_a then new.user_b else new.user_a end;
    insert into public.notifications (user_id, kind, actor_id)
    values (v_recipient, 'friend_request', new.requested_by);
  end if;

  if new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from 'accepted') then
    v_accepter := case when new.requested_by = new.user_a then new.user_b else new.user_a end;
    insert into public.notifications (user_id, kind, actor_id)
    values (new.requested_by, 'friend_accepted', v_accepter);
    delete from public.notifications
      where user_id = v_accepter and kind = 'friend_request' and actor_id = new.requested_by and read_at is null;
  end if;

  return new;
end $$;

drop trigger if exists friendship_notify on public.friendships;
create trigger friendship_notify
  after insert or update or delete on public.friendships
  for each row execute function public.on_friendship_notify();

create or replace function public.on_badge_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, kind, badge_id, payload)
  select new.user_id, 'badge', new.badge_id,
         jsonb_build_object('name', b.name, 'icon_url', b.icon_url)
    from public.badges b where b.id = new.badge_id;
  return new;
end $$;

drop trigger if exists badge_notify on public.user_badges;
create trigger badge_notify
  after insert on public.user_badges
  for each row execute function public.on_badge_notify();

create or replace function public.my_notifications(p_limit integer default 40)
returns table (
  id bigint,
  kind text,
  actor_id uuid,
  actor_username text,
  actor_avatar_url text,
  badge_id text,
  badge_name text,
  created_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.kind, n.actor_id, p.username, p.avatar_url,
         n.badge_id, coalesce(b.name, n.payload ->> 'name'),
         n.created_at, n.read_at
  from public.notifications n
  left join public.profiles p on p.id = n.actor_id
  left join public.badges b on b.id = n.badge_id
  where n.user_id = (select auth.uid())
  order by n.created_at desc
  limit least(greatest(coalesce(p_limit, 40), 1), 100);
$$;

create or replace function public.unread_notification_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.notifications
  where user_id = (select auth.uid()) and read_at is null;
$$;

create or replace function public.mark_notifications_read(p_ids bigint[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if (select auth.uid()) is null then
    raise exception 'not signed in';
  end if;
  update public.notifications
     set read_at = now()
   where user_id = (select auth.uid())
     and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.my_notifications(integer) from public, anon;
revoke all on function public.unread_notification_count() from public, anon;
revoke all on function public.mark_notifications_read(bigint[]) from public, anon;
grant execute on function public.my_notifications(integer) to authenticated;
grant execute on function public.unread_notification_count() to authenticated;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;
