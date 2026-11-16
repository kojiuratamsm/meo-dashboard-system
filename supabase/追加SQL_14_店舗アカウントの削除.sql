-- ============================================================
-- 追加SQL_14:マスター画面から、MapOn NEO の店舗アカウントを削除する
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。このSQLを実行しただけでは、データは何も消えません。
--
-- 内容:
--  ・neo_admin_store_preview(店舗ID)        … 削除する前に、消えるデータの件数を返す
--  ・neo_admin_store_delete(店舗ID, 店舗名)  … 店舗のデータ・顧客一覧(clients)の行・ログイン用アカウントを、まとめて削除する
--  ・neo_store_deletions                     … 誰が・いつ・どの店舗を・何件のデータと一緒に削除したかの記録
--
-- 安全のための決まり:
--  ・使えるのは、MSMの管理者(staff_members の role = 'msm_admin')だけ。ほかのスタッフ・店舗・ログインしていない人は使えない。
--  ・削除できるのは、MapOn NEO の店舗(clients.plan = 'D')だけ。ほかのプランの顧客は削除できない。
--  ・MSMスタッフのアカウントにつながっている店舗は削除できない。
--  ・店舗名(または登録のメールアドレス)を正確に入力しないと削除できない(押し間違いを防ぐ)。
--  ・削除は1つのまとまり(トランザクション)で行う。途中で1つでも失敗したら、何も消さずに止まる。
--  ・同じログイン用アカウントが、ほかの顧客(clients)にもつながっている場合は、アカウントは消さずに残す。
--  ・削除の記録には、店舗名・メールアドレス・件数だけを残す(会員の名前や電話番号は残さない)。
--
-- 注意:削除したデータは元に戻せません。
-- 実行の順番:このSQLを実行してから、master-surveys.js をアップロードしてください。
-- ============================================================

-- 削除の記録
create table if not exists public.neo_store_deletions (
    id           bigserial primary key,
    client_id    text not null,
    store_name   text,
    email        text,
    counts       jsonb not null default '{}'::jsonb,
    auth_deleted boolean not null default false,
    deleted_by   uuid,
    deleted_at   timestamptz not null default now()
);
alter table public.neo_store_deletions enable row level security;
revoke all on public.neo_store_deletions from anon, authenticated;

-- 店舗のデータの件数(削除の前の確認と、削除の記録に使う。内部の部品)
create or replace function public.neo_admin_store_counts(p_client_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'surveys',       (select count(*) from public.neo_surveys s where s.client_id::text = p_client_id),
        'responses',     (select count(*) from public.neo_survey_responses r join public.neo_surveys s on s.id = r.survey_id where s.client_id::text = p_client_id),
        'ai_drafts',     (select count(*) from public.neo_ai_drafts d where d.client_id = p_client_id),
        'coupons',       (select count(*) from public.neo_coupons c where c.client_id = p_client_id),
        'coupon_issues', (select count(*) from public.neo_coupon_issues i where i.client_id = p_client_id),
        'members',       (select count(*) from public.neo_members m where m.client_id = p_client_id),
        'stamp_events',  (select count(*) from public.neo_stamp_events e where e.client_id = p_client_id)
    );
$$;
revoke all on function public.neo_admin_store_counts(text) from public, anon, authenticated;

-- 削除する前の確認(管理者だけ)
create or replace function public.neo_admin_store_preview(p_client_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
    v_client record;
    v_reason text := null;
    v_shared integer := 0;
begin
    if not public.is_msm_admin() then
        raise exception 'not_allowed' using errcode = 'P0001';
    end if;
    select c.id::text as id, c.company_name, c.email, c.plan, c.created_at, c.auth_id::text as auth_id, to_jsonb(c)->>'owner_name' as owner_name
      into v_client
      from public.clients c where c.id::text = p_client_id;
    if not found then
        raise exception 'not_found' using errcode = 'P0001';
    end if;
    if v_client.plan is distinct from 'D' then
        v_reason := 'not_neo';
    elsif v_client.auth_id is not null and exists (select 1 from public.staff_members s where s.auth_user_id::text = v_client.auth_id) then
        v_reason := 'is_staff';
    end if;
    if v_client.auth_id is not null then
        select count(*) into v_shared from public.clients c where c.auth_id::text = v_client.auth_id and c.id::text <> p_client_id;
    end if;
    return jsonb_build_object(
        'id', v_client.id,
        'company_name', v_client.company_name,
        'owner_name', v_client.owner_name,
        'email', v_client.email,
        'created_at', v_client.created_at,
        'has_login', v_client.auth_id is not null and exists (select 1 from auth.users u where u.id::text = v_client.auth_id),
        'login_shared', v_shared > 0,
        'deletable', v_reason is null,
        'reason', v_reason,
        'counts', public.neo_admin_store_counts(p_client_id)
    );
end;
$$;
revoke all on function public.neo_admin_store_preview(text) from public, anon;
grant execute on function public.neo_admin_store_preview(text) to authenticated;

-- 店舗アカウントの削除(管理者だけ。店舗名の確認つき。途中で失敗したら、何も消さない)
create or replace function public.neo_admin_store_delete(p_client_id text, p_confirm_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
    v_client record;
    v_counts jsonb;
    v_auth_deleted boolean := false;
    v_table text;
begin
    if not public.is_msm_admin() then
        raise exception 'not_allowed' using errcode = 'P0001';
    end if;
    select c.id::text as id, c.company_name, c.email, c.plan, c.auth_id::text as auth_id
      into v_client
      from public.clients c where c.id::text = p_client_id
      for update;
    if not found then
        raise exception 'not_found' using errcode = 'P0001';
    end if;
    if v_client.plan is distinct from 'D' then
        raise exception 'not_neo' using errcode = 'P0001';
    end if;
    if v_client.auth_id is not null and exists (select 1 from public.staff_members s where s.auth_user_id::text = v_client.auth_id) then
        raise exception 'is_staff' using errcode = 'P0001';
    end if;
    -- 確認の入力は、店舗名か、登録のメールアドレス(大文字・小文字は区別しない)のどちらか
    if btrim(coalesce(p_confirm_name, '')) = ''
       or (btrim(p_confirm_name) <> btrim(coalesce(v_client.company_name, ''))
           and lower(btrim(p_confirm_name)) <> lower(btrim(coalesce(v_client.email, '')))) then
        raise exception 'name_mismatch' using errcode = 'P0001';
    end if;

    v_counts := public.neo_admin_store_counts(p_client_id);

    -- 店舗のデータ(ほかの表から参照されている順に消す)
    delete from public.neo_coupon_issues where client_id = p_client_id;
    delete from public.neo_reward_settings where client_id = p_client_id;
    delete from public.neo_stamp_events where client_id = p_client_id;
    delete from public.neo_member_logs where client_id = p_client_id;
    delete from public.neo_member_reissues where client_id = p_client_id;
    delete from public.neo_member_devices where client_id = p_client_id;
    delete from public.neo_member_private where client_id = p_client_id;
    delete from public.neo_members where client_id = p_client_id;
    delete from public.neo_stamp_qrs where client_id = p_client_id;
    delete from public.neo_card_settings where client_id = p_client_id;
    delete from public.neo_coupons where client_id = p_client_id;
    delete from public.neo_ai_drafts where client_id = p_client_id;
    delete from public.neo_password_resets where client_id = p_client_id;
    -- このあとに追加された MapOn NEO の表(neo_ で始まり、client_id を持つもの)も消す
    for v_table in
        select c.table_name
          from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
         where c.table_schema = 'public' and c.column_name = 'client_id' and c.table_name like 'neo\_%'
           and c.table_name not in ('neo_surveys', 'neo_store_deletions')
         order by c.table_name
    loop
        execute format('delete from public.%I where client_id::text = $1', v_table) using p_client_id;
    end loop;

    -- 顧客一覧の行(アンケート・回答・開いた回数は、これにつながって一緒に消える)
    delete from public.clients where id::text = p_client_id;

    -- ログイン用アカウント(ほかの顧客にもつながっている場合は残す)
    if v_client.auth_id is not null
       and not exists (select 1 from public.clients c where c.auth_id::text = v_client.auth_id) then
        delete from public.neo_password_resets where auth_id::text = v_client.auth_id;
        delete from auth.users where id::text = v_client.auth_id;
        v_auth_deleted := found;
    end if;

    insert into public.neo_store_deletions (client_id, store_name, email, counts, auth_deleted, deleted_by)
    values (p_client_id, v_client.company_name, v_client.email, v_counts, v_auth_deleted, auth.uid());

    return jsonb_build_object('ok', true, 'company_name', v_client.company_name, 'counts', v_counts, 'auth_deleted', v_auth_deleted);
end;
$$;
revoke all on function public.neo_admin_store_delete(text, text) from public, anon;
grant execute on function public.neo_admin_store_delete(text, text) to authenticated;
