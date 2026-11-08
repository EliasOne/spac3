


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."craft_world_barriers" (
    "id" "text" NOT NULL,
    "planet_id" "text" NOT NULL,
    "col" integer NOT NULL,
    "grid_row" integer NOT NULL,
    "material" "text" NOT NULL,
    "hp" integer NOT NULL,
    "max_hp" integer NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."craft_world_barriers" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."craft_damage_barrier"("p_barrier_id" "text", "p_amount" integer) RETURNS "public"."craft_world_barriers"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  result public.craft_world_barriers;
begin
  update public.craft_world_barriers
  set hp = greatest(hp - p_amount, 0), updated_at = now()
  where id = p_barrier_id
  returning * into result;

  if result.id is not null and result.hp <= 0 then
    delete from public.craft_world_barriers where id = p_barrier_id;
  end if;

  return result;
end;
$$;


ALTER FUNCTION "public"."craft_damage_barrier"("p_barrier_id" "text", "p_amount" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."craft_world_enemies" (
    "id" "text" NOT NULL,
    "planet_id" "text" NOT NULL,
    "monster_id" "text" NOT NULL,
    "spawn_x" integer NOT NULL,
    "spawn_y" integer NOT NULL,
    "hp" integer NOT NULL,
    "max_hp" integer NOT NULL,
    "alive" boolean DEFAULT true NOT NULL,
    "respawn_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."craft_world_enemies" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."craft_damage_enemy"("p_enemy_id" "text", "p_amount" integer) RETURNS "public"."craft_world_enemies"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  result public.craft_world_enemies;
  new_hp integer;
begin
  update public.craft_world_enemies
  set
    hp = greatest(hp - p_amount, 0),
    updated_at = now()
  where id = p_enemy_id and alive = true
  returning * into result;

  if result.id is not null and result.hp <= 0 then
    update public.craft_world_enemies
    set alive = false, respawn_at = now() + make_interval(secs => 20)
    where id = p_enemy_id
    returning * into result;
  end if;

  return result;
end;
$$;


ALTER FUNCTION "public"."craft_damage_enemy"("p_enemy_id" "text", "p_amount" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."craft_place_barrier"("p_id" "text", "p_planet_id" "text", "p_col" integer, "p_row" integer, "p_material" "text", "p_hp" integer, "p_max_hp" integer, "p_created_by" "uuid") RETURNS "public"."craft_world_barriers"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  result public.craft_world_barriers;
begin
  insert into public.craft_world_barriers (id, planet_id, col, grid_row, material, hp, max_hp, created_by)
  values (p_id, p_planet_id, p_col, p_row, p_material, p_hp, p_max_hp, p_created_by)
  on conflict (id) do nothing
  returning * into result;

  return result;
end;
$$;


ALTER FUNCTION "public"."craft_place_barrier"("p_id" "text", "p_planet_id" "text", "p_col" integer, "p_row" integer, "p_material" "text", "p_hp" integer, "p_max_hp" integer, "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."craft_respawn_enemies"("p_planet_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  min_alive constant integer := 4;
  alive_count integer;
  need integer;
begin
  -- Normal timer-based respawns: anything whose 20s cooldown has
  -- elapsed comes back on schedule.
  update public.craft_world_enemies
  set hp = max_hp, alive = true, respawn_at = null, updated_at = now()
  where planet_id = p_planet_id
    and alive = false
    and respawn_at is not null
    and respawn_at <= now();

  -- Safety net: never let the planet run dry while people are actively
  -- fighting. If fewer than min_alive are left standing, immediately
  -- revive however many more are needed -- whichever died longest ago
  -- first -- instead of leaving players with almost nothing to fight
  -- until each one's individual timer comes due.
  select count(*) into alive_count
  from public.craft_world_enemies
  where planet_id = p_planet_id and alive = true;

  need := min_alive - alive_count;
  if need > 0 then
    update public.craft_world_enemies
    set hp = max_hp, alive = true, respawn_at = null, updated_at = now()
    where id in (
      select id from public.craft_world_enemies
      where planet_id = p_planet_id and alive = false
      order by respawn_at asc nulls first
      limit need
    );
  end if;
end;
$$;


ALTER FUNCTION "public"."craft_respawn_enemies"("p_planet_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_bytes_used"("p_uid" "uuid") RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
    from storage.objects o
   where o.bucket_id = 'drawings'
     and p_uid = auth.uid()
     and (storage.foldername(o.name))[1] = p_uid::text;
$$;


ALTER FUNCTION "public"."draw_bytes_used"("p_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_cleanup"() RETURNS "text"[]
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  return public.draw_unused_files(auth.uid());
end;
$$;


ALTER FUNCTION "public"."draw_cleanup"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_delete"("p_id" "uuid") RETURNS "text"[]
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  delete from public.drawings where id = p_id and owner_id = uid;
  return public.draw_unused_files(uid);
end;
$$;


ALTER FUNCTION "public"."draw_delete"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_limit"("p_key" "text") RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (select value from public.draw_limits where key = p_key),
    case p_key
      when 'max_drawings' then 100
      when 'max_bytes' then 104857600
      when 'max_versions' then 5
      when 'max_layers' then 20
      when 'max_doc_bytes' then 65536
      else 0
    end
  );
$$;


ALTER FUNCTION "public"."draw_limit"("p_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_referenced_files"("p_uid" "uuid") RETURNS TABLE("file" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select unnest(files) from public.drawings where owner_id = p_uid and p_uid = auth.uid()
  union
  select unnest(files) from public.drawing_versions where owner_id = p_uid and p_uid = auth.uid();
$$;


ALTER FUNCTION "public"."draw_referenced_files"("p_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_rename"("p_id" "uuid", "p_base_rev" integer, "p_name" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  uid uuid := auth.uid();
  clean_name text := left(btrim(coalesce(p_name, '')), 80);
  cur public.drawings;
  stamp timestamptz := now();
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  if clean_name = '' then clean_name := 'Untitled'; end if;
  select * into cur from public.drawings where id = p_id and owner_id = uid for update;
  if not found then raise exception 'Drawing not found.'; end if;
  if cur.rev <> coalesce(p_base_rev, -1) then
    raise exception 'This drawing was changed on another device.' using errcode = 'P0409';
  end if;
  update public.drawings set name = clean_name, rev = cur.rev + 1, updated_at = stamp where id = cur.id;
  return jsonb_build_object('rev', cur.rev + 1, 'updated_at', stamp);
end;
$$;


ALTER FUNCTION "public"."draw_rename"("p_id" "uuid", "p_base_rev" integer, "p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_save"("p_id" "uuid", "p_base_rev" integer, "p_name" "text", "p_doc" "jsonb", "p_files" "text"[], "p_thumb_file" "text" DEFAULT NULL::"text", "p_width" integer DEFAULT 1800, "p_height" integer DEFAULT 1200) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  uid uuid := auth.uid();
  cur public.drawings;
  new_rev integer;
  nfiles integer;
  nfound integer;
  nlayers integer;
  clean_name text := left(btrim(coalesce(p_name, '')), 80);
  v_files text[];
  stamp timestamptz := now();
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  if clean_name = '' then clean_name := 'Untitled'; end if;

  -- the document: an object with a layers list, within the size and layer limits
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' or jsonb_typeof(p_doc -> 'layers') <> 'array' then
    raise exception 'That drawing could not be read.';
  end if;
  if octet_length(p_doc::text) > public.draw_limit('max_doc_bytes') then
    raise exception 'That drawing is too complicated to save.';
  end if;
  nlayers := jsonb_array_length(p_doc -> 'layers');
  if nlayers < 1 or nlayers > public.draw_limit('max_layers') then
    raise exception 'A drawing can have 1 to % layers.', public.draw_limit('max_layers');
  end if;

  -- the picture files: well-formed names, no repeats, every layer's file listed, all uploaded
  v_files := coalesce(array(select distinct x from unnest(coalesce(p_files, '{}')) x order by x), '{}');
  nfiles := coalesce(array_length(v_files, 1), 0);
  if nfiles < 1 or nfiles > public.draw_limit('max_layers') + 1 then
    raise exception 'That drawing has the wrong number of pictures.';
  end if;
  if exists (select 1 from unnest(v_files) x where x !~ '^[0-9a-f]{64}\.(png|webp|jpg)$') then
    raise exception 'A picture name is not valid.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_doc -> 'layers') l where (l ->> 'file') is null or not ((l ->> 'file') = any (v_files))) then
    raise exception 'A layer is missing its picture.';
  end if;
  if p_thumb_file is not null and not (p_thumb_file = any (v_files)) then
    raise exception 'The preview picture is not part of the drawing.';
  end if;
  select count(*) into nfound
    from storage.objects o
   where o.bucket_id = 'drawings'
     and o.name = any (select uid::text || '/' || x from unnest(v_files) x);
  if nfound <> nfiles then
    raise exception 'A picture has not finished uploading. Try again in a moment.';
  end if;

  select * into cur from public.drawings where id = p_id for update;
  if found then
    if cur.owner_id <> uid then raise exception 'Drawing not found.'; end if;
    if cur.rev <> coalesce(p_base_rev, -1) then
      raise exception 'This drawing was changed on another device.' using errcode = 'P0409';
    end if;
    -- keep the state we are replacing as an older copy, at most one every 10 minutes, so that
    -- autosaving every few seconds does not use up the history
    if not exists (select 1 from public.drawing_versions v where v.drawing_id = cur.id and v.created_at > stamp - interval '10 minutes') then
      insert into public.drawing_versions (drawing_id, rev, owner_id, name, doc, files, thumb_file, created_at)
      values (cur.id, cur.rev, uid, cur.name, cur.doc, cur.files, cur.thumb_file, stamp)
      on conflict (drawing_id, rev) do nothing;
      delete from public.drawing_versions v
       where v.drawing_id = cur.id
         and v.rev not in (select rev from public.drawing_versions where drawing_id = cur.id order by rev desc limit public.draw_limit('max_versions'));
    end if;
    new_rev := cur.rev + 1;
    update public.drawings
       set name = clean_name, doc = p_doc, files = v_files, thumb_file = p_thumb_file, layers = nlayers,
           width = p_width, height = p_height, rev = new_rev, updated_at = stamp
     where id = cur.id;
  else
    if coalesce(p_base_rev, -1) <> 0 then raise exception 'Drawing not found.'; end if;
    if (select count(*) from public.drawings where owner_id = uid) >= public.draw_limit('max_drawings') then
      raise exception 'You have reached the limit of % saved drawings. Delete one to save another.', public.draw_limit('max_drawings');
    end if;
    new_rev := 1;
    insert into public.drawings (id, owner_id, name, doc, files, thumb_file, layers, width, height, rev, created_at, updated_at)
    values (p_id, uid, clean_name, p_doc, v_files, p_thumb_file, nlayers, p_width, p_height, new_rev, stamp, stamp);
  end if;

  return jsonb_build_object('rev', new_rev, 'updated_at', stamp, 'unused', public.draw_unused_files(uid));
end;
$_$;


ALTER FUNCTION "public"."draw_save"("p_id" "uuid", "p_base_rev" integer, "p_name" "text", "p_doc" "jsonb", "p_files" "text"[], "p_thumb_file" "text", "p_width" integer, "p_height" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_unused_files"("p_uid" "uuid") RETURNS "text"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(array_agg(f), '{}')
    from (
      select split_part(o.name, '/', 2) as f
        from storage.objects o
       where o.bucket_id = 'drawings'
         and (storage.foldername(o.name))[1] = p_uid::text
         and o.created_at < now() - interval '1 hour'
         and not exists (select 1 from public.draw_referenced_files(p_uid) r where r.file = split_part(o.name, '/', 2))
       limit 200
    ) u;
$$;


ALTER FUNCTION "public"."draw_unused_files"("p_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_usage"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  return jsonb_build_object(
    'drawings', (select count(*) from public.drawings where owner_id = uid),
    'bytes', public.draw_bytes_used(uid),
    'max_drawings', public.draw_limit('max_drawings'),
    'max_bytes', public.draw_limit('max_bytes')
  );
end;
$$;


ALTER FUNCTION "public"."draw_usage"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."globe_radio_advance"("p_from_item_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  st public.globe_radio_state;
  cur public.globe_radio_queue;
  live double precision;
  nxt uuid;
begin
  select * into st from public.globe_radio_state where id = true for update;
  if p_from_item_id is null or st.current_item_id is distinct from p_from_item_id then
    return; -- already moved on (someone else's report got here first)
  end if;

  if not public.is_app_admin() then
    select * into cur from public.globe_radio_queue where id = st.current_item_id;
    if cur.id is null or cur.duration_seconds is null or not st.is_playing then
      return;
    end if;
    live := st.position_seconds + extract(epoch from (now() - st.position_updated_at));
    if live < cur.duration_seconds - 0.75 then
      return;
    end if;
  end if;

  select q.id into nxt
  from public.globe_radio_queue q
  where q.position > (select position from public.globe_radio_queue where id = p_from_item_id)
  order by q.position
  limit 1;
  if nxt is null then
    select q.id into nxt from public.globe_radio_queue q order by q.position limit 1;
  end if;

  update public.globe_radio_state
  set current_item_id = nxt,
      is_playing = (nxt is not null),
      position_seconds = 0,
      position_updated_at = now()
  where id = true;
end;
$$;


ALTER FUNCTION "public"."globe_radio_advance"("p_from_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."globe_radio_set_mode"("p_mode" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  first_id uuid;
begin
  if not public.is_app_admin() then
    raise exception 'Only the admin can control the globe radio.' using errcode = '42501';
  end if;
  if p_mode not in ('live', 'playlist') then
    raise exception 'Mode must be live or playlist.';
  end if;
  update public.globe_radio_state set mode = p_mode where id = true;
  -- Going (back) to live with nothing selected: start the first track so
  -- the radio is never silent just because of the switch.
  if p_mode = 'live' and (select current_item_id from public.globe_radio_state where id = true) is null then
    select id into first_id from public.globe_radio_queue order by position limit 1;
    if first_id is not null then
      update public.globe_radio_state
      set current_item_id = first_id, is_playing = true, position_seconds = 0, position_updated_at = now()
      where id = true;
    end if;
  end if;
end;
$$;


ALTER FUNCTION "public"."globe_radio_set_mode"("p_mode" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."globe_radio_set_public"("p_public" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_app_admin() then
    raise exception 'Only the admin can control the globe radio.' using errcode = '42501';
  end if;
  update public.globe_radio_state set public_visible = coalesce(p_public, false) where id = true;
end;
$$;


ALTER FUNCTION "public"."globe_radio_set_public"("p_public" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."globe_radio_set_state"("p_item_id" "uuid", "p_is_playing" boolean, "p_position" double precision) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.is_app_admin() then
    raise exception 'Only the admin can control the globe radio.' using errcode = '42501';
  end if;
  if p_item_id is not null and not exists (select 1 from public.globe_radio_queue where id = p_item_id) then
    raise exception 'That track is not in the globe radio queue.';
  end if;
  update public.globe_radio_state
  set current_item_id = p_item_id,
      is_playing = coalesce(p_is_playing, false) and p_item_id is not null,
      position_seconds = greatest(0, coalesce(p_position, 0)),
      position_updated_at = now()
  where id = true;
end;
$$;


ALTER FUNCTION "public"."globe_radio_set_state"("p_item_id" "uuid", "p_is_playing" boolean, "p_position" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_app_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select auth.uid() is not null and exists (
    select 1 from public.app_admins where user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_app_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."message_reactions_fill"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  select spac3_id into new.spac3_id from public.messages where id = new.message_id;
  if new.spac3_id is null then raise exception 'No such message.'; end if;
  if (select count(*) from public.message_reactions where message_id = new.message_id and user_id = new.user_id) >= 8 then
    raise exception 'Too many reactions on one message.';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."message_reactions_fill"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."messages_stamp_visibility"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.visibility := coalesce(
    (select p.chat_visibility from public.profiles p where p.id = new.user_id),
    'everyone'
  );
  return new;
end;
$$;


ALTER FUNCTION "public"."messages_stamp_visibility"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_allowed_count"("p_user" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select 1
    + coalesce((select extra from public.spac3_grandfathered where user_id = p_user), 0)
    + coalesce((select sum(slots)::int from public.spac3_purchases
                where user_id = p_user and refunded_at is null), 0);
$$;


ALTER FUNCTION "public"."spac3_allowed_count"("p_user" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_am_i_friend_of"("p_owner_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select auth.uid() is not null and exists (
    select 1 from public.friendships
    where user_id = p_owner_id and friend_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."spac3_am_i_friend_of"("p_owner_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spac3_default_media" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "spac3_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "source_url" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_ref" "text",
    "position" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."spac3_default_media" REPLICA IDENTITY FULL;


ALTER TABLE "public"."spac3_default_media" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_default_media_add"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text" DEFAULT NULL::"text") RETURNS "public"."spac3_default_media"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  result public.spac3_default_media;
  next_position integer;
begin
  if auth.uid() is null or auth.uid() is distinct from (select owner_id from public.spac3s where id = p_spac3_id) then
    raise exception 'only the room owner can edit the creator''s picks';
  end if;

  select coalesce(max(position), 0) + 1 into next_position
  from public.spac3_default_media where spac3_id = p_spac3_id;

  insert into public.spac3_default_media
    (spac3_id, title, source_url, provider, provider_ref, position)
  values
    (p_spac3_id, p_title, p_source_url, p_provider, p_provider_ref, next_position)
  returning * into result;

  return result;
end;
$$;


ALTER FUNCTION "public"."spac3_default_media_add"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_default_media_remove"("p_item_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  row_spac3_id uuid;
begin
  select spac3_id into row_spac3_id
  from public.spac3_default_media where id = p_item_id;

  if row_spac3_id is null then
    return; -- already gone -- nothing to do
  end if;

  if auth.uid() is null or auth.uid() is distinct from (select owner_id from public.spac3s where id = row_spac3_id) then
    raise exception 'only the room owner can edit the creator''s picks';
  end if;

  delete from public.spac3_default_media where id = p_item_id;
end;
$$;


ALTER FUNCTION "public"."spac3_default_media_remove"("p_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_default_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  i integer;
begin
  if auth.uid() is null or auth.uid() is distinct from (select owner_id from public.spac3s where id = p_spac3_id) then
    raise exception 'only the room owner can edit the creator''s picks';
  end if;

  if p_ordered_ids is null or array_length(p_ordered_ids, 1) is null then
    return;
  end if;

  for i in 1 .. array_length(p_ordered_ids, 1) loop
    update public.spac3_default_media
    set position = i
    where id = p_ordered_ids[i] and spac3_id = p_spac3_id;
  end loop;
end;
$$;


ALTER FUNCTION "public"."spac3_default_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_default_media_update_title"("p_item_id" "uuid", "p_title" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  row_spac3_id uuid;
  v_title text;
begin
  v_title := trim(coalesce(p_title, ''));
  if v_title = '' then
    raise exception 'title cannot be empty';
  end if;

  select spac3_id into row_spac3_id
  from public.spac3_default_media where id = p_item_id;

  if row_spac3_id is null then
    return; -- already gone -- nothing left to relabel
  end if;

  if auth.uid() is null or auth.uid() is distinct from (select owner_id from public.spac3s where id = row_spac3_id) then
    raise exception 'only the room owner can edit the creator''s picks';
  end if;

  update public.spac3_default_media set title = left(v_title, 200) where id = p_item_id;
end;
$$;


ALTER FUNCTION "public"."spac3_default_media_update_title"("p_item_id" "uuid", "p_title" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_dm_mark_read"("p_from" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  update public.direct_messages
     set read_at = now()
   where recipient_id = auth.uid() and sender_id = p_from and read_at is null;
end;
$$;


ALTER FUNCTION "public"."spac3_dm_mark_read"("p_from" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."direct_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "recipient_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "read_at" timestamp with time zone,
    CONSTRAINT "direct_messages_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 1000))),
    CONSTRAINT "direct_messages_not_self" CHECK (("sender_id" <> "recipient_id"))
);


ALTER TABLE "public"."direct_messages" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_dm_send"("p_to" "uuid", "p_body" "text") RETURNS "public"."direct_messages"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  clean text := btrim(coalesce(p_body, ''));
  row public.direct_messages;
begin
  if me is null then
    raise exception 'Sign in first.';
  end if;
  if p_to is null or p_to = me then
    raise exception 'Pick someone else to message.';
  end if;
  if char_length(clean) < 1 then
    raise exception 'Write something first.';
  end if;
  if char_length(clean) > 1000 then
    raise exception 'That message is too long (1000 characters max).';
  end if;
  if not exists (select 1 from public.profiles where id = p_to) then
    raise exception 'That person doesn''t exist.';
  end if;
  if (select count(*) from public.direct_messages d
      where d.sender_id = me and d.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Slow down a little -- try again in a moment.';
  end if;
  insert into public.direct_messages (sender_id, recipient_id, body)
  values (me, p_to, clean)
  returning * into row;
  return row;
end;
$$;


ALTER FUNCTION "public"."spac3_dm_send"("p_to" "uuid", "p_body" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_dm_unread"() RETURNS TABLE("from_id" "uuid", "n" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select sender_id, count(*)
    from public.direct_messages
   where recipient_id = auth.uid() and read_at is null
   group by sender_id;
$$;


ALTER FUNCTION "public"."spac3_dm_unread"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_enforce_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Inserts with no signed-in user (the SQL editor, service role) are trusted.
  if auth.uid() is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('spac3_create:' || new.owner_id::text));
  if public.is_app_admin() then
    return new;
  end if;
  if (select count(*) from public.spac3s where owner_id = new.owner_id)
       >= public.spac3_allowed_count(new.owner_id) then
    raise exception 'SPAC3_LIMIT: this account has used all of its SPAC3 slots'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."spac3_enforce_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_friend_add"("p_friend_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_friend_id is null or p_friend_id = auth.uid() then
    raise exception 'You can''t add yourself as a friend.';
  end if;
  if not exists (select 1 from public.profiles where id = p_friend_id) then
    raise exception 'That user doesn''t exist.';
  end if;
  insert into public.friendships (user_id, friend_id)
  values (auth.uid(), p_friend_id)
  on conflict do nothing;
end;
$$;


ALTER FUNCTION "public"."spac3_friend_add"("p_friend_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_friend_remove"("p_friend_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  delete from public.friendships where user_id = auth.uid() and friend_id = p_friend_id;
end;
$$;


ALTER FUNCTION "public"."spac3_friend_remove"("p_friend_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_game_clear_queue"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.seat1_user_id is null and new.seat2_user_id is null then
    new.queue := '[]'::jsonb;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."spac3_game_clear_queue"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_game_next_challenger"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_replace_seat" integer, "p_board" "jsonb", "p_turn" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  g public.game_sessions%rowtype;
  e jsonb;
  rest jsonb;
begin
  select * into g from public.game_sessions where spac3_id = p_spac3_id and game_id = p_game_id for update;
  if not found or auth.uid() is null then return null; end if;
  -- caller must hold the OTHER seat (the one that stays)
  if p_replace_seat = 1 and auth.uid() is distinct from g.seat2_user_id then raise exception 'Not allowed.'; end if;
  if p_replace_seat = 2 and auth.uid() is distinct from g.seat1_user_id then raise exception 'Not allowed.'; end if;
  if p_replace_seat not in (1, 2) then raise exception 'Bad seat.'; end if;
  select x into e from jsonb_array_elements(g.queue) x where x ->> 'user_id' = p_user_id::text and x ->> 'status' = 'queued' limit 1;
  if e is null then return null; end if;
  rest := coalesce((select jsonb_agg(x) from jsonb_array_elements(g.queue) x where x ->> 'user_id' <> p_user_id::text), '[]'::jsonb);
  if p_replace_seat = 1 then
    update public.game_sessions set seat1_user_id = p_user_id, seat1_username = e ->> 'username',
      seat1_avatar_emoji = e ->> 'avatar_emoji', seat1_avatar_color = e ->> 'avatar_color',
      board = p_board, turn = p_turn, winner = null, queue = rest, updated_at = now()
      where spac3_id = p_spac3_id and game_id = p_game_id;
  else
    update public.game_sessions set seat2_user_id = p_user_id, seat2_username = e ->> 'username',
      seat2_avatar_emoji = e ->> 'avatar_emoji', seat2_avatar_color = e ->> 'avatar_color',
      board = p_board, turn = p_turn, winner = null, queue = rest, updated_at = now()
      where spac3_id = p_spac3_id and game_id = p_game_id;
  end if;
  return e;
end;
$$;


ALTER FUNCTION "public"."spac3_game_next_challenger"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_replace_seat" integer, "p_board" "jsonb", "p_turn" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_game_queue_answer"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_accept" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  g public.game_sessions%rowtype;
  e jsonb;
  out_q jsonb := '[]'::jsonb;
  acc jsonb;
begin
  select * into g from public.game_sessions where spac3_id = p_spac3_id and game_id = p_game_id for update;
  if not found or auth.uid() is null
     or (auth.uid() is distinct from g.seat1_user_id and auth.uid() is distinct from g.seat2_user_id) then
    raise exception 'Only the players can answer.';
  end if;
  for e in select * from jsonb_array_elements(g.queue) loop
    if e ->> 'user_id' = p_user_id::text and e ->> 'status' = 'pending' then
      if p_accept then
        acc := e -> 'accepted';
        if not acc @> to_jsonb(auth.uid()::text) then acc := acc || to_jsonb(auth.uid()::text); end if;
        e := jsonb_set(e, '{accepted}', acc);
        if (g.seat1_user_id is null or acc @> to_jsonb(g.seat1_user_id::text))
           and (g.seat2_user_id is null or acc @> to_jsonb(g.seat2_user_id::text)) then
          e := jsonb_set(e, '{status}', '"queued"');
        end if;
        out_q := out_q || jsonb_build_array(e);
      end if; -- rejected: dropped
    else
      out_q := out_q || jsonb_build_array(e);
    end if;
  end loop;
  update public.game_sessions set queue = out_q where spac3_id = p_spac3_id and game_id = p_game_id;
end;
$$;


ALTER FUNCTION "public"."spac3_game_queue_answer"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_accept" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_game_queue_leave"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  g public.game_sessions%rowtype;
begin
  select * into g from public.game_sessions where spac3_id = p_spac3_id and game_id = p_game_id for update;
  if not found then return; end if;
  if auth.uid() is distinct from p_user_id and auth.uid() not in (g.seat1_user_id, g.seat2_user_id) then
    raise exception 'Not allowed.';
  end if;
  update public.game_sessions
    set queue = coalesce((select jsonb_agg(e) from jsonb_array_elements(g.queue) e where e ->> 'user_id' <> p_user_id::text), '[]'::jsonb)
    where spac3_id = p_spac3_id and game_id = p_game_id;
end;
$$;


ALTER FUNCTION "public"."spac3_game_queue_leave"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_game_queue_request"("p_spac3_id" "uuid", "p_game_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  g public.game_sessions%rowtype;
  me public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select * into g from public.game_sessions where spac3_id = p_spac3_id and game_id = p_game_id for update;
  if not found or g.seat1_user_id is null then raise exception 'Nobody is playing that game.'; end if;
  if auth.uid() in (g.seat1_user_id, g.seat2_user_id) then raise exception 'You are already playing.'; end if;
  if exists (select 1 from jsonb_array_elements(g.queue) e where e ->> 'user_id' = auth.uid()::text) then return; end if;
  if jsonb_array_length(g.queue) >= 8 then raise exception 'The line is full.'; end if;
  select * into me from public.profiles where id = auth.uid();
  update public.game_sessions
    set queue = g.queue || jsonb_build_array(jsonb_build_object(
      'user_id', auth.uid(), 'username', me.username, 'avatar_emoji', me.avatar_emoji,
      'avatar_color', me.avatar_color, 'accepted', '[]'::jsonb, 'status', 'pending'))
    where spac3_id = p_spac3_id and game_id = p_game_id;
end;
$$;


ALTER FUNCTION "public"."spac3_game_queue_request"("p_spac3_id" "uuid", "p_game_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_guard_address"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if tg_op = 'INSERT' then
    new.address := null;
  elsif new.address is distinct from old.address
        and coalesce(current_setting('spac3.addr_rpc', true), '') <> '1' then
    raise exception 'Use "Show address" in this SPAC3''s Room settings to show or hide the address.';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."spac3_guard_address"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_guard_show_address"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if tg_op = 'INSERT' then
    new.show_address := false;
  elsif new.show_address is distinct from old.show_address
        and coalesce(current_setting('spac3.addr_rpc', true), '') <> '1' then
    raise exception 'Use "Show address" in a SPAC3''s Room settings to show or hide its address.';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."spac3_guard_show_address"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_hide_room_address"("p_spac3_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from public.spac3s where id = p_spac3_id and owner_id = auth.uid()) then
    raise exception 'Only the owner can do that.';
  end if;
  perform set_config('spac3.addr_rpc', '1', true);
  update public.spac3s set address = null where id = p_spac3_id;
end;
$$;


ALTER FUNCTION "public"."spac3_hide_room_address"("p_spac3_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_in_party"("p_party_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select auth.uid() is not null and exists (
    select 1 from public.travel_party_members
    where party_id = p_party_id and user_id = auth.uid() and status = 'member'
  );
$$;


ALTER FUNCTION "public"."spac3_in_party"("p_party_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_invite_to_room"("p_user_ids" "uuid"[], "p_spac3_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_title text;
  v_count integer := 0;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  select name into v_title from public.spac3s where id = p_spac3_id;
  if v_title is null then
    raise exception 'That SPAC3 doesn''t exist.';
  end if;
  delete from public.room_invites where created_at < now() - interval '1 day';
  for v_id in
    select distinct f.friend_id
    from public.friendships f
    where f.user_id = auth.uid()
      and f.friend_id = any(coalesce(p_user_ids, '{}'::uuid[]))
      and f.friend_id <> auth.uid()
  loop
    -- inviting again to the same room just refreshes the invite
    delete from public.room_invites
      where from_user_id = auth.uid() and to_user_id = v_id and spac3_id = p_spac3_id;
    insert into public.room_invites (from_user_id, to_user_id, spac3_id, spac3_title)
    values (auth.uid(), v_id, p_spac3_id, v_title);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;


ALTER FUNCTION "public"."spac3_invite_to_room"("p_user_ids" "uuid"[], "p_spac3_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_advance_to_next"("p_spac3_id" "uuid", "p_keep_playing" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  next_id uuid;
begin
  select id into next_id
  from public.spac3_media_queue
  where spac3_id = p_spac3_id and played_at is null
  order by position asc
  limit 1;

  update public.spac3s
  set media_current_item_id = next_id,
      media_is_playing = (next_id is not null and p_keep_playing),
      media_position_seconds = 0,
      media_position_updated_at = now()
  where id = p_spac3_id;
end;
$$;


ALTER FUNCTION "public"."spac3_media_advance_to_next"("p_spac3_id" "uuid", "p_keep_playing" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_check_permission"("p_owner_id" "uuid", "p_permission" "text", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select case
    when p_uid is null then false
    when p_uid = p_owner_id then true
    when p_permission = 'everyone' then true
    when p_permission = 'friends' then exists (
      select 1 from public.friendships f
      where f.user_id = p_owner_id and f.friend_id = p_uid
    )
    else false -- 'owner'
  end;
$$;


ALTER FUNCTION "public"."spac3_media_check_permission"("p_owner_id" "uuid", "p_permission" "text", "p_uid" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spac3_media_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "spac3_id" "uuid" NOT NULL,
    "added_by" "uuid",
    "title" "text" NOT NULL,
    "source_url" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_ref" "text",
    "position" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "played_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."spac3_media_queue" REPLICA IDENTITY FULL;


ALTER TABLE "public"."spac3_media_queue" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_enqueue"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text" DEFAULT NULL::"text") RETURNS "public"."spac3_media_queue"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  result public.spac3_media_queue;
  next_position integer;
  v_owner_id uuid;
  v_add_permission text;
begin
  if auth.uid() is null then
    raise exception 'must be signed in to add media';
  end if;

  select owner_id, media_add_permission into v_owner_id, v_add_permission
  from public.spac3s where id = p_spac3_id;

  if v_owner_id is null then
    raise exception 'room not found';
  end if;

  if not public.spac3_media_check_permission(v_owner_id, v_add_permission, auth.uid()) then
    raise exception 'you do not have permission to add to this room''s queue';
  end if;

  select coalesce(max(position), 0) + 1 into next_position
  from public.spac3_media_queue where spac3_id = p_spac3_id;

  insert into public.spac3_media_queue
    (spac3_id, added_by, title, source_url, provider, provider_ref, position)
  values
    (p_spac3_id, auth.uid(), p_title, p_source_url, p_provider, p_provider_ref, next_position)
  returning * into result;

  return result;
end;
$$;


ALTER FUNCTION "public"."spac3_media_enqueue"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_play"("p_spac3_id" "uuid", "p_item_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner_id uuid;
  v_play_permission text;
  old_current_id uuid;
begin
  select owner_id, media_play_permission, media_current_item_id
    into v_owner_id, v_play_permission, old_current_id
  from public.spac3s where id = p_spac3_id;
  if v_owner_id is null or not public.spac3_media_check_permission(v_owner_id, v_play_permission, auth.uid()) then
    raise exception 'you do not have permission to control playback in this room';
  end if;

  if not exists (select 1 from public.spac3_media_queue where id = p_item_id and spac3_id = p_spac3_id) then
    raise exception 'that item is not in this room''s queue';
  end if;

  if old_current_id is not null and old_current_id <> p_item_id then
    update public.spac3_media_queue set played_at = now() where id = old_current_id;
  end if;
  -- Whatever's about to become current can't itself still be marked
  -- "already played" -- keeps played_at strictly meaning "already
  -- passed over", not "has ever played before".
  update public.spac3_media_queue set played_at = null where id = p_item_id;

  update public.spac3s
  set media_current_item_id = p_item_id,
      media_is_playing = true,
      media_position_seconds = 0,
      media_position_updated_at = now()
  where id = p_spac3_id;
end;
$$;


ALTER FUNCTION "public"."spac3_media_play"("p_spac3_id" "uuid", "p_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_previous"("p_spac3_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner_id uuid;
  v_play_permission text;
  cur_id uuid;
  was_playing boolean;
  prev_id uuid;
begin
  select owner_id, media_play_permission, media_current_item_id, media_is_playing
    into v_owner_id, v_play_permission, cur_id, was_playing
  from public.spac3s where id = p_spac3_id;

  if v_owner_id is null or not public.spac3_media_check_permission(v_owner_id, v_play_permission, auth.uid()) then
    raise exception 'you do not have permission to control playback in this room';
  end if;

  select id into prev_id
  from public.spac3_media_queue
  where spac3_id = p_spac3_id and played_at is not null
  order by played_at desc
  limit 1;

  if prev_id is null then
    return; -- nothing in this room's history yet
  end if;

  if cur_id is not null then
    update public.spac3_media_queue set played_at = now() where id = cur_id;
  end if;
  update public.spac3_media_queue set played_at = null where id = prev_id;

  update public.spac3s
  set media_current_item_id = prev_id,
      media_is_playing = coalesce(was_playing, true),
      media_position_seconds = 0,
      media_position_updated_at = now()
  where id = p_spac3_id;
end;
$$;


ALTER FUNCTION "public"."spac3_media_previous"("p_spac3_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_remove"("p_item_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  row_spac3_id uuid;
  v_owner_id uuid;
  was_current boolean;
  keep_playing boolean;
begin
  select spac3_id into row_spac3_id
  from public.spac3_media_queue where id = p_item_id;

  if row_spac3_id is null then
    return; -- already gone -- nothing to do
  end if;

  select owner_id into v_owner_id from public.spac3s where id = row_spac3_id;

  if auth.uid() is null or auth.uid() is distinct from v_owner_id then
    raise exception 'only the room owner can remove media';
  end if;

  select (media_current_item_id = p_item_id), media_is_playing
    into was_current, keep_playing
  from public.spac3s where id = row_spac3_id;

  delete from public.spac3_media_queue where id = p_item_id;

  if was_current then
    perform public.spac3_media_advance_to_next(row_spac3_id, coalesce(keep_playing, false));
  end if;
end;
$$;


ALTER FUNCTION "public"."spac3_media_remove"("p_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner_id uuid;
  v_play_permission text;
  i integer;
begin
  select owner_id, media_play_permission into v_owner_id, v_play_permission from public.spac3s where id = p_spac3_id;
  if v_owner_id is null or not public.spac3_media_check_permission(v_owner_id, v_play_permission, auth.uid()) then
    raise exception 'you do not have permission to control playback in this room';
  end if;

  if p_ordered_ids is null or array_length(p_ordered_ids, 1) is null then
    return;
  end if;

  for i in 1 .. array_length(p_ordered_ids, 1) loop
    update public.spac3_media_queue
    set position = i
    where id = p_ordered_ids[i] and spac3_id = p_spac3_id;
  end loop;
end;
$$;


ALTER FUNCTION "public"."spac3_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_report_ended"("p_spac3_id" "uuid", "p_item_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  claimed integer;
begin
  -- LOOP ONE TRACK (spac3s.media_loop, see spac3_media_set_loop below): instead of moving on,
  -- the same item restarts from 0 for everyone. Several listeners usually report the same
  -- ending within a moment of each other, so a restart that already happened in the last 4
  -- seconds is not repeated.
  if exists (select 1 from public.spac3s where id = p_spac3_id and media_current_item_id = p_item_id and media_loop) then
    update public.spac3s
    set media_position_seconds = 0, media_position_updated_at = now(), media_is_playing = true
    where id = p_spac3_id and media_current_item_id = p_item_id
      and not (media_position_seconds = 0 and media_position_updated_at > now() - interval '4 seconds');
    return;
  end if;

  update public.spac3s
  set media_current_item_id = null
  where id = p_spac3_id and media_current_item_id = p_item_id;

  get diagnostics claimed = row_count;
  if claimed = 0 then
    return;
  end if;

  -- History, not deleted -- same reasoning as Skip above, so
  -- spac3_media_previous() can bring back a track that just finished
  -- naturally too, not only one that was deliberately skipped.
  update public.spac3_media_queue set played_at = now() where id = p_item_id;
  perform public.spac3_media_advance_to_next(p_spac3_id, true);
end;
$$;


ALTER FUNCTION "public"."spac3_media_report_ended"("p_spac3_id" "uuid", "p_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_seek"("p_spac3_id" "uuid", "p_position_seconds" double precision) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner_id uuid;
  v_play_permission text;
begin
  select owner_id, media_play_permission into v_owner_id, v_play_permission from public.spac3s where id = p_spac3_id;
  if v_owner_id is null or not public.spac3_media_check_permission(v_owner_id, v_play_permission, auth.uid()) then
    raise exception 'you do not have permission to control playback in this room';
  end if;

  update public.spac3s
  set media_position_seconds = greatest(0, p_position_seconds),
      media_position_updated_at = now()
  where id = p_spac3_id;
end;
$$;


ALTER FUNCTION "public"."spac3_media_seek"("p_spac3_id" "uuid", "p_position_seconds" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_set_loop"("p_spac3_id" "uuid", "p_loop" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner_id uuid;
  v_play_permission text;
begin
  select owner_id, media_play_permission into v_owner_id, v_play_permission from public.spac3s where id = p_spac3_id;
  if v_owner_id is null or not public.spac3_media_check_permission(v_owner_id, v_play_permission, auth.uid()) then
    raise exception 'you do not have permission to control playback in this room';
  end if;
  update public.spac3s set media_loop = coalesce(p_loop, false) where id = p_spac3_id;
end;
$$;


ALTER FUNCTION "public"."spac3_media_set_loop"("p_spac3_id" "uuid", "p_loop" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_skip"("p_spac3_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner_id uuid;
  v_play_permission text;
  cur_id uuid;
  was_playing boolean;
begin
  select owner_id, media_play_permission, media_current_item_id, media_is_playing
    into v_owner_id, v_play_permission, cur_id, was_playing
  from public.spac3s where id = p_spac3_id;

  if v_owner_id is null or not public.spac3_media_check_permission(v_owner_id, v_play_permission, auth.uid()) then
    raise exception 'you do not have permission to control playback in this room';
  end if;

  if cur_id is not null then
    update public.spac3_media_queue set played_at = now() where id = cur_id;
  end if;

  perform public.spac3_media_advance_to_next(p_spac3_id, coalesce(was_playing, true));
end;
$$;


ALTER FUNCTION "public"."spac3_media_skip"("p_spac3_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_toggle_play"("p_spac3_id" "uuid", "p_playing" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner_id uuid;
  v_play_permission text;
  cur_playing boolean;
  cur_position double precision;
  cur_updated_at timestamptz;
begin
  select owner_id, media_play_permission, media_is_playing, media_position_seconds, media_position_updated_at
    into v_owner_id, v_play_permission, cur_playing, cur_position, cur_updated_at
  from public.spac3s where id = p_spac3_id;

  if v_owner_id is null or not public.spac3_media_check_permission(v_owner_id, v_play_permission, auth.uid()) then
    raise exception 'you do not have permission to control playback in this room';
  end if;

  if p_playing then
    update public.spac3s
    set media_is_playing = true, media_position_updated_at = now()
    where id = p_spac3_id;
  else
    update public.spac3s
    set media_position_seconds = cur_position + case when cur_playing
          then extract(epoch from (now() - cur_updated_at)) else 0 end,
        media_is_playing = false,
        media_position_updated_at = now()
    where id = p_spac3_id;
  end if;
end;
$$;


ALTER FUNCTION "public"."spac3_media_toggle_play"("p_spac3_id" "uuid", "p_playing" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_media_update_title"("p_item_id" "uuid", "p_title" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  row_spac3_id uuid;
  v_owner_id uuid;
  v_add_permission text;
  v_title text;
begin
  if auth.uid() is null then
    raise exception 'must be signed in to edit a queue item''s title';
  end if;

  v_title := trim(coalesce(p_title, ''));
  if v_title = '' then
    raise exception 'title cannot be empty';
  end if;

  select spac3_id into row_spac3_id
  from public.spac3_media_queue where id = p_item_id;

  if row_spac3_id is null then
    return; -- item is already gone -- nothing left to relabel
  end if;

  select owner_id, media_add_permission into v_owner_id, v_add_permission
  from public.spac3s where id = row_spac3_id;

  if not public.spac3_media_check_permission(v_owner_id, v_add_permission, auth.uid()) then
    raise exception 'you do not have permission to edit this room''s queue';
  end if;

  update public.spac3_media_queue set title = left(v_title, 200) where id = p_item_id;
end;
$$;


ALTER FUNCTION "public"."spac3_media_update_title"("p_item_id" "uuid", "p_title" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_my_allowance"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  me uuid := auth.uid();
  owned integer;
  allowed integer;
  unlimited boolean;
begin
  if me is null then
    return jsonb_build_object('owned', 0, 'allowed', 0, 'unlimited', false, 'can_create', false);
  end if;
  select count(*)::int into owned from public.spac3s where owner_id = me;
  allowed := public.spac3_allowed_count(me);
  unlimited := public.is_app_admin();
  return jsonb_build_object(
    'owned', owned,
    'allowed', allowed,
    'unlimited', unlimited,
    'can_create', unlimited or owned < allowed
  );
end;
$$;


ALTER FUNCTION "public"."spac3_my_allowance"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."room_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_user_id" "uuid" NOT NULL,
    "to_user_id" "uuid" NOT NULL,
    "spac3_id" "uuid" NOT NULL,
    "spac3_title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "room_invites_not_self" CHECK (("from_user_id" <> "to_user_id"))
);


ALTER TABLE "public"."room_invites" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_my_recent_invites"("p_seconds" integer DEFAULT 600) RETURNS SETOF "public"."room_invites"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select *
  from public.room_invites
  where to_user_id = auth.uid()
    and created_at > now() - make_interval(secs => least(greatest(p_seconds, 1), 3600))
  order by created_at asc;
$$;


ALTER FUNCTION "public"."spac3_my_recent_invites"("p_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_party_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_party uuid;
  v_title text;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_dest_type not in ('globe', 'spac3') then
    raise exception 'Bad destination.';
  end if;
  select party_id into v_party from public.travel_party_members
    where user_id = auth.uid() and status = 'member';
  if v_party is null then
    return null;
  end if;
  if not exists (select 1 from public.travel_party_members where party_id = v_party and status = 'member' and user_id <> auth.uid()) then
    return null;
  end if;
  if p_dest_type = 'spac3' then
    select name into v_title from public.spac3s where id = p_dest_spac3_id;
    if v_title is null then
      raise exception 'That SPAC3 doesn''t exist.';
    end if;
  else
    p_dest_spac3_id := null;
  end if;
  delete from public.travel_party_flights where party_id = v_party and created_at < now() - interval '1 day';
  insert into public.travel_party_flights (party_id, from_user_id, dest_type, dest_spac3_id, dest_title)
  values (v_party, auth.uid(), p_dest_type, p_dest_spac3_id, v_title)
  returning id into v_id;
  return v_id;
end;
$$;


ALTER FUNCTION "public"."spac3_party_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_party_invite"("p_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_party uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_user_id is null or p_user_id = auth.uid() then
    raise exception 'You can''t invite yourself.';
  end if;
  if not exists (select 1 from public.friendships where user_id = auth.uid() and friend_id = p_user_id) then
    raise exception 'You can only invite people on your friends list.';
  end if;
  select party_id into v_party from public.travel_party_members
    where user_id = auth.uid() and status = 'member';
  if v_party is null then
    insert into public.travel_parties (created_by) values (auth.uid()) returning id into v_party;
    insert into public.travel_party_members (party_id, user_id, status, invited_by)
    values (v_party, auth.uid(), 'member', auth.uid());
  end if;
  if exists (select 1 from public.travel_party_members where party_id = v_party and user_id = p_user_id and status = 'member') then
    raise exception 'They are already in your party.';
  end if;
  insert into public.travel_party_members (party_id, user_id, status, invited_by)
  values (v_party, p_user_id, 'invited', auth.uid())
  on conflict (party_id, user_id) do update set invited_by = excluded.invited_by, created_at = now();
  return v_party;
end;
$$;


ALTER FUNCTION "public"."spac3_party_invite"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_party_inviter_location"("p_party_id" "uuid") RETURNS TABLE("dest_type" "text", "spac3_id" "uuid", "title" "text", "username" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select l.dest_type, l.spac3_id, s.name, p.username
  from public.travel_party_members me
  join public.travel_party_members m
    on m.party_id = me.party_id and m.status = 'member' and m.user_id <> me.user_id
  join public.user_locations l on l.user_id = m.user_id
  join public.profiles p on p.id = m.user_id
  left join public.spac3s s on s.id = l.spac3_id
  where me.party_id = p_party_id
    and me.user_id = auth.uid()
    and me.status = 'member'
    and l.updated_at > now() - interval '5 minutes'
  order by (m.user_id = me.invited_by) desc, l.updated_at desc
  limit 1;
$$;


ALTER FUNCTION "public"."spac3_party_inviter_location"("p_party_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_party_leave"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_party uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  select party_id into v_party from public.travel_party_members
    where user_id = auth.uid() and status = 'member';
  if v_party is null then
    return;
  end if;
  delete from public.travel_party_members where party_id = v_party and user_id = auth.uid();
  if not exists (select 1 from public.travel_party_members where party_id = v_party and status = 'member') then
    delete from public.travel_parties where id = v_party;
  end if;
end;
$$;


ALTER FUNCTION "public"."spac3_party_leave"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."travel_party_flights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "party_id" "uuid" NOT NULL,
    "from_user_id" "uuid" NOT NULL,
    "dest_type" "text" NOT NULL,
    "dest_spac3_id" "uuid",
    "dest_title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "travel_party_flights_dest_shape" CHECK (((("dest_type" = 'globe'::"text") AND ("dest_spac3_id" IS NULL)) OR (("dest_type" = 'spac3'::"text") AND ("dest_spac3_id" IS NOT NULL)))),
    CONSTRAINT "travel_party_flights_dest_type_check" CHECK (("dest_type" = ANY (ARRAY['globe'::"text", 'spac3'::"text"])))
);


ALTER TABLE "public"."travel_party_flights" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_party_recent_flights"("p_seconds" integer DEFAULT 90) RETURNS SETOF "public"."travel_party_flights"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select distinct on (party_id) *
  from public.travel_party_flights
  where created_at > now() - make_interval(secs => least(greatest(p_seconds, 1), 600))
    and from_user_id <> auth.uid()
  order by party_id, created_at desc;
$$;


ALTER FUNCTION "public"."spac3_party_recent_flights"("p_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_party_remove"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_party uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  select party_id into v_party from public.travel_party_members
    where user_id = auth.uid() and status = 'member';
  if v_party is null then
    raise exception 'You are not in a party.';
  end if;
  delete from public.travel_party_members
    where party_id = v_party and user_id = p_user_id and user_id <> auth.uid()
      and (
        (status = 'invited' and invited_by = auth.uid())
        or exists (select 1 from public.travel_parties where id = v_party and created_by = auth.uid())
      );
end;
$$;


ALTER FUNCTION "public"."spac3_party_remove"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_party_respond"("p_party_id" "uuid", "p_accept" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_accept then
    if exists (select 1 from public.travel_party_members where user_id = auth.uid() and status = 'member' and party_id <> p_party_id) then
      raise exception 'Leave your current party first.';
    end if;
    update public.travel_party_members set status = 'member'
      where party_id = p_party_id and user_id = auth.uid() and status = 'invited';
  else
    delete from public.travel_party_members
      where party_id = p_party_id and user_id = auth.uid() and status = 'invited';
  end if;
end;
$$;


ALTER FUNCTION "public"."spac3_party_respond"("p_party_id" "uuid", "p_accept" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_poster_has_friend"("p_poster_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select auth.uid() is not null and exists (
    select 1 from public.friendships
    where user_id = p_poster_id and friend_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."spac3_poster_has_friend"("p_poster_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_set_location"("p_dest_type" "text", "p_spac3_id" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    return;
  end if;
  if p_dest_type = 'spac3' and p_spac3_id is not null
     and exists (select 1 from public.spac3s where id = p_spac3_id) then
    insert into public.user_locations (user_id, dest_type, spac3_id, updated_at)
    values (auth.uid(), 'spac3', p_spac3_id, now())
    on conflict (user_id) do update
      set dest_type = 'spac3', spac3_id = p_spac3_id, updated_at = now();
  else
    insert into public.user_locations (user_id, dest_type, spac3_id, updated_at)
    values (auth.uid(), 'globe', null, now())
    on conflict (user_id) do update
      set dest_type = 'globe', spac3_id = null, updated_at = now();
  end if;
end;
$$;


ALTER FUNCTION "public"."spac3_set_location"("p_dest_type" "text", "p_spac3_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_set_private_address"("p_spac3_id" "uuid", "p_address" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_addr text := left(btrim(coalesce(p_address, '')), 300);
begin
  if not exists (select 1 from public.spac3s where id = p_spac3_id and owner_id = auth.uid()) then
    raise exception 'Only the owner can do that.';
  end if;
  if v_addr = '' then
    delete from public.spac3_private_addresses where spac3_id = p_spac3_id;
    return;
  end if;
  insert into public.spac3_private_addresses (spac3_id, address) values (p_spac3_id, v_addr)
    on conflict (spac3_id) do update set address = excluded.address;
  perform set_config('spac3.addr_rpc', '1', true);
  update public.spac3s set address = v_addr where id = p_spac3_id and address is not null;
end;
$$;


ALTER FUNCTION "public"."spac3_set_private_address"("p_spac3_id" "uuid", "p_address" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_share_room_address"("p_spac3_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_last bigint;
  v_addr text;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from public.spac3s where id = p_spac3_id and owner_id = auth.uid()) then
    raise exception 'Only the owner can do that.';
  end if;
  select max((a ->> 'timestamp')::bigint) into v_last
    from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
    where a ->> 'method' = 'password';
  if v_last is null or v_last < extract(epoch from now())::bigint - 300 then
    raise exception 'Please confirm your password first.';
  end if;
  select address into v_addr from public.spac3_private_addresses where spac3_id = p_spac3_id;
  if v_addr is null then raise exception 'This SPAC3 has no address saved.'; end if;
  perform set_config('spac3.addr_rpc', '1', true);
  update public.spac3s set address = v_addr where id = p_spac3_id;
  return v_addr;
end;
$$;


ALTER FUNCTION "public"."spac3_share_room_address"("p_spac3_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_travel_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_title text;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_dest_type not in ('globe', 'spac3') then
    raise exception 'Bad destination.';
  end if;
  if p_dest_type = 'spac3' then
    select name into v_title from public.spac3s where id = p_dest_spac3_id;
    if v_title is null then
      raise exception 'That SPAC3 doesn''t exist.';
    end if;
  else
    p_dest_spac3_id := null;
  end if;

  if not exists (
    select 1 from public.travel_followers
    where leader_id = auth.uid() and status = 'approved'
  ) then
    return null;
  end if;

  -- Housekeeping: flights are only meaningful for a minute or two.
  delete from public.travel_flights
    where leader_id = auth.uid() and created_at < now() - interval '1 day';

  insert into public.travel_flights (leader_id, dest_type, dest_spac3_id, dest_title)
  values (auth.uid(), p_dest_type, p_dest_spac3_id, v_title)
  returning id into v_id;
  return v_id;
end;
$$;


ALTER FUNCTION "public"."spac3_travel_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_travel_end"("p_leader_id" "uuid", "p_follower_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if auth.uid() <> p_leader_id and auth.uid() <> p_follower_id then
    raise exception 'Not your travel link.';
  end if;
  delete from public.travel_followers
    where leader_id = p_leader_id and follower_id = p_follower_id;
end;
$$;


ALTER FUNCTION "public"."spac3_travel_end"("p_leader_id" "uuid", "p_follower_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_travel_leader_location"("p_leader_id" "uuid") RETURNS TABLE("dest_type" "text", "spac3_id" "uuid", "title" "text", "username" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select l.dest_type, l.spac3_id, s.name, p.username
  from public.travel_followers tf
  join public.user_locations l on l.user_id = tf.leader_id
  join public.profiles p on p.id = tf.leader_id
  left join public.spac3s s on s.id = l.spac3_id
  where tf.leader_id = p_leader_id
    and tf.follower_id = auth.uid()
    and tf.status = 'approved'
    and l.updated_at > now() - interval '5 minutes'
  limit 1;
$$;


ALTER FUNCTION "public"."spac3_travel_leader_location"("p_leader_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."travel_flights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "leader_id" "uuid" NOT NULL,
    "dest_type" "text" NOT NULL,
    "dest_spac3_id" "uuid",
    "dest_title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "travel_flights_dest_shape" CHECK (((("dest_type" = 'globe'::"text") AND ("dest_spac3_id" IS NULL)) OR (("dest_type" = 'spac3'::"text") AND ("dest_spac3_id" IS NOT NULL)))),
    CONSTRAINT "travel_flights_dest_type_check" CHECK (("dest_type" = ANY (ARRAY['globe'::"text", 'spac3'::"text"])))
);


ALTER TABLE "public"."travel_flights" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_travel_recent_flights"("p_seconds" integer DEFAULT 90) RETURNS SETOF "public"."travel_flights"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select distinct on (leader_id) *
  from public.travel_flights
  where created_at > now() - make_interval(secs => least(greatest(p_seconds, 1), 600))
    and leader_id <> auth.uid()
  order by leader_id, created_at desc;
$$;


ALTER FUNCTION "public"."spac3_travel_recent_flights"("p_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_travel_request"("p_leader_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_leader_id is null or p_leader_id = auth.uid() then
    raise exception 'You can''t travel with yourself.';
  end if;
  if not exists (select 1 from public.profiles where id = p_leader_id) then
    raise exception 'That user doesn''t exist.';
  end if;
  insert into public.travel_followers (leader_id, follower_id, status)
  values (p_leader_id, auth.uid(), 'pending')
  on conflict do nothing;
  select status into v_status from public.travel_followers
    where leader_id = p_leader_id and follower_id = auth.uid();
  return v_status;
end;
$$;


ALTER FUNCTION "public"."spac3_travel_request"("p_leader_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spac3_travel_respond"("p_follower_id" "uuid", "p_approve" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_approve then
    update public.travel_followers set status = 'approved'
      where leader_id = auth.uid() and follower_id = p_follower_id;
  else
    delete from public.travel_followers
      where leader_id = auth.uid() and follower_id = p_follower_id;
  end if;
end;
$$;


ALTER FUNCTION "public"."spac3_travel_respond"("p_follower_id" "uuid", "p_approve" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sticker_add_check"("p_uid" "uuid", "p_path" "text", "p_origin" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
begin
  if p_uid is null then
    raise exception 'Sign in to keep stickers' using errcode = '28000';
  end if;
  if p_path is null or p_path !~ ('^' || p_uid::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$') then
    raise exception 'That picture is not in your sticker folder' using errcode = 'P0400';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'stickers' and o.name = p_path) then
    raise exception 'Upload the picture first' using errcode = 'P0400';
  end if;
  if (select count(*) from public.stickers s where s.user_id = p_uid and s.origin = p_origin)
       >= public.sticker_limit(case p_origin when 'made' then 'max_made' else 'max_collected' end) then
    raise exception 'Your % shelf is full', case p_origin when 'made' then 'My stickers' else 'Collected' end using errcode = 'P0402';
  end if;
  if (select count(*) from public.stickers s where s.user_id = p_uid and s.created_at > now() - interval '1 hour')
       >= public.sticker_limit('max_per_hour') then
    raise exception 'Too many new stickers this hour, try again later' using errcode = 'P0429';
  end if;
end;
$_$;


ALTER FUNCTION "public"."sticker_add_check"("p_uid" "uuid", "p_path" "text", "p_origin" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stickers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Sticker'::"text" NOT NULL,
    "path" "text" NOT NULL,
    "width" integer NOT NULL,
    "height" integer NOT NULL,
    "bytes" integer NOT NULL,
    "origin" "text" DEFAULT 'made'::"text" NOT NULL,
    "from_user" "uuid",
    "source_path" "text",
    "collectible" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stickers_bytes_check" CHECK ((("bytes" >= 1) AND ("bytes" <= 307200))),
    CONSTRAINT "stickers_height_check" CHECK ((("height" >= 1) AND ("height" <= 512))),
    CONSTRAINT "stickers_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 40))),
    CONSTRAINT "stickers_origin_check" CHECK (("origin" = ANY (ARRAY['made'::"text", 'collected'::"text"]))),
    CONSTRAINT "stickers_path_check" CHECK (("path" ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.png$'::"text")),
    CONSTRAINT "stickers_width_check" CHECK ((("width" >= 1) AND ("width" <= 512)))
);


ALTER TABLE "public"."stickers" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sticker_collect"("p_path" "text", "p_source_path" "text") RETURNS "public"."stickers"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  uid uuid := auth.uid();
  src public.stickers;
  rec public.stickers;
begin
  if uid is null then
    raise exception 'Sign in to collect stickers' using errcode = '28000';
  end if;
  select * into rec from public.stickers s where s.user_id = uid and s.source_path = p_source_path;
  if found then return rec; end if;
  select * into src from public.stickers s where s.path = p_source_path and s.origin = 'made';
  if not found then
    raise exception 'That sticker cannot be found' using errcode = 'P0404';
  end if;
  if src.user_id = uid then
    raise exception 'That is already your sticker' using errcode = 'P0400';
  end if;
  if not src.collectible then
    raise exception 'Its maker keeps this sticker for display only' using errcode = 'P0403';
  end if;
  perform public.sticker_add_check(uid, p_path, 'collected');
  insert into public.stickers (user_id, name, path, width, height, bytes, origin, from_user, source_path, collectible)
  values (uid, src.name, p_path, src.width, src.height, src.bytes, 'collected', src.user_id, p_source_path, false)
  returning * into rec;
  return rec;
end;
$$;


ALTER FUNCTION "public"."sticker_collect"("p_path" "text", "p_source_path" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sticker_delete"("p_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  gone text;
begin
  delete from public.stickers where id = p_id and user_id = auth.uid() returning path into gone;
  if gone is null then
    raise exception 'That sticker cannot be found' using errcode = 'P0404';
  end if;
  return gone;
end;
$$;


ALTER FUNCTION "public"."sticker_delete"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sticker_limit"("p_key" "text") RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (select value from public.sticker_limits where key = p_key),
    case p_key when 'max_made' then 100 when 'max_collected' then 100 when 'max_per_hour' then 30 else 0 end
  );
$$;


ALTER FUNCTION "public"."sticker_limit"("p_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sticker_rename"("p_id" "uuid", "p_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  clean_name text := left(btrim(coalesce(p_name, '')), 40);
begin
  if clean_name = '' then
    raise exception 'A sticker needs a name' using errcode = 'P0400';
  end if;
  update public.stickers set name = clean_name where id = p_id and user_id = auth.uid();
  if not found then
    raise exception 'That sticker cannot be found' using errcode = 'P0404';
  end if;
end;
$$;


ALTER FUNCTION "public"."sticker_rename"("p_id" "uuid", "p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sticker_save"("p_path" "text", "p_name" "text", "p_width" integer, "p_height" integer, "p_bytes" integer) RETURNS "public"."stickers"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  uid uuid := auth.uid();
  clean_name text := left(btrim(coalesce(p_name, '')), 40);
  rec public.stickers;
begin
  perform public.sticker_add_check(uid, p_path, 'made');
  if clean_name = '' then clean_name := 'Sticker'; end if;
  insert into public.stickers (user_id, name, path, width, height, bytes, origin, collectible)
  values (uid, clean_name, p_path, p_width, p_height, p_bytes, 'made', true)
  returning * into rec;
  return rec;
end;
$$;


ALTER FUNCTION "public"."sticker_save"("p_path" "text", "p_name" "text", "p_width" integer, "p_height" integer, "p_bytes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sticker_set_collectible"("p_id" "uuid", "p_on" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.stickers set collectible = coalesce(p_on, true)
   where id = p_id and user_id = auth.uid() and origin = 'made';
  if not found then
    raise exception 'That sticker cannot be found' using errcode = 'P0404';
  end if;
end;
$$;


ALTER FUNCTION "public"."sticker_set_collectible"("p_id" "uuid", "p_on" boolean) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_admins" (
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_admins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."craft_profiles" (
    "user_id" "uuid" NOT NULL,
    "scrap" "jsonb" DEFAULT '{"rusty_bolts": 0, "candy_shards": 0, "star_crystals": 0}'::"jsonb" NOT NULL,
    "weapons" "jsonb" DEFAULT '["zap_stick"]'::"jsonb" NOT NULL,
    "equipped" "text" DEFAULT 'zap_stick'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "armors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "equipped_armor" "text",
    "durability" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."craft_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."draw_limits" (
    "key" "text" NOT NULL,
    "value" bigint NOT NULL,
    "note" "text",
    CONSTRAINT "draw_limits_value_check" CHECK (("value" >= 0))
);


ALTER TABLE "public"."draw_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drawing_versions" (
    "drawing_id" "uuid" NOT NULL,
    "rev" integer NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "doc" "jsonb" NOT NULL,
    "files" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "thumb_file" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."drawing_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drawings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Untitled'::"text" NOT NULL,
    "doc" "jsonb" NOT NULL,
    "files" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "thumb_file" "text",
    "layers" smallint DEFAULT 1 NOT NULL,
    "width" integer DEFAULT 1800 NOT NULL,
    "height" integer DEFAULT 1200 NOT NULL,
    "rev" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "drawings_height_check" CHECK ((("height" >= 16) AND ("height" <= 8192))),
    CONSTRAINT "drawings_layers_check" CHECK ((("layers" >= 1) AND ("layers" <= 100))),
    CONSTRAINT "drawings_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 80))),
    CONSTRAINT "drawings_thumb_file_check" CHECK ((("thumb_file" IS NULL) OR ("thumb_file" ~ '^[0-9a-f]{64}\.(png|webp|jpg)$'::"text"))),
    CONSTRAINT "drawings_width_check" CHECK ((("width" >= 16) AND ("width" <= 8192)))
);


ALTER TABLE "public"."drawings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."friendships" (
    "user_id" "uuid" NOT NULL,
    "friend_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "friendships_not_self" CHECK (("user_id" <> "friend_id"))
);


ALTER TABLE "public"."friendships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_sessions" (
    "spac3_id" "uuid" NOT NULL,
    "game_id" "text" NOT NULL,
    "seat1_user_id" "uuid",
    "seat1_username" "text",
    "seat1_avatar_emoji" "text",
    "seat1_avatar_color" "text",
    "seat2_user_id" "uuid",
    "seat2_username" "text",
    "seat2_avatar_emoji" "text",
    "seat2_avatar_color" "text",
    "board" "jsonb",
    "turn" "text",
    "winner" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "queue" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "seat1_room" "uuid",
    "seat2_room" "uuid"
);


ALTER TABLE "public"."game_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."globe_radio_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "added_by" "uuid",
    "title" "text" NOT NULL,
    "source_url" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_ref" "text",
    "duration_seconds" double precision,
    "storage_path" "text",
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."globe_radio_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."globe_radio_state" (
    "id" boolean DEFAULT true NOT NULL,
    "current_item_id" "uuid",
    "is_playing" boolean DEFAULT false NOT NULL,
    "position_seconds" double precision DEFAULT 0 NOT NULL,
    "position_updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "public_visible" boolean DEFAULT false NOT NULL,
    "mode" "text" DEFAULT 'live'::"text" NOT NULL,
    CONSTRAINT "globe_radio_state_id_check" CHECK ("id"),
    CONSTRAINT "globe_radio_state_mode_check" CHECK (("mode" = ANY (ARRAY['live'::"text", 'playlist'::"text"])))
);


ALTER TABLE "public"."globe_radio_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_reactions" (
    "message_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "emoji" "text" NOT NULL,
    "spac3_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "message_reactions_emoji_check" CHECK ((("char_length"("emoji") >= 1) AND ("char_length"("emoji") <= 16)))
);


ALTER TABLE "public"."message_reactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" bigint NOT NULL,
    "spac3_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "visibility" "text" DEFAULT 'everyone'::"text" NOT NULL,
    CONSTRAINT "messages_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 500))),
    CONSTRAINT "messages_visibility_check" CHECK (("visibility" = ANY (ARRAY['everyone'::"text", 'friends'::"text"])))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


ALTER TABLE "public"."messages" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."messages_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "username" "text" NOT NULL,
    "avatar_color" "text" DEFAULT '#7dd3fc'::"text" NOT NULL,
    "avatar_emoji" "text" DEFAULT '🙂'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "avatar_url" "text",
    "chat_visibility" "text" DEFAULT 'everyone'::"text" NOT NULL,
    "show_address" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profiles_chat_visibility_check" CHECK (("chat_visibility" = ANY (ARRAY['everyone'::"text", 'friends'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spac3_favorites" (
    "user_id" "uuid" NOT NULL,
    "spac3_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."spac3_favorites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spac3_grandfathered" (
    "user_id" "uuid" NOT NULL,
    "extra" integer NOT NULL,
    CONSTRAINT "spac3_grandfathered_extra_check" CHECK (("extra" >= 0))
);


ALTER TABLE "public"."spac3_grandfathered" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spac3_paywall_state" (
    "id" boolean DEFAULT true NOT NULL,
    "launched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "spac3_paywall_state_id_check" CHECK ("id")
);


ALTER TABLE "public"."spac3_paywall_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spac3_private_addresses" (
    "spac3_id" "uuid" NOT NULL,
    "address" "text" NOT NULL
);


ALTER TABLE "public"."spac3_private_addresses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spac3_purchases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "stripe_session_id" "text" NOT NULL,
    "stripe_payment_intent" "text",
    "slots" integer DEFAULT 1 NOT NULL,
    "amount_cents" integer,
    "currency" "text",
    "refunded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "spac3_purchases_slots_check" CHECK (("slots" > 0))
);


ALTER TABLE "public"."spac3_purchases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spac3s" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'Untitled SPAC3'::"text" NOT NULL,
    "lat" double precision NOT NULL,
    "lng" double precision NOT NULL,
    "address" "text",
    "radio_url" "text",
    "price_cents" integer DEFAULT 0 NOT NULL,
    "is_paid" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "media_current_item_id" "uuid",
    "media_is_playing" boolean DEFAULT false NOT NULL,
    "media_position_seconds" double precision DEFAULT 0 NOT NULL,
    "media_position_updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "media_play_permission" "text" DEFAULT 'owner'::"text" NOT NULL,
    "media_add_permission" "text" DEFAULT 'everyone'::"text" NOT NULL,
    "room_bg_mode" "text" DEFAULT 'classic'::"text" NOT NULL,
    "room_bg_params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "room_bg_image_url" "text",
    "room_bg_image_prompt" "text",
    "banner_image_url" "text",
    "banner_mode" "text" DEFAULT 'none'::"text" NOT NULL,
    "banner_text" "text",
    "floor_params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "screen_share_permission" "text" DEFAULT 'owner'::"text" NOT NULL,
    "room_border" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "box_transparency" smallint DEFAULT 0 NOT NULL,
    "media_screen_image_url" "text",
    "media_loop" boolean DEFAULT false NOT NULL,
    "room_design" "jsonb",
    CONSTRAINT "spac3s_banner_mode_check" CHECK (("banner_mode" = ANY (ARRAY['none'::"text", 'text'::"text", 'image'::"text"]))),
    CONSTRAINT "spac3s_box_transparency_check" CHECK ((("box_transparency" >= 0) AND ("box_transparency" <= 90))),
    CONSTRAINT "spac3s_media_add_permission_check" CHECK (("media_add_permission" = ANY (ARRAY['everyone'::"text", 'friends'::"text", 'owner'::"text"]))),
    CONSTRAINT "spac3s_media_play_permission_check" CHECK (("media_play_permission" = ANY (ARRAY['everyone'::"text", 'friends'::"text", 'owner'::"text"]))),
    CONSTRAINT "spac3s_media_screen_image_url_check" CHECK ((("media_screen_image_url" IS NULL) OR ("char_length"("media_screen_image_url") <= 600))),
    CONSTRAINT "spac3s_room_bg_mode_check" CHECK (("room_bg_mode" = ANY (ARRAY['classic'::"text", 'procedural'::"text", 'ai_image'::"text"]))),
    CONSTRAINT "spac3s_room_border_size_check" CHECK (("octet_length"(("room_border")::"text") <= 60000)),
    CONSTRAINT "spac3s_room_design_size" CHECK ((("room_design" IS NULL) OR ("pg_column_size"("room_design") < 4000))),
    CONSTRAINT "spac3s_screen_share_permission_check" CHECK (("screen_share_permission" = ANY (ARRAY['everyone'::"text", 'friends'::"text", 'owner'::"text"])))
);


ALTER TABLE "public"."spac3s" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sticker_limits" (
    "key" "text" NOT NULL,
    "value" bigint NOT NULL,
    "note" "text",
    CONSTRAINT "sticker_limits_value_check" CHECK (("value" >= 0))
);


ALTER TABLE "public"."sticker_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."travel_followers" (
    "leader_id" "uuid" NOT NULL,
    "follower_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "travel_followers_not_self" CHECK (("leader_id" <> "follower_id")),
    CONSTRAINT "travel_followers_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text"])))
);


ALTER TABLE "public"."travel_followers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."travel_parties" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."travel_parties" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."travel_party_members" (
    "party_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'invited'::"text" NOT NULL,
    "invited_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "travel_party_members_status_check" CHECK (("status" = ANY (ARRAY['invited'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."travel_party_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_designs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "aspects" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_designs_data_check" CHECK (("pg_column_size"("data") < 4000)),
    CONSTRAINT "user_designs_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 40)))
);


ALTER TABLE "public"."user_designs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_locations" (
    "user_id" "uuid" NOT NULL,
    "dest_type" "text" NOT NULL,
    "spac3_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_locations_dest_type_check" CHECK (("dest_type" = ANY (ARRAY['globe'::"text", 'spac3'::"text"]))),
    CONSTRAINT "user_locations_shape" CHECK (((("dest_type" = 'globe'::"text") AND ("spac3_id" IS NULL)) OR (("dest_type" = 'spac3'::"text") AND ("spac3_id" IS NOT NULL))))
);


ALTER TABLE "public"."user_locations" OWNER TO "postgres";


ALTER TABLE ONLY "public"."app_admins"
    ADD CONSTRAINT "app_admins_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."craft_profiles"
    ADD CONSTRAINT "craft_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."craft_world_barriers"
    ADD CONSTRAINT "craft_world_barriers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."craft_world_enemies"
    ADD CONSTRAINT "craft_world_enemies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."direct_messages"
    ADD CONSTRAINT "direct_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."draw_limits"
    ADD CONSTRAINT "draw_limits_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."drawing_versions"
    ADD CONSTRAINT "drawing_versions_pkey" PRIMARY KEY ("drawing_id", "rev");



ALTER TABLE ONLY "public"."drawings"
    ADD CONSTRAINT "drawings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_pkey" PRIMARY KEY ("user_id", "friend_id");



ALTER TABLE ONLY "public"."game_sessions"
    ADD CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("spac3_id", "game_id");



ALTER TABLE ONLY "public"."globe_radio_queue"
    ADD CONSTRAINT "globe_radio_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."globe_radio_state"
    ADD CONSTRAINT "globe_radio_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("message_id", "user_id", "emoji");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");



ALTER TABLE ONLY "public"."room_invites"
    ADD CONSTRAINT "room_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spac3_default_media"
    ADD CONSTRAINT "spac3_default_media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spac3_favorites"
    ADD CONSTRAINT "spac3_favorites_pkey" PRIMARY KEY ("user_id", "spac3_id");



ALTER TABLE ONLY "public"."spac3_grandfathered"
    ADD CONSTRAINT "spac3_grandfathered_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."spac3_media_queue"
    ADD CONSTRAINT "spac3_media_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spac3_paywall_state"
    ADD CONSTRAINT "spac3_paywall_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spac3_private_addresses"
    ADD CONSTRAINT "spac3_private_addresses_pkey" PRIMARY KEY ("spac3_id");



ALTER TABLE ONLY "public"."spac3_purchases"
    ADD CONSTRAINT "spac3_purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spac3_purchases"
    ADD CONSTRAINT "spac3_purchases_stripe_session_id_key" UNIQUE ("stripe_session_id");



ALTER TABLE ONLY "public"."spac3s"
    ADD CONSTRAINT "spac3s_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sticker_limits"
    ADD CONSTRAINT "sticker_limits_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."stickers"
    ADD CONSTRAINT "stickers_path_key" UNIQUE ("path");



ALTER TABLE ONLY "public"."stickers"
    ADD CONSTRAINT "stickers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."travel_flights"
    ADD CONSTRAINT "travel_flights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."travel_followers"
    ADD CONSTRAINT "travel_followers_pkey" PRIMARY KEY ("leader_id", "follower_id");



ALTER TABLE ONLY "public"."travel_parties"
    ADD CONSTRAINT "travel_parties_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."travel_party_flights"
    ADD CONSTRAINT "travel_party_flights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."travel_party_members"
    ADD CONSTRAINT "travel_party_members_pkey" PRIMARY KEY ("party_id", "user_id");



ALTER TABLE ONLY "public"."user_designs"
    ADD CONSTRAINT "user_designs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_locations"
    ADD CONSTRAINT "user_locations_pkey" PRIMARY KEY ("user_id");



CREATE INDEX "craft_world_barriers_planet_idx" ON "public"."craft_world_barriers" USING "btree" ("planet_id");



CREATE INDEX "craft_world_enemies_planet_idx" ON "public"."craft_world_enemies" USING "btree" ("planet_id");



CREATE INDEX "direct_messages_inbox_idx" ON "public"."direct_messages" USING "btree" ("recipient_id", "sender_id", "created_at" DESC);



CREATE INDEX "direct_messages_pair_idx" ON "public"."direct_messages" USING "btree" ("sender_id", "recipient_id", "created_at" DESC);



CREATE INDEX "drawing_versions_owner_idx" ON "public"."drawing_versions" USING "btree" ("owner_id");



CREATE INDEX "drawings_owner_idx" ON "public"."drawings" USING "btree" ("owner_id", "updated_at" DESC);



CREATE INDEX "friendships_friend_idx" ON "public"."friendships" USING "btree" ("friend_id");



CREATE INDEX "globe_radio_queue_position_idx" ON "public"."globe_radio_queue" USING "btree" ("position");



CREATE INDEX "message_reactions_room_idx" ON "public"."message_reactions" USING "btree" ("spac3_id");



CREATE INDEX "messages_spac3_idx" ON "public"."messages" USING "btree" ("spac3_id", "created_at");



CREATE INDEX "room_invites_to_idx" ON "public"."room_invites" USING "btree" ("to_user_id", "created_at" DESC);



CREATE INDEX "spac3_default_media_spac3_idx" ON "public"."spac3_default_media" USING "btree" ("spac3_id", "position");



CREATE INDEX "spac3_favorites_spac3_idx" ON "public"."spac3_favorites" USING "btree" ("spac3_id");



CREATE INDEX "spac3_media_queue_history_idx" ON "public"."spac3_media_queue" USING "btree" ("spac3_id", "played_at" DESC);



CREATE INDEX "spac3_media_queue_spac3_idx" ON "public"."spac3_media_queue" USING "btree" ("spac3_id", "position");



CREATE INDEX "spac3_purchases_pi_idx" ON "public"."spac3_purchases" USING "btree" ("stripe_payment_intent");



CREATE INDEX "spac3_purchases_user_idx" ON "public"."spac3_purchases" USING "btree" ("user_id");



CREATE INDEX "spac3s_owner_idx" ON "public"."spac3s" USING "btree" ("owner_id");



CREATE UNIQUE INDEX "stickers_collect_once" ON "public"."stickers" USING "btree" ("user_id", "source_path") WHERE ("source_path" IS NOT NULL);



CREATE INDEX "stickers_user_idx" ON "public"."stickers" USING "btree" ("user_id", "origin", "created_at" DESC);



CREATE INDEX "travel_flights_leader_idx" ON "public"."travel_flights" USING "btree" ("leader_id", "created_at" DESC);



CREATE INDEX "travel_followers_follower_idx" ON "public"."travel_followers" USING "btree" ("follower_id");



CREATE INDEX "travel_party_flights_party_idx" ON "public"."travel_party_flights" USING "btree" ("party_id", "created_at" DESC);



CREATE INDEX "travel_party_members_user_idx" ON "public"."travel_party_members" USING "btree" ("user_id");



CREATE UNIQUE INDEX "travel_party_one_active" ON "public"."travel_party_members" USING "btree" ("user_id") WHERE ("status" = 'member'::"text");



CREATE INDEX "user_designs_user_idx" ON "public"."user_designs" USING "btree" ("user_id", "created_at" DESC);



CREATE OR REPLACE TRIGGER "message_reactions_fill" BEFORE INSERT ON "public"."message_reactions" FOR EACH ROW EXECUTE FUNCTION "public"."message_reactions_fill"();



CREATE OR REPLACE TRIGGER "messages_stamp_visibility" BEFORE INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."messages_stamp_visibility"();



CREATE OR REPLACE TRIGGER "spac3_enforce_limit_trg" BEFORE INSERT ON "public"."spac3s" FOR EACH ROW EXECUTE FUNCTION "public"."spac3_enforce_limit"();



CREATE OR REPLACE TRIGGER "spac3_game_clear_queue_trg" BEFORE INSERT OR UPDATE ON "public"."game_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."spac3_game_clear_queue"();



CREATE OR REPLACE TRIGGER "spac3_guard_address_trg" BEFORE INSERT OR UPDATE ON "public"."spac3s" FOR EACH ROW EXECUTE FUNCTION "public"."spac3_guard_address"();



CREATE OR REPLACE TRIGGER "spac3_guard_show_address_trg" BEFORE INSERT OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."spac3_guard_show_address"();



ALTER TABLE ONLY "public"."app_admins"
    ADD CONSTRAINT "app_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."craft_profiles"
    ADD CONSTRAINT "craft_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."craft_world_barriers"
    ADD CONSTRAINT "craft_world_barriers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."direct_messages"
    ADD CONSTRAINT "direct_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."direct_messages"
    ADD CONSTRAINT "direct_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_versions"
    ADD CONSTRAINT "drawing_versions_drawing_id_fkey" FOREIGN KEY ("drawing_id") REFERENCES "public"."drawings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawing_versions"
    ADD CONSTRAINT "drawing_versions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drawings"
    ADD CONSTRAINT "drawings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_friend_id_fkey" FOREIGN KEY ("friend_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_sessions"
    ADD CONSTRAINT "game_sessions_seat1_user_id_fkey" FOREIGN KEY ("seat1_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."game_sessions"
    ADD CONSTRAINT "game_sessions_seat2_user_id_fkey" FOREIGN KEY ("seat2_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."game_sessions"
    ADD CONSTRAINT "game_sessions_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."globe_radio_queue"
    ADD CONSTRAINT "globe_radio_queue_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."globe_radio_state"
    ADD CONSTRAINT "globe_radio_state_current_item_id_fkey" FOREIGN KEY ("current_item_id") REFERENCES "public"."globe_radio_queue"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_invites"
    ADD CONSTRAINT "room_invites_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_invites"
    ADD CONSTRAINT "room_invites_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_invites"
    ADD CONSTRAINT "room_invites_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spac3_default_media"
    ADD CONSTRAINT "spac3_default_media_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spac3_favorites"
    ADD CONSTRAINT "spac3_favorites_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spac3_favorites"
    ADD CONSTRAINT "spac3_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spac3_grandfathered"
    ADD CONSTRAINT "spac3_grandfathered_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spac3_media_queue"
    ADD CONSTRAINT "spac3_media_queue_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spac3_media_queue"
    ADD CONSTRAINT "spac3_media_queue_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spac3_private_addresses"
    ADD CONSTRAINT "spac3_private_addresses_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spac3_purchases"
    ADD CONSTRAINT "spac3_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spac3s"
    ADD CONSTRAINT "spac3s_media_current_item_id_fkey" FOREIGN KEY ("media_current_item_id") REFERENCES "public"."spac3_media_queue"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spac3s"
    ADD CONSTRAINT "spac3s_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stickers"
    ADD CONSTRAINT "stickers_from_user_fkey" FOREIGN KEY ("from_user") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stickers"
    ADD CONSTRAINT "stickers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_flights"
    ADD CONSTRAINT "travel_flights_dest_spac3_id_fkey" FOREIGN KEY ("dest_spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_flights"
    ADD CONSTRAINT "travel_flights_leader_id_fkey" FOREIGN KEY ("leader_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_followers"
    ADD CONSTRAINT "travel_followers_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_followers"
    ADD CONSTRAINT "travel_followers_leader_id_fkey" FOREIGN KEY ("leader_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_parties"
    ADD CONSTRAINT "travel_parties_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."travel_party_flights"
    ADD CONSTRAINT "travel_party_flights_dest_spac3_id_fkey" FOREIGN KEY ("dest_spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_party_flights"
    ADD CONSTRAINT "travel_party_flights_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_party_flights"
    ADD CONSTRAINT "travel_party_flights_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "public"."travel_parties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_party_members"
    ADD CONSTRAINT "travel_party_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."travel_party_members"
    ADD CONSTRAINT "travel_party_members_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "public"."travel_parties"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_party_members"
    ADD CONSTRAINT "travel_party_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_designs"
    ADD CONSTRAINT "user_designs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_locations"
    ADD CONSTRAINT "user_locations_spac3_id_fkey" FOREIGN KEY ("spac3_id") REFERENCES "public"."spac3s"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_locations"
    ADD CONSTRAINT "user_locations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



CREATE POLICY "Admin can add to the globe radio queue" ON "public"."globe_radio_queue" FOR INSERT WITH CHECK ("public"."is_app_admin"());



CREATE POLICY "Admin can edit the globe radio queue" ON "public"."globe_radio_queue" FOR UPDATE USING ("public"."is_app_admin"()) WITH CHECK ("public"."is_app_admin"());



CREATE POLICY "Admin can remove from the globe radio queue" ON "public"."globe_radio_queue" FOR DELETE USING ("public"."is_app_admin"());



CREATE POLICY "Admins can see their own admin row" ON "public"."app_admins" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Authenticated users can create game sessions" ON "public"."game_sessions" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Authenticated users can post messages" ON "public"."messages" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Authenticated users can update game sessions" ON "public"."game_sessions" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Craft profiles are viewable by everyone" ON "public"."craft_profiles" FOR SELECT USING (true);



CREATE POLICY "Craft world barriers are viewable by everyone" ON "public"."craft_world_barriers" FOR SELECT USING (true);



CREATE POLICY "Craft world enemies are viewable by everyone" ON "public"."craft_world_enemies" FOR SELECT USING (true);



CREATE POLICY "Default media items are viewable by everyone" ON "public"."spac3_default_media" FOR SELECT USING (true);



CREATE POLICY "Game sessions are viewable by everyone" ON "public"."game_sessions" FOR SELECT USING (true);



CREATE POLICY "Globe radio queue is viewable by everyone" ON "public"."globe_radio_queue" FOR SELECT USING (true);



CREATE POLICY "Globe radio state is viewable by everyone" ON "public"."globe_radio_state" FOR SELECT USING (true);



CREATE POLICY "Leader and approved followers can read flights" ON "public"."travel_flights" FOR SELECT USING ((("auth"."uid"() = "leader_id") OR (EXISTS ( SELECT 1
   FROM "public"."travel_followers" "f"
  WHERE (("f"."leader_id" = "travel_flights"."leader_id") AND ("f"."follower_id" = "auth"."uid"()) AND ("f"."status" = 'approved'::"text"))))));



CREATE POLICY "Leader and follower can read their travel link" ON "public"."travel_followers" FOR SELECT USING ((("auth"."uid"() = "leader_id") OR ("auth"."uid"() = "follower_id")));



CREATE POLICY "Media queue items are viewable by everyone" ON "public"."spac3_media_queue" FOR SELECT USING (true);



CREATE POLICY "Members read their party's flights" ON "public"."travel_party_flights" FOR SELECT USING ("public"."spac3_in_party"("party_id"));



CREATE POLICY "Members see their party and my own invites" ON "public"."travel_party_members" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."spac3_in_party"("party_id")));



CREATE POLICY "Messages are viewable by their audience" ON "public"."messages" FOR SELECT USING ((("visibility" = 'everyone'::"text") OR ("auth"."uid"() = "user_id") OR "public"."spac3_poster_has_friend"("user_id")));



CREATE POLICY "Only the room owner can remove queue items" ON "public"."spac3_media_queue" FOR DELETE USING (("auth"."uid"() = ( SELECT "spac3s"."owner_id"
   FROM "public"."spac3s"
  WHERE ("spac3s"."id" = "spac3_media_queue"."spac3_id"))));



CREATE POLICY "Owners can delete their own spac3" ON "public"."spac3s" FOR DELETE USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "Owners can read their private address" ON "public"."spac3_private_addresses" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."spac3s" "s"
  WHERE (("s"."id" = "spac3_private_addresses"."spac3_id") AND ("s"."owner_id" = "auth"."uid"())))));



CREATE POLICY "Owners can update their own spac3" ON "public"."spac3s" FOR UPDATE USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "People can read their own drawing versions" ON "public"."drawing_versions" FOR SELECT TO "authenticated" USING (("owner_id" = "auth"."uid"()));



CREATE POLICY "People can read their own drawings" ON "public"."drawings" FOR SELECT TO "authenticated" USING (("owner_id" = "auth"."uid"()));



CREATE POLICY "People delete their own designs" ON "public"."user_designs" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "People react as themselves" ON "public"."message_reactions" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."messages" "m"
  WHERE ("m"."id" = "message_reactions"."message_id")))));



CREATE POLICY "People read their own designs" ON "public"."user_designs" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "People read their own private messages" ON "public"."direct_messages" FOR SELECT USING ((("auth"."uid"() = "sender_id") OR ("auth"."uid"() = "recipient_id")));



CREATE POLICY "People read their own stickers" ON "public"."stickers" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "People remove their own reactions" ON "public"."message_reactions" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "People rename their own designs" ON "public"."user_designs" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "People save their own designs" ON "public"."user_designs" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") AND (( SELECT "count"(*) AS "count"
   FROM "public"."user_designs" "d"
  WHERE ("d"."user_id" = "auth"."uid"())) < 100)));



CREATE POLICY "Profiles are viewable by everyone" ON "public"."profiles" FOR SELECT USING (true);



CREATE POLICY "Reactions are viewable with their message" ON "public"."message_reactions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."messages" "m"
  WHERE ("m"."id" = "message_reactions"."message_id"))));



CREATE POLICY "Sender and receiver can read an invite" ON "public"."room_invites" FOR SELECT USING ((("auth"."uid"() = "from_user_id") OR ("auth"."uid"() = "to_user_id")));



CREATE POLICY "Senders, room owners and admins can delete messages" ON "public"."messages" FOR DELETE USING ((("auth"."uid"() = "user_id") OR (EXISTS ( SELECT 1
   FROM "public"."spac3s" "s"
  WHERE (("s"."id" = "messages"."spac3_id") AND ("s"."owner_id" = "auth"."uid"())))) OR "public"."is_app_admin"()));



CREATE POLICY "Signed-in people can read the draw limits" ON "public"."draw_limits" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Signed-in people can read the sticker limits" ON "public"."sticker_limits" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Signed-in users can add to a media queue" ON "public"."spac3_media_queue" FOR INSERT WITH CHECK ((("auth"."uid"() IS NOT NULL) AND ("auth"."uid"() = "added_by")));



CREATE POLICY "Signed-in users can update craft world enemies" ON "public"."craft_world_enemies" FOR UPDATE USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Signed-in users can write craft world barriers" ON "public"."craft_world_barriers" USING (("auth"."uid"() IS NOT NULL)) WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Spac3s are viewable by everyone" ON "public"."spac3s" FOR SELECT USING (true);



CREATE POLICY "Users can create their own craft profile" ON "public"."craft_profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can create their own spac3" ON "public"."spac3s" FOR INSERT WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "Users can favorite a spac3 as themselves" ON "public"."spac3_favorites" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can read their own favorite spac3s" ON "public"."spac3_favorites" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can read their own friends list" ON "public"."friendships" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can remove their own favorite spac3s" ON "public"."spac3_favorites" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can see their own grandfathered slots" ON "public"."spac3_grandfathered" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can see their own purchases" ON "public"."spac3_purchases" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own craft profile" ON "public"."craft_profiles" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."app_admins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."craft_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."craft_world_barriers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."craft_world_enemies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."direct_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."draw_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."drawing_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."drawings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."friendships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."globe_radio_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."globe_radio_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_reactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."room_invites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spac3_default_media" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spac3_favorites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spac3_grandfathered" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spac3_media_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spac3_paywall_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spac3_private_addresses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spac3_purchases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."spac3s" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sticker_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stickers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."travel_flights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."travel_followers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."travel_parties" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."travel_party_flights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."travel_party_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_designs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_locations" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."craft_world_barriers";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."craft_world_enemies";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."direct_messages";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."game_sessions";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."globe_radio_queue";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."globe_radio_state";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."message_reactions";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."messages";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."room_invites";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."spac3_default_media";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."spac3_media_queue";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."spac3s";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."travel_flights";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."travel_followers";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."travel_party_flights";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."travel_party_members";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON TABLE "public"."craft_world_barriers" TO "anon";
GRANT ALL ON TABLE "public"."craft_world_barriers" TO "authenticated";
GRANT ALL ON TABLE "public"."craft_world_barriers" TO "service_role";



GRANT ALL ON FUNCTION "public"."craft_damage_barrier"("p_barrier_id" "text", "p_amount" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."craft_damage_barrier"("p_barrier_id" "text", "p_amount" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."craft_damage_barrier"("p_barrier_id" "text", "p_amount" integer) TO "service_role";



GRANT ALL ON TABLE "public"."craft_world_enemies" TO "anon";
GRANT ALL ON TABLE "public"."craft_world_enemies" TO "authenticated";
GRANT ALL ON TABLE "public"."craft_world_enemies" TO "service_role";



GRANT ALL ON FUNCTION "public"."craft_damage_enemy"("p_enemy_id" "text", "p_amount" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."craft_damage_enemy"("p_enemy_id" "text", "p_amount" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."craft_damage_enemy"("p_enemy_id" "text", "p_amount" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."craft_place_barrier"("p_id" "text", "p_planet_id" "text", "p_col" integer, "p_row" integer, "p_material" "text", "p_hp" integer, "p_max_hp" integer, "p_created_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."craft_place_barrier"("p_id" "text", "p_planet_id" "text", "p_col" integer, "p_row" integer, "p_material" "text", "p_hp" integer, "p_max_hp" integer, "p_created_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."craft_place_barrier"("p_id" "text", "p_planet_id" "text", "p_col" integer, "p_row" integer, "p_material" "text", "p_hp" integer, "p_max_hp" integer, "p_created_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."craft_respawn_enemies"("p_planet_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."craft_respawn_enemies"("p_planet_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."craft_respawn_enemies"("p_planet_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."draw_bytes_used"("p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."draw_bytes_used"("p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_bytes_used"("p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."draw_cleanup"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."draw_cleanup"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_cleanup"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."draw_delete"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."draw_delete"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_delete"("p_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."draw_limit"("p_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."draw_limit"("p_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_limit"("p_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."draw_referenced_files"("p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."draw_referenced_files"("p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_referenced_files"("p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."draw_rename"("p_id" "uuid", "p_base_rev" integer, "p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."draw_rename"("p_id" "uuid", "p_base_rev" integer, "p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_rename"("p_id" "uuid", "p_base_rev" integer, "p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."draw_save"("p_id" "uuid", "p_base_rev" integer, "p_name" "text", "p_doc" "jsonb", "p_files" "text"[], "p_thumb_file" "text", "p_width" integer, "p_height" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."draw_save"("p_id" "uuid", "p_base_rev" integer, "p_name" "text", "p_doc" "jsonb", "p_files" "text"[], "p_thumb_file" "text", "p_width" integer, "p_height" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_save"("p_id" "uuid", "p_base_rev" integer, "p_name" "text", "p_doc" "jsonb", "p_files" "text"[], "p_thumb_file" "text", "p_width" integer, "p_height" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."draw_unused_files"("p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."draw_unused_files"("p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."draw_usage"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."draw_usage"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_usage"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."globe_radio_advance"("p_from_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."globe_radio_advance"("p_from_item_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."globe_radio_advance"("p_from_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."globe_radio_advance"("p_from_item_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."globe_radio_set_mode"("p_mode" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."globe_radio_set_mode"("p_mode" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."globe_radio_set_mode"("p_mode" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."globe_radio_set_mode"("p_mode" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."globe_radio_set_public"("p_public" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."globe_radio_set_public"("p_public" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."globe_radio_set_public"("p_public" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."globe_radio_set_public"("p_public" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."globe_radio_set_state"("p_item_id" "uuid", "p_is_playing" boolean, "p_position" double precision) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."globe_radio_set_state"("p_item_id" "uuid", "p_is_playing" boolean, "p_position" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."globe_radio_set_state"("p_item_id" "uuid", "p_is_playing" boolean, "p_position" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."globe_radio_set_state"("p_item_id" "uuid", "p_is_playing" boolean, "p_position" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_app_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_app_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_app_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."message_reactions_fill"() TO "anon";
GRANT ALL ON FUNCTION "public"."message_reactions_fill"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."message_reactions_fill"() TO "service_role";



GRANT ALL ON FUNCTION "public"."messages_stamp_visibility"() TO "anon";
GRANT ALL ON FUNCTION "public"."messages_stamp_visibility"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."messages_stamp_visibility"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spac3_allowed_count"("p_user" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spac3_allowed_count"("p_user" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_allowed_count"("p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_allowed_count"("p_user" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_am_i_friend_of"("p_owner_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_am_i_friend_of"("p_owner_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_am_i_friend_of"("p_owner_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."spac3_default_media" TO "anon";
GRANT ALL ON TABLE "public"."spac3_default_media" TO "authenticated";
GRANT ALL ON TABLE "public"."spac3_default_media" TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_default_media_add"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_default_media_add"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_default_media_add"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_default_media_remove"("p_item_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_default_media_remove"("p_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_default_media_remove"("p_item_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_default_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_default_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_default_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_default_media_update_title"("p_item_id" "uuid", "p_title" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_default_media_update_title"("p_item_id" "uuid", "p_title" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_default_media_update_title"("p_item_id" "uuid", "p_title" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_dm_mark_read"("p_from" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_dm_mark_read"("p_from" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_dm_mark_read"("p_from" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."direct_messages" TO "anon";
GRANT ALL ON TABLE "public"."direct_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."direct_messages" TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_dm_send"("p_to" "uuid", "p_body" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_dm_send"("p_to" "uuid", "p_body" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_dm_send"("p_to" "uuid", "p_body" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_dm_unread"() TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_dm_unread"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_dm_unread"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_enforce_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_enforce_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_enforce_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_friend_add"("p_friend_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_friend_add"("p_friend_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_friend_add"("p_friend_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_friend_remove"("p_friend_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_friend_remove"("p_friend_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_friend_remove"("p_friend_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_game_clear_queue"() TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_game_clear_queue"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_game_clear_queue"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_game_next_challenger"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_replace_seat" integer, "p_board" "jsonb", "p_turn" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_game_next_challenger"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_replace_seat" integer, "p_board" "jsonb", "p_turn" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_game_next_challenger"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_replace_seat" integer, "p_board" "jsonb", "p_turn" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_game_queue_answer"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_accept" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_game_queue_answer"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_accept" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_game_queue_answer"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid", "p_accept" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_game_queue_leave"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_game_queue_leave"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_game_queue_leave"("p_spac3_id" "uuid", "p_game_id" "text", "p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_game_queue_request"("p_spac3_id" "uuid", "p_game_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_game_queue_request"("p_spac3_id" "uuid", "p_game_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_game_queue_request"("p_spac3_id" "uuid", "p_game_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_guard_address"() TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_guard_address"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_guard_address"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_guard_show_address"() TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_guard_show_address"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_guard_show_address"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_hide_room_address"("p_spac3_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_hide_room_address"("p_spac3_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_hide_room_address"("p_spac3_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_in_party"("p_party_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_in_party"("p_party_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_in_party"("p_party_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_invite_to_room"("p_user_ids" "uuid"[], "p_spac3_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_invite_to_room"("p_user_ids" "uuid"[], "p_spac3_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_invite_to_room"("p_user_ids" "uuid"[], "p_spac3_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_advance_to_next"("p_spac3_id" "uuid", "p_keep_playing" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_advance_to_next"("p_spac3_id" "uuid", "p_keep_playing" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_advance_to_next"("p_spac3_id" "uuid", "p_keep_playing" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_check_permission"("p_owner_id" "uuid", "p_permission" "text", "p_uid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_check_permission"("p_owner_id" "uuid", "p_permission" "text", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_check_permission"("p_owner_id" "uuid", "p_permission" "text", "p_uid" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."spac3_media_queue" TO "anon";
GRANT ALL ON TABLE "public"."spac3_media_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."spac3_media_queue" TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_enqueue"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_enqueue"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_enqueue"("p_spac3_id" "uuid", "p_title" "text", "p_source_url" "text", "p_provider" "text", "p_provider_ref" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_play"("p_spac3_id" "uuid", "p_item_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_play"("p_spac3_id" "uuid", "p_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_play"("p_spac3_id" "uuid", "p_item_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_previous"("p_spac3_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_previous"("p_spac3_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_previous"("p_spac3_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_remove"("p_item_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_remove"("p_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_remove"("p_item_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_reorder"("p_spac3_id" "uuid", "p_ordered_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_report_ended"("p_spac3_id" "uuid", "p_item_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_report_ended"("p_spac3_id" "uuid", "p_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_report_ended"("p_spac3_id" "uuid", "p_item_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_seek"("p_spac3_id" "uuid", "p_position_seconds" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_seek"("p_spac3_id" "uuid", "p_position_seconds" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_seek"("p_spac3_id" "uuid", "p_position_seconds" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_set_loop"("p_spac3_id" "uuid", "p_loop" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_set_loop"("p_spac3_id" "uuid", "p_loop" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_set_loop"("p_spac3_id" "uuid", "p_loop" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_skip"("p_spac3_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_skip"("p_spac3_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_skip"("p_spac3_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_toggle_play"("p_spac3_id" "uuid", "p_playing" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_toggle_play"("p_spac3_id" "uuid", "p_playing" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_toggle_play"("p_spac3_id" "uuid", "p_playing" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_media_update_title"("p_item_id" "uuid", "p_title" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_media_update_title"("p_item_id" "uuid", "p_title" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_media_update_title"("p_item_id" "uuid", "p_title" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spac3_my_allowance"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spac3_my_allowance"() TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_my_allowance"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_my_allowance"() TO "service_role";



GRANT ALL ON TABLE "public"."room_invites" TO "anon";
GRANT ALL ON TABLE "public"."room_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."room_invites" TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_my_recent_invites"("p_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_my_recent_invites"("p_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_my_recent_invites"("p_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_party_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_party_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_party_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_party_invite"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_party_invite"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_party_invite"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_party_inviter_location"("p_party_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_party_inviter_location"("p_party_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_party_inviter_location"("p_party_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_party_leave"() TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_party_leave"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_party_leave"() TO "service_role";



GRANT ALL ON TABLE "public"."travel_party_flights" TO "anon";
GRANT ALL ON TABLE "public"."travel_party_flights" TO "authenticated";
GRANT ALL ON TABLE "public"."travel_party_flights" TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_party_recent_flights"("p_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_party_recent_flights"("p_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_party_recent_flights"("p_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_party_remove"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_party_remove"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_party_remove"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_party_respond"("p_party_id" "uuid", "p_accept" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_party_respond"("p_party_id" "uuid", "p_accept" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_party_respond"("p_party_id" "uuid", "p_accept" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_poster_has_friend"("p_poster_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_poster_has_friend"("p_poster_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_poster_has_friend"("p_poster_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_set_location"("p_dest_type" "text", "p_spac3_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_set_location"("p_dest_type" "text", "p_spac3_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_set_location"("p_dest_type" "text", "p_spac3_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_set_private_address"("p_spac3_id" "uuid", "p_address" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_set_private_address"("p_spac3_id" "uuid", "p_address" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_set_private_address"("p_spac3_id" "uuid", "p_address" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_share_room_address"("p_spac3_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_share_room_address"("p_spac3_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_share_room_address"("p_spac3_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_travel_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_travel_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_travel_announce"("p_dest_type" "text", "p_dest_spac3_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_travel_end"("p_leader_id" "uuid", "p_follower_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_travel_end"("p_leader_id" "uuid", "p_follower_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_travel_end"("p_leader_id" "uuid", "p_follower_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_travel_leader_location"("p_leader_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_travel_leader_location"("p_leader_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_travel_leader_location"("p_leader_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."travel_flights" TO "anon";
GRANT ALL ON TABLE "public"."travel_flights" TO "authenticated";
GRANT ALL ON TABLE "public"."travel_flights" TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_travel_recent_flights"("p_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_travel_recent_flights"("p_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_travel_recent_flights"("p_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_travel_request"("p_leader_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_travel_request"("p_leader_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_travel_request"("p_leader_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spac3_travel_respond"("p_follower_id" "uuid", "p_approve" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."spac3_travel_respond"("p_follower_id" "uuid", "p_approve" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spac3_travel_respond"("p_follower_id" "uuid", "p_approve" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."sticker_add_check"("p_uid" "uuid", "p_path" "text", "p_origin" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sticker_add_check"("p_uid" "uuid", "p_path" "text", "p_origin" "text") TO "service_role";



GRANT ALL ON TABLE "public"."stickers" TO "anon";
GRANT ALL ON TABLE "public"."stickers" TO "authenticated";
GRANT ALL ON TABLE "public"."stickers" TO "service_role";



REVOKE ALL ON FUNCTION "public"."sticker_collect"("p_path" "text", "p_source_path" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sticker_collect"("p_path" "text", "p_source_path" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sticker_collect"("p_path" "text", "p_source_path" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sticker_delete"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sticker_delete"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sticker_delete"("p_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sticker_limit"("p_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sticker_limit"("p_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sticker_limit"("p_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sticker_rename"("p_id" "uuid", "p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sticker_rename"("p_id" "uuid", "p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sticker_rename"("p_id" "uuid", "p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sticker_save"("p_path" "text", "p_name" "text", "p_width" integer, "p_height" integer, "p_bytes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sticker_save"("p_path" "text", "p_name" "text", "p_width" integer, "p_height" integer, "p_bytes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sticker_save"("p_path" "text", "p_name" "text", "p_width" integer, "p_height" integer, "p_bytes" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."sticker_set_collectible"("p_id" "uuid", "p_on" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sticker_set_collectible"("p_id" "uuid", "p_on" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sticker_set_collectible"("p_id" "uuid", "p_on" boolean) TO "service_role";


















GRANT ALL ON TABLE "public"."app_admins" TO "anon";
GRANT ALL ON TABLE "public"."app_admins" TO "authenticated";
GRANT ALL ON TABLE "public"."app_admins" TO "service_role";



GRANT ALL ON TABLE "public"."craft_profiles" TO "anon";
GRANT ALL ON TABLE "public"."craft_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."craft_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."draw_limits" TO "anon";
GRANT ALL ON TABLE "public"."draw_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."draw_limits" TO "service_role";



GRANT ALL ON TABLE "public"."drawing_versions" TO "anon";
GRANT ALL ON TABLE "public"."drawing_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."drawing_versions" TO "service_role";



GRANT ALL ON TABLE "public"."drawings" TO "anon";
GRANT ALL ON TABLE "public"."drawings" TO "authenticated";
GRANT ALL ON TABLE "public"."drawings" TO "service_role";



GRANT ALL ON TABLE "public"."friendships" TO "anon";
GRANT ALL ON TABLE "public"."friendships" TO "authenticated";
GRANT ALL ON TABLE "public"."friendships" TO "service_role";



GRANT ALL ON TABLE "public"."game_sessions" TO "anon";
GRANT ALL ON TABLE "public"."game_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."game_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."globe_radio_queue" TO "anon";
GRANT ALL ON TABLE "public"."globe_radio_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."globe_radio_queue" TO "service_role";



GRANT ALL ON TABLE "public"."globe_radio_state" TO "anon";
GRANT ALL ON TABLE "public"."globe_radio_state" TO "authenticated";
GRANT ALL ON TABLE "public"."globe_radio_state" TO "service_role";



GRANT ALL ON TABLE "public"."message_reactions" TO "anon";
GRANT ALL ON TABLE "public"."message_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."message_reactions" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON SEQUENCE "public"."messages_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."messages_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."messages_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."spac3_favorites" TO "anon";
GRANT ALL ON TABLE "public"."spac3_favorites" TO "authenticated";
GRANT ALL ON TABLE "public"."spac3_favorites" TO "service_role";



GRANT ALL ON TABLE "public"."spac3_grandfathered" TO "anon";
GRANT ALL ON TABLE "public"."spac3_grandfathered" TO "authenticated";
GRANT ALL ON TABLE "public"."spac3_grandfathered" TO "service_role";



GRANT ALL ON TABLE "public"."spac3_paywall_state" TO "anon";
GRANT ALL ON TABLE "public"."spac3_paywall_state" TO "authenticated";
GRANT ALL ON TABLE "public"."spac3_paywall_state" TO "service_role";



GRANT ALL ON TABLE "public"."spac3_private_addresses" TO "anon";
GRANT ALL ON TABLE "public"."spac3_private_addresses" TO "authenticated";
GRANT ALL ON TABLE "public"."spac3_private_addresses" TO "service_role";



GRANT ALL ON TABLE "public"."spac3_purchases" TO "anon";
GRANT ALL ON TABLE "public"."spac3_purchases" TO "authenticated";
GRANT ALL ON TABLE "public"."spac3_purchases" TO "service_role";



GRANT ALL ON TABLE "public"."spac3s" TO "anon";
GRANT ALL ON TABLE "public"."spac3s" TO "authenticated";
GRANT ALL ON TABLE "public"."spac3s" TO "service_role";



GRANT ALL ON TABLE "public"."sticker_limits" TO "anon";
GRANT ALL ON TABLE "public"."sticker_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."sticker_limits" TO "service_role";



GRANT ALL ON TABLE "public"."travel_followers" TO "anon";
GRANT ALL ON TABLE "public"."travel_followers" TO "authenticated";
GRANT ALL ON TABLE "public"."travel_followers" TO "service_role";



GRANT ALL ON TABLE "public"."travel_parties" TO "anon";
GRANT ALL ON TABLE "public"."travel_parties" TO "authenticated";
GRANT ALL ON TABLE "public"."travel_parties" TO "service_role";



GRANT ALL ON TABLE "public"."travel_party_members" TO "anon";
GRANT ALL ON TABLE "public"."travel_party_members" TO "authenticated";
GRANT ALL ON TABLE "public"."travel_party_members" TO "service_role";



GRANT ALL ON TABLE "public"."user_designs" TO "anon";
GRANT ALL ON TABLE "public"."user_designs" TO "authenticated";
GRANT ALL ON TABLE "public"."user_designs" TO "service_role";



GRANT ALL ON TABLE "public"."user_locations" TO "anon";
GRANT ALL ON TABLE "public"."user_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."user_locations" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































