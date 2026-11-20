-- ============================================================
-- 追加SQL_21:申し込みのワンタイムリンク(1回だけ使えるURL)と、MapOn Light(無料プラン)
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。
-- このSQLを実行しただけでは、いまの店舗のデータは変更・削除しません(いまの店舗は、すべて「有料」のままです)。
--
-- 実行の順番:追加SQL_19 → 追加SQL_20 → このSQL → MEO_UPLOAD のファイルをアップロード
--
-- 内容:
--  1. ワンタイムリンク
--     ・MSMスタッフが、マスター画面で「1回だけ使える申し込みURL」を発行する(宛先のメモ・有効期限は任意。期限なしも可)。
--     ・有料の申し込み(signup-neo)は、このリンクがないと、アカウントが作られない。
--       確かめるのは、申し込みの処理(handle_mapon_signup)の中。リンクが使えないときはエラーにするので、
--       ログイン用のアカウントも作られない(同じ処理の中のため、途中まで作られることはない)。
--     ・申し込みが完了した時点で「使用済み」。ページを開いただけでは、使用済みにならない。
--       2人が同時に同じリンクで申し込んでも、成功するのは1人だけ。
--     ・お客様の画面に返すのは「使える/使用済み/期限切れ/取り消し済み/存在しない」の状態だけ(メモなどは返さない)。
--  2. MapOn Light(店舗のプラン)
--     ・店舗(clients)に「プラン」の列(tier)を足す。standard=有料、light=無料。いまの店舗は、すべて standard。
--     ・Light の制限は、データベースで断る(画面を書き換えても超えられない):
--         AIの文章は月50回/アンケートは1つまで/クーポンは1つまで/会員証・ショップカードは使えない
--     ・プランを変えられるのは、この関数だけ(neo_admin_set_tier)。
--         有料にする:MSMスタッフ。
--         Lightにする:MSMの管理者だけ。店舗名(未入力ならメールアドレス)の入力が必要。
--           会員・ショップカードは全部、クーポンとアンケートは最初に作った1つ以外を削除する(元に戻せない)。
--           誰が・いつ・何を消したかを、記録に残す(neo_tier_changes)。
--  3. Light の申し込み(signup-light)
--     ・「Lightの受付」のスイッチ(neo_settings の light_signup_open)が開いているときだけ、アカウントが作られる。
--       初めは閉じている。ボット判定ができてから開く。
--  4. お迎えメール:Light の店舗かどうかを返す(メールに、Light の案内を1文足すため)
-- ============================================================

-- ------------------------------------------------------------
-- 1. ワンタイムリンク
-- ------------------------------------------------------------
create table if not exists public.neo_invites (
    id              uuid primary key default gen_random_uuid(),
    token           text not null unique,
    memo            text,
    expires_at      timestamptz,
    created_by      uuid,
    created_at      timestamptz not null default now(),
    used_at         timestamptz,
    used_by         uuid,
    used_client_id  text,
    used_store      text,
    used_email      text,
    revoked_at      timestamptz,
    revoked_by      uuid
);
alter table public.neo_invites enable row level security;
revoke all on table public.neo_invites from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.neo_invites from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.neo_invites from authenticated'; end if;
end $$;

-- リンクの状態(使える/使用済み/取り消し済み/期限切れ)
create or replace function public.neo_invite_state(p_used_at timestamptz, p_revoked_at timestamptz, p_expires_at timestamptz)
returns text language sql stable set search_path = public as $$
  select case when p_used_at is not null then 'used'
              when p_revoked_at is not null then 'revoked'
              when p_expires_at is not null and p_expires_at <= now() then 'expired'
              else 'ok' end;
$$;

-- 発行(MSMスタッフ)。有効期限は、日数(1〜365日)か、日付(その日の終わりまで。日本時間)。どちらもなければ期限なし。
create or replace function public.neo_invite_issue(p_memo text default null, p_days integer default null, p_until date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_expires timestamptz;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_row public.neo_invites%rowtype;
begin
  if not public.is_msm_staff() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if v_memo is not null and char_length(v_memo) > 100 then raise exception 'memo_too_long' using errcode = 'P0001'; end if;
  if p_days is not null and p_until is not null then raise exception 'bad_expiry' using errcode = 'P0001'; end if;
  if p_days is not null then
    if p_days < 1 or p_days > 365 then raise exception 'bad_expiry' using errcode = 'P0001'; end if;
    v_expires := now() + make_interval(days => p_days);
  elsif p_until is not null then
    if p_until < v_today or p_until > v_today + 366 then raise exception 'bad_expiry' using errcode = 'P0001'; end if;
    v_expires := ((p_until + 1)::timestamp at time zone 'Asia/Tokyo');
  end if;
  insert into public.neo_invites (token, memo, expires_at, created_by)
  values (public.neo_random_hex(), v_memo, v_expires, auth.uid())
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'token', v_row.token, 'memo', v_row.memo, 'expires_at', v_row.expires_at, 'created_at', v_row.created_at);
end;
$$;

-- 一覧(MSMスタッフ)。新しい順に200件まで。
create or replace function public.neo_invite_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_msm_staff() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', i.id, 'token', case when public.neo_invite_state(i.used_at, i.revoked_at, i.expires_at) = 'ok' then i.token end,
             'memo', i.memo, 'expires_at', i.expires_at, 'created_at', i.created_at,
             'state', public.neo_invite_state(i.used_at, i.revoked_at, i.expires_at),
             'used_at', i.used_at, 'used_store', i.used_store, 'used_email', i.used_email, 'used_client_id', i.used_client_id,
             'revoked_at', i.revoked_at) order by i.created_at desc, i.id)
      from (select * from public.neo_invites order by created_at desc, id limit 200) i), '[]'::jsonb);
end;
$$;

-- 取り消し(MSMスタッフ)。使用済みのものは取り消せない。
create or replace function public.neo_invite_revoke(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_row public.neo_invites%rowtype;
begin
  if not public.is_msm_staff() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  select * into v_row from public.neo_invites where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_row.used_at is not null then raise exception 'already_used' using errcode = 'P0001'; end if;
  if v_row.revoked_at is null then
    update public.neo_invites set revoked_at = now(), revoked_by = auth.uid() where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- お客様の申し込み画面から:リンクの状態だけを返す(ok / used / expired / revoked / invalid)
create or replace function public.neo_invite_status(p_token text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.neo_invites%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32,64}$' then return 'invalid'; end if;
  select * into v_row from public.neo_invites where token = p_token;
  if not found then return 'invalid'; end if;
  return public.neo_invite_state(v_row.used_at, v_row.revoked_at, v_row.expires_at);
end;
$$;

-- ------------------------------------------------------------
-- 2. MapOn Light(店舗のプラン)
-- ------------------------------------------------------------
alter table public.clients add column if not exists tier text not null default 'standard';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_tier_check' and conrelid = 'public.clients'::regclass) then
    alter table public.clients add constraint clients_tier_check check (tier in ('standard', 'light'));
  end if;
end $$;

-- プランの変更の記録
create table if not exists public.neo_tier_changes (
    id          bigserial primary key,
    client_id   text not null,
    store_name  text,
    email       text,
    from_tier   text,
    to_tier     text,
    counts      jsonb not null default '{}'::jsonb,
    changed_by  uuid,
    changed_at  timestamptz not null default now()
);
alter table public.neo_tier_changes enable row level security;
revoke all on table public.neo_tier_changes from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.neo_tier_changes from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.neo_tier_changes from authenticated'; end if;
end $$;

-- 店舗が Light か(内部の部品)
create or replace function public.neo_is_light(p_client text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select c.tier = 'light' from public.clients c where c.id::text = p_client), false);
$$;

-- clients の守り:プランは neo_admin_set_tier からしか変えられない/Light のAIの上限は、いつも50回
create or replace function public.neo_clients_tier_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.tier is distinct from old.tier
     and coalesce(current_setting('mapon.tier_change', true), '') <> 'on' then
    raise exception 'tier_change_not_allowed' using errcode = 'P0001';
  end if;
  if new.tier = 'light' then
    new.monthly_ai_limit := 50;
  end if;
  return new;
end;
$$;
drop trigger if exists neo_clients_tier_guard on public.clients;
create trigger neo_clients_tier_guard before insert or update on public.clients
  for each row execute function public.neo_clients_tier_guard();

-- Light の制限:アンケートは1つまで(削除していないもの)
create or replace function public.neo_light_survey_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and public.neo_is_light(new.client_id::text)
     and exists (select 1 from public.neo_surveys s where s.client_id = new.client_id and s.deleted_at is null and s.id <> new.id) then
    raise exception 'light_limit_survey' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists neo_light_survey_guard on public.neo_surveys;
create trigger neo_light_survey_guard before insert or update of deleted_at on public.neo_surveys
  for each row execute function public.neo_light_survey_guard();

-- Light の制限:クーポンは1つまで(削除していないもの)
create or replace function public.neo_light_coupon_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and public.neo_is_light(new.client_id)
     and exists (select 1 from public.neo_coupons c where c.client_id = new.client_id and c.deleted_at is null and c.id <> new.id) then
    raise exception 'light_limit_coupon' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists neo_light_coupon_guard on public.neo_coupons;
create trigger neo_light_coupon_guard before insert or update of deleted_at on public.neo_coupons
  for each row execute function public.neo_light_coupon_guard();

-- Light の制限:会員証・ショップカードは使えない(設定・会員・スタンプ用QRを作れない)
create or replace function public.neo_light_card_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.neo_is_light(new.client_id) then
    raise exception 'light_limit_card' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists neo_light_card_guard on public.neo_card_settings;
create trigger neo_light_card_guard before insert or update on public.neo_card_settings
  for each row execute function public.neo_light_card_guard();
drop trigger if exists neo_light_card_guard on public.neo_members;
create trigger neo_light_card_guard before insert on public.neo_members
  for each row execute function public.neo_light_card_guard();
drop trigger if exists neo_light_card_guard on public.neo_stamp_qrs;
create trigger neo_light_card_guard before insert on public.neo_stamp_qrs
  for each row execute function public.neo_light_card_guard();

-- Light にしたときに消えるもの(件数と、残すアンケート・クーポン)
create or replace function public.neo_tier_light_plan(p_client_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_keep_survey uuid;
  v_keep_coupon uuid;
begin
  select s.id into v_keep_survey from public.neo_surveys s
   where s.client_id::text = p_client_id and s.deleted_at is null order by s.created_at, s.id limit 1;
  select c.id into v_keep_coupon from public.neo_coupons c
   where c.client_id = p_client_id and c.deleted_at is null order by c.created_at, c.id limit 1;
  return jsonb_build_object(
    'keep_survey_id', v_keep_survey,
    'keep_survey_title', (select title from public.neo_surveys where id = v_keep_survey),
    'keep_coupon_id', v_keep_coupon,
    'keep_coupon_name', (select name from public.neo_coupons where id = v_keep_coupon),
    'members', (select count(*) from public.neo_members where client_id = p_client_id),
    'stamp_events', (select count(*) from public.neo_stamp_events e join public.neo_members m on m.id = e.member_id where m.client_id = p_client_id),
    'card', exists (select 1 from public.neo_card_settings where client_id = p_client_id),
    'coupons_total', (select count(*) from public.neo_coupons where client_id = p_client_id and deleted_at is null),
    'coupons_delete', (select count(*) from public.neo_coupons where client_id = p_client_id and id is distinct from v_keep_coupon),
    'coupon_issues_delete', (select count(*) from public.neo_coupon_issues i join public.neo_coupons c on c.id = i.coupon_id
                              where c.client_id = p_client_id and c.id is distinct from v_keep_coupon),
    'surveys_total', (select count(*) from public.neo_surveys where client_id::text = p_client_id and deleted_at is null),
    'surveys_delete', (select count(*) from public.neo_surveys where client_id::text = p_client_id and id is distinct from v_keep_survey),
    'responses_delete', (select count(*) from public.neo_survey_responses r join public.neo_surveys s on s.id = r.survey_id
                          where s.client_id::text = p_client_id and s.id is distinct from v_keep_survey));
end;
$$;

-- 確認の画面用(MSMスタッフ)
create or replace function public.neo_admin_tier_preview(p_client_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_client public.clients%rowtype;
begin
  if not public.is_msm_staff() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  select * into v_client from public.clients where id::text = p_client_id;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'id', v_client.id, 'company_name', v_client.company_name, 'email', v_client.email, 'tier', v_client.tier,
    'plan', v_client.plan, 'is_admin', public.is_msm_admin(),
    'light', case when v_client.tier = 'light' then null else public.neo_tier_light_plan(p_client_id) end);
end;
$$;

-- プランを変える
--   p_tier = 'standard'(有料にする):MSMスタッフ。データは消さない。AIは月300回。
--   p_tier = 'light'(Lightにする):MSMの管理者だけ。店舗名(またはメールアドレス)の入力が必要。データを削除する。
create or replace function public.neo_admin_set_tier(p_client_id text, p_tier text, p_confirm_name text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_client public.clients%rowtype;
  v_plan jsonb;
  v_keep_survey uuid;
  v_keep_coupon uuid;
  v_ids uuid[];
begin
  if p_tier not in ('standard', 'light') then raise exception 'bad_tier' using errcode = 'P0001'; end if;
  if not public.is_msm_staff() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if p_tier = 'light' and not public.is_msm_admin() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  select * into v_client from public.clients where id::text = p_client_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_client.plan is distinct from 'D' then raise exception 'not_neo' using errcode = 'P0001'; end if;
  if v_client.tier = p_tier then
    return jsonb_build_object('ok', true, 'tier', p_tier, 'changed', false);
  end if;

  perform set_config('mapon.tier_change', 'on', true);

  if p_tier = 'standard' then
    update public.clients set tier = 'standard', monthly_ai_limit = 300 where id = v_client.id;
    insert into public.neo_tier_changes (client_id, store_name, email, from_tier, to_tier, changed_by)
    values (p_client_id, v_client.company_name, v_client.email, v_client.tier, 'standard', auth.uid());
    perform set_config('mapon.tier_change', '', true);
    return jsonb_build_object('ok', true, 'tier', 'standard', 'changed', true);
  end if;

  -- Light にする:確認の入力は、店舗名か、登録のメールアドレス(大文字・小文字は区別しない)
  if btrim(coalesce(p_confirm_name, '')) = ''
     or (btrim(p_confirm_name) <> btrim(coalesce(v_client.company_name, ''))
         and lower(btrim(p_confirm_name)) <> lower(btrim(coalesce(v_client.email, '')))) then
    raise exception 'name_mismatch' using errcode = 'P0001';
  end if;

  v_plan := public.neo_tier_light_plan(p_client_id);
  v_keep_survey := nullif(v_plan->>'keep_survey_id', '')::uuid;
  v_keep_coupon := nullif(v_plan->>'keep_coupon_id', '')::uuid;

  -- 会員・ショップカード(全部)
  delete from public.neo_member_logs where client_id = p_client_id;
  delete from public.neo_stamp_events where member_id in (select id from public.neo_members where client_id = p_client_id);
  delete from public.neo_members where client_id = p_client_id;
  delete from public.neo_stamp_qrs where client_id = p_client_id;
  delete from public.neo_card_settings where client_id = p_client_id;

  -- クーポン(最初に作った1つ以外)
  select coalesce(array_agg(id), '{}') into v_ids from public.neo_coupons where client_id = p_client_id and id is distinct from v_keep_coupon;
  update public.neo_reward_settings
     set mode = case when v_keep_coupon is not null and mode = 'coupon' then 'coupon' else 'none' end,
         coupon_id = case when v_keep_coupon is not null and mode = 'coupon' then v_keep_coupon else null end,
         lottery = '{"prizes": []}'::jsonb, updated_at = now()
   where client_id = p_client_id
     and (coupon_id = any (v_ids) or mode = 'lottery' or jsonb_array_length(coalesce(lottery->'prizes', '[]'::jsonb)) > 0);
  delete from public.neo_coupon_issues where coupon_id = any (v_ids);
  delete from public.neo_coupons where id = any (v_ids);

  -- アンケート(最初に作った1つ以外。回答・AIの文章も一緒に消える)
  delete from public.neo_surveys where client_id::text = p_client_id and id is distinct from v_keep_survey;

  update public.clients set tier = 'light' where id = v_client.id;
  insert into public.neo_tier_changes (client_id, store_name, email, from_tier, to_tier, counts, changed_by)
  values (p_client_id, v_client.company_name, v_client.email, v_client.tier, 'light', v_plan, auth.uid());
  perform set_config('mapon.tier_change', '', true);
  return jsonb_build_object('ok', true, 'tier', 'light', 'changed', true, 'counts', v_plan);
end;
$$;

-- ------------------------------------------------------------
-- 3. 申し込み(有料はワンタイムリンクが必要/Light は受付のスイッチが開いているときだけ)
-- ------------------------------------------------------------
insert into public.neo_settings (key, value) values ('light_signup_open', 'false') on conflict (key) do nothing;

create or replace function public.neo_light_signup_status()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true' from public.neo_settings where key = 'light_signup_open'), false);
$$;

create or replace function public.handle_mapon_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_source text := meta->>'signup_source';
  v_company text := left(coalesce(nullif(trim(meta->>'company_name'), ''), '(店舗名未入力)'), 100);
  v_owner text := left(nullif(trim(meta->>'owner_name'), ''), 100);
  v_token text := meta->>'invite';
  v_invite public.neo_invites%rowtype;
  v_client_id bigint;
begin
  if v_source = 'mapon_signup' then
    -- 有料:使えるワンタイムリンクが必要
    if v_token is null or v_token !~ '^[0-9a-f]{32,64}$' then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
    select * into v_invite from public.neo_invites where token = v_token for update;
    if not found then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
    if public.neo_invite_state(v_invite.used_at, v_invite.revoked_at, v_invite.expires_at) <> 'ok' then
      raise exception 'invite_%', public.neo_invite_state(v_invite.used_at, v_invite.revoked_at, v_invite.expires_at) using errcode = 'P0001';
    end if;
    insert into public.clients (auth_id, company_name, owner_name, email, plan, status, tier)
    values (new.id, v_company, v_owner, new.email, 'D', '稼働中', 'standard')
    returning id into v_client_id;
    update public.neo_invites
       set used_at = now(), used_by = new.id, used_client_id = v_client_id::text, used_store = v_company, used_email = new.email
     where id = v_invite.id;
  elsif v_source = 'mapon_light' then
    -- Light:受付のスイッチが開いているときだけ
    if not public.neo_light_signup_status() then raise exception 'light_closed' using errcode = 'P0001'; end if;
    insert into public.clients (auth_id, company_name, owner_name, email, plan, status, tier)
    values (new.id, v_company, v_owner, new.email, 'D', '稼働中', 'light');
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 4. お迎えメール:Light かどうかも返す(それ以外は 追加SQL_13 と同じ)
-- ------------------------------------------------------------
create or replace function public.neo_welcome_claim()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_uid uuid := auth.uid();
    v_created timestamptz;
    v_client record;
    v_n integer;
begin
    if v_uid is null then
        return jsonb_build_object('ok', false, 'reason', 'no_user');
    end if;
    select u.created_at into v_created from auth.users u where u.id = v_uid;
    if v_created is null or v_created < now() - interval '15 minutes' then
        return jsonb_build_object('ok', false, 'reason', 'too_old');
    end if;
    select c.company_name, c.owner_name, c.plan, c.tier into v_client
      from public.clients c where c.auth_id::text = v_uid::text limit 1;
    if not found or v_client.plan is distinct from 'D' then
        return jsonb_build_object('ok', false, 'reason', 'not_neo');
    end if;
    insert into public.neo_welcome_mail (user_id) values (v_uid) on conflict (user_id) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then
        return jsonb_build_object('ok', false, 'reason', 'already');
    end if;
    return jsonb_build_object('ok', true, 'owner_name', v_client.owner_name, 'company_name', v_client.company_name, 'tier', v_client.tier);
end;
$$;

-- ------------------------------------------------------------
-- 呼べる人の設定
--   お客様(ログインしていない人)が呼べるのは、neo_invite_status と neo_light_signup_status だけ。
--   スタッフ・管理者の関数は、ログインしている人だけ(中で、スタッフ・管理者かを確かめる)。
--   内部の部品(トリガー・状態の計算など)は、誰も直接は呼べない。
-- ------------------------------------------------------------
do $$
declare
  v_public text[] := array['public.neo_invite_status(text)', 'public.neo_light_signup_status()'];
  v_staff text[] := array['public.neo_invite_issue(text, integer, date)', 'public.neo_invite_list()', 'public.neo_invite_revoke(uuid)',
                          'public.neo_admin_tier_preview(text)', 'public.neo_admin_set_tier(text, text, text)', 'public.neo_welcome_claim()'];
  v_internal text[] := array['public.neo_invite_state(timestamptz, timestamptz, timestamptz)', 'public.neo_is_light(text)',
                             'public.neo_clients_tier_guard()', 'public.neo_light_survey_guard()', 'public.neo_light_coupon_guard()',
                             'public.neo_light_card_guard()', 'public.neo_tier_light_plan(text)', 'public.handle_mapon_signup()'];
  f text;
begin
  foreach f in array v_public || v_staff || v_internal loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array v_public loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  foreach f in array v_staff loop
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;
