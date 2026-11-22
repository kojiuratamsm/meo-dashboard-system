-- ============================================================
-- 追加SQL_22:Lightの申し込みのLINE名・利用規約の同意の記録・Lightの解約・解約したメールアドレスの再申し込みの停止
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。このSQLを実行しただけでは、データは何も消えません。
-- 前提:追加SQL_14(店舗アカウントの削除)と追加SQL_21(ワンタイムリンクとMapOn Light)を実行済みであること。
--
-- 内容:
--  ・clients.line_name / terms_version / terms_agreed_at … LINEに登録されているお名前、同意した利用規約の版と日時
--  ・handle_mapon_signup(申し込みの処理)
--      有料(mapon_signup):これまでどおり。利用規約の版が送られてきたら、同意の日時と一緒に記録する(送られなくても断らない)
--      Light(mapon_light):受付が閉じている/解約したメールアドレス/LINE名がない/利用規約の同意がない、のときは、アカウントごと作らない
--  ・neo_light_signup_check(メール)     … 申し込みページが、申し込む前と失敗したあとに、理由を確かめる(closed / blocked / ok だけを返す)
--  ・neo_light_cancel(今のパスワード)   … Lightの店舗の本人が、設定画面から解約する。データとログイン用アカウントを、すぐに削除する
--  ・neo_signup_blocks                  … 解約したメールアドレスの記録(Lightの再申し込みを止める)
--  ・neo_admin_signup_blocks() / neo_admin_signup_block_release(ID) … マスター画面の一覧と「再申し込みを許可」
--
-- 安全のための決まり:
--  ・自分で解約できるのは、Lightの店舗の本人だけ。今のパスワードが正しくないと解約できない。
--    有料(MapOn)の店舗は、アプリの中からは解約できない(公式LINEで受け付け、担当者が手作業で行う)。
--  ・解約は1つのまとまり(トランザクション)で行う。途中で1つでも失敗したら、何も消さずに止まる。
--  ・解約の記録は、これまでの削除の記録(neo_store_deletions)に、本人による解約(by_self)として残す。
--  ・再申し込みを止めるのは Light の申し込みだけ。有料のワンタイムリンクの申し込みは止めない。
--
-- 注意:解約で削除したデータは元に戻せません。
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
--   (Lightは受付を閉じたままなので、順番が入れ替わっても有料の申し込みは止まりません)
-- ============================================================

-- 店舗の列:LINEに登録されているお名前(Lightだけ)、同意した利用規約の版と日時
alter table public.clients add column if not exists line_name text;
alter table public.clients add column if not exists terms_version text;
alter table public.clients add column if not exists terms_agreed_at timestamptz;

-- 削除の記録:本人による解約かどうか
alter table public.neo_store_deletions add column if not exists by_self boolean not null default false;

-- 解約したメールアドレスの記録(Lightの再申し込みを止める)
-- ※ 列の名前を client_id にしない(マスター画面の店舗削除が、client_id を持つ neo_ の表をまとめて消すため)
create table if not exists public.neo_signup_blocks (
    id                bigserial primary key,
    email             text not null,
    source_client_id  text,
    store_name        text,
    line_name         text,
    reason            text not null default 'light_cancel',
    created_at        timestamptz not null default now(),
    released_at       timestamptz,
    released_by       uuid
);
create unique index if not exists neo_signup_blocks_active on public.neo_signup_blocks (lower(email)) where released_at is null;
alter table public.neo_signup_blocks enable row level security;
revoke all on table public.neo_signup_blocks from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.neo_signup_blocks from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.neo_signup_blocks from authenticated'; end if;
end $$;

-- このメールアドレスは、解約した記録があって、再申し込みを止めているか(内部の部品)
create or replace function public.neo_email_blocked(p_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.neo_signup_blocks b
                  where lower(b.email) = lower(btrim(coalesce(p_email, ''))) and b.released_at is null);
$$;

-- 申し込みページ用:Lightに、このメールアドレスで申し込めるか(理由だけを返す)
create or replace function public.neo_light_signup_check(p_email text)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if not public.neo_light_signup_status() then return 'closed'; end if;
  if public.neo_email_blocked(p_email) then return 'blocked'; end if;
  return 'ok';
end;
$$;

-- 申し込みの処理(SQL_21 のものに、LINE名・利用規約・再申し込みの停止を足す)
create or replace function public.handle_mapon_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_source text := meta->>'signup_source';
  v_company text := left(coalesce(nullif(trim(meta->>'company_name'), ''), '(店舗名未入力)'), 100);
  v_owner text := left(nullif(trim(meta->>'owner_name'), ''), 100);
  v_line text := left(nullif(trim(meta->>'line_name'), ''), 100);
  v_terms text := left(nullif(trim(meta->>'terms_version'), ''), 40);
  v_token text := meta->>'invite';
  v_invite public.neo_invites%rowtype;
  v_client_id bigint;
begin
  if v_source = 'mapon_signup' then
    if v_token is null or v_token !~ '^[0-9a-f]{32,64}$' then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
    select * into v_invite from public.neo_invites where token = v_token for update;
    if not found then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
    if public.neo_invite_state(v_invite.used_at, v_invite.revoked_at, v_invite.expires_at) <> 'ok' then
      raise exception 'invite_%', public.neo_invite_state(v_invite.used_at, v_invite.revoked_at, v_invite.expires_at) using errcode = 'P0001';
    end if;
    insert into public.clients (auth_id, company_name, owner_name, email, plan, status, tier, terms_version, terms_agreed_at)
    values (new.id, v_company, v_owner, new.email, 'D', '稼働中', 'standard', v_terms, case when v_terms is not null then now() end)
    returning id into v_client_id;
    update public.neo_invites
       set used_at = now(), used_by = new.id, used_client_id = v_client_id::text, used_store = v_company, used_email = new.email
     where id = v_invite.id;
  elsif v_source = 'mapon_light' then
    if not public.neo_light_signup_status() then raise exception 'light_closed' using errcode = 'P0001'; end if;
    if public.neo_email_blocked(new.email) then raise exception 'light_email_blocked' using errcode = 'P0001'; end if;
    if v_line is null then raise exception 'line_name_required' using errcode = 'P0001'; end if;
    if v_terms is null then raise exception 'terms_required' using errcode = 'P0001'; end if;
    insert into public.clients (auth_id, company_name, owner_name, email, plan, status, tier, line_name, terms_version, terms_agreed_at)
    values (new.id, v_company, v_owner, new.email, 'D', '稼働中', 'light', v_line, v_terms, now());
  end if;
  return new;
end;
$$;

-- Lightの解約(店舗の本人だけ。今のパスワードで本人確認。データとログイン用アカウントを、すぐに削除する)
create or replace function public.neo_light_cancel(p_current_password text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions, auth as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_client public.clients%rowtype;
  v_login_email text;
  v_counts jsonb;
  v_auth_deleted boolean := false;
  v_table text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  select encrypted_password, email into v_hash, v_login_email from auth.users where id = v_uid;
  if coalesce(p_current_password, '') = '' or v_hash is null or crypt(p_current_password, v_hash) <> v_hash then
    perform pg_sleep(1);   -- 総当たり対策
    raise exception 'wrong_password' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.staff_members s where s.auth_user_id::text = v_uid::text) then
    raise exception 'is_staff' using errcode = 'P0001';
  end if;
  select * into v_client from public.clients where auth_id::text = v_uid::text and plan = 'D' order by id limit 1 for update;
  if not found then raise exception 'client_not_found' using errcode = 'P0001'; end if;
  if v_client.tier is distinct from 'light' then raise exception 'not_light' using errcode = 'P0001'; end if;

  v_counts := public.neo_admin_store_counts(v_client.id::text);

  -- 店舗のデータ(マスター画面の店舗削除と同じ順番)
  delete from public.neo_coupon_issues where client_id = v_client.id::text;
  delete from public.neo_reward_settings where client_id = v_client.id::text;
  delete from public.neo_stamp_events where client_id = v_client.id::text;
  delete from public.neo_member_logs where client_id = v_client.id::text;
  delete from public.neo_member_reissues where client_id = v_client.id::text;
  delete from public.neo_member_devices where client_id = v_client.id::text;
  delete from public.neo_member_private where client_id = v_client.id::text;
  delete from public.neo_members where client_id = v_client.id::text;
  delete from public.neo_stamp_qrs where client_id = v_client.id::text;
  delete from public.neo_card_settings where client_id = v_client.id::text;
  delete from public.neo_coupons where client_id = v_client.id::text;
  delete from public.neo_ai_drafts where client_id = v_client.id::text;
  delete from public.neo_password_resets where client_id = v_client.id::text;
  for v_table in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'client_id' and c.table_name like 'neo\_%'
       and c.table_name not in ('neo_surveys', 'neo_store_deletions', 'neo_tier_changes')
     order by c.table_name
  loop
    execute format('delete from public.%I where client_id::text = $1', v_table) using v_client.id::text;
  end loop;

  -- 店舗の行(アンケート・回答・開いた回数は、これにつながって一緒に消える)
  delete from public.clients where id = v_client.id;

  -- 解約したメールアドレスを記録して、Lightの再申し込みを止める(ログイン用と店舗のメールアドレスの両方)
  insert into public.neo_signup_blocks (email, source_client_id, store_name, line_name)
  select distinct lower(btrim(e)), v_client.id::text, v_client.company_name, v_client.line_name
    from unnest(array[v_client.email, v_login_email]) e
   where nullif(btrim(coalesce(e, '')), '') is not null
     and not public.neo_email_blocked(e);

  -- ログイン用アカウント(ほかの顧客にもつながっている場合は残す)
  if not exists (select 1 from public.clients c where c.auth_id::text = v_uid::text) then
    delete from public.neo_password_resets where auth_id::text = v_uid::text;
    delete from auth.users where id = v_uid;
    v_auth_deleted := found;
  end if;

  insert into public.neo_store_deletions (client_id, store_name, email, counts, auth_deleted, deleted_by, by_self)
  values (v_client.id::text, v_client.company_name, v_client.email, v_counts, v_auth_deleted, v_uid, true);

  return jsonb_build_object('ok', true, 'auth_deleted', v_auth_deleted);
end;
$$;

-- マスター画面:解約したメールアドレスの一覧(MSMスタッフ。新しい順に200件)
create or replace function public.neo_admin_signup_blocks()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_msm_staff() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'email', b.email, 'store_name', b.store_name, 'line_name', b.line_name,
                                        'reason', b.reason, 'created_at', b.created_at, 'released_at', b.released_at)
                     order by b.created_at desc, b.id desc)
      from (select * from public.neo_signup_blocks order by created_at desc, id desc limit 200) b), '[]'::jsonb);
end;
$$;

-- マスター画面:再申し込みを許可する(MSMスタッフ)
create or replace function public.neo_admin_signup_block_release(p_id bigint)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_row public.neo_signup_blocks%rowtype;
begin
  if not public.is_msm_staff() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  select * into v_row from public.neo_signup_blocks where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_row.released_at is null then
    update public.neo_signup_blocks set released_at = now(), released_by = auth.uid() where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 実行の権限
--  ・ログインしていない人(anon):neo_light_signup_check だけ
--  ・ログインしている人(authenticated):neo_light_signup_check、neo_light_cancel、マスター画面の2つ(中で本人・スタッフを確かめる)
--  ・内部の部品(neo_email_blocked・handle_mapon_signup):だれにも許可しない
do $$
declare
  v_public text[] := array['public.neo_light_signup_check(text)'];
  v_auth text[] := array['public.neo_light_cancel(text)', 'public.neo_admin_signup_blocks()', 'public.neo_admin_signup_block_release(bigint)'];
  v_internal text[] := array['public.neo_email_blocked(text)', 'public.handle_mapon_signup()'];
  f text;
begin
  foreach f in array v_public || v_auth || v_internal loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array v_public loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  foreach f in array v_auth loop
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;
