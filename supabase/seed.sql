-- =====================================================================
-- LOCAL TEST DATA. Runs only on `npx supabase db reset` against the
-- local stack. It never touches production.
--
-- Test accounts (password for both: spac3-test-pass):
--   alice@test.local   owns "Test Room"
--   bob@test.local     alice's friend
--
-- Fixed IDs so tests can refer to them:
--   alice  11111111-1111-4111-8111-111111111111
--   bob    22222222-2222-4222-8222-222222222222
--   room   aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Things production has that the public-schema dump leaves out.
--    TEMPORARY: these move into a real migration once we export the
--    exact production definitions (auth trigger + storage buckets and
--    policies). Until then they exist only locally.
-- ---------------------------------------------------------------------

-- Create a profile row when someone signs up (production has an
-- equivalent trigger on auth.users; its exact name is still to confirm).
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Storage buckets the app uses. Public ones are read with getPublicUrl().
insert into storage.buckets (id, name, public) values
  ('avatars',      'avatars',      true),
  ('room-banners', 'room-banners', true),
  ('room-media',   'room-media',   true),
  ('stickers',     'stickers',     true),
  ('drawings',     'drawings',     false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Test users (email + password sign-in, already confirmed).
-- ---------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('spac3-test-pass', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('username', u.username), now(), now(),
  '', '', '', ''
from (values
  ('11111111-1111-4111-8111-111111111111'::uuid, 'alice@test.local', 'alice'),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'bob@test.local',   'bob')
) as u(id, email, username)
on conflict (id) do nothing;

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', now(), now(), now()
from auth.users u
where u.email in ('alice@test.local', 'bob@test.local')
on conflict (provider_id, provider) do nothing;

-- Profiles (the trigger above creates them; this sets the look and makes
-- the seed work even if the trigger is missing).
insert into public.profiles (id, username, avatar_emoji, avatar_color) values
  ('11111111-1111-4111-8111-111111111111', 'alice', '👩‍🚀', '#f9a8d4'),
  ('22222222-2222-4222-8222-222222222222', 'bob',   '🛸',   '#86efac')
on conflict (id) do update
  set username = excluded.username,
      avatar_emoji = excluded.avatar_emoji,
      avatar_color = excluded.avatar_color;

-- alice and bob are friends (one row per direction).
insert into public.friendships (user_id, friend_id) values
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
  ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. A room with chat history.
-- ---------------------------------------------------------------------
insert into public.spac3s (id, owner_id, name, lat, lng) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Test Room', 40.7128, -74.0060)
on conflict (id) do nothing;

-- 250 messages, one minute apart, alternating senders. More than the
-- 200 the room loads, so tests can check WHICH 200 are shown
-- (audit bug B1: the newest, "Seed message 250", must be visible).
insert into public.messages (spac3_id, user_id, body, created_at)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       case when n % 2 = 0 then '11111111-1111-4111-8111-111111111111'::uuid
            else '22222222-2222-4222-8222-222222222222'::uuid end,
       'Seed message ' || n,
       now() - make_interval(mins => 251 - n)
from generate_series(1, 250) as n
where not exists (
  select 1 from public.messages where spac3_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
