-- ============================================================
-- 追加SQL_16:セキュリティの強化(ログインしていない人が呼べる関数を絞る/スタッフのアカウントを再設定URLで乗っ取れないようにする)
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。表やデータは変更・削除しません
-- (使われていない「スタッフのアカウントの再設定URL」があれば、使えなくするだけ)。
--
-- 内容:
--  1. MapOn が作った関数のうち、お客様(ログインしていない人)が使わないものは、ログインしていない人(anon)から呼べなくする。
--     ・Supabase では、新しく作った関数は、初めは誰でも呼べる。これまでの関数は、中で「ログインしているか・権限があるか」を
--       確かめているので実害はないが、二重の守りとして、入口でも断る。
--     ・お客様が使う関数(アンケートの回答・クーポン・会員登録・スタンプ・パスワード再設定URLを開く など)は、これまでどおり呼べる。
--     ・ログインしている店舗・スタッフが今使えている関数は、今までどおり使える(使える状態を確かめてから、ログインしていない人の分だけ外す)。
--     ・予約・メニュー・ブログなど、MapOn NEO 以外の機能の関数には触らない。
--  2. パスワード再設定URLの発行(マスター画面「再設定URL」)で、MSMスタッフ・管理者のアカウントにつながった店舗には発行できなくする。
--     (スタッフが、管理者のアカウントに入れてしまう抜け道をふさぐ)
--  3. すでに発行済みで、まだ使われていない「スタッフ・管理者のアカウントの再設定URL」は、使えなくする。
--     再設定URLでパスワードを変えるときも、スタッフ・管理者のアカウントなら断る。
--
-- 実行の順番:このSQLを実行してから、master-surveys.js をアップロードしてください(逆でも動きます)。
-- ============================================================

-- ------------------------------------------------------------
-- 1. ログインしていない人(anon)が呼べる関数を絞る
-- ------------------------------------------------------------
do $$
declare
    -- お客様の画面で使うため、ログインしていない人も呼べる関数(これまでどおり)
    v_public_names text[] := array[
        'is_msm_staff',
        'neo_get_public_survey', 'neo_submit_survey_response', 'neo_record_review_action', 'neo_survey_view',
        'neo_draft_begin', 'neo_draft_finish',
        'neo_get_reward_info', 'neo_claim_reward', 'neo_get_coupon', 'neo_use_coupon',
        'neo_wallet_view', 'neo_wallet_attach', 'neo_member_join', 'neo_stamp_by_qr', 'neo_member_restore',
        'neo_check_password_reset', 'neo_reset_password_with_token'
    ];
    -- MapOn が作った、それ以外の関数(ログインした店舗・スタッフ用と、内部の部品)
    v_private_names text[] := array[
        'handle_mapon_signup', 'is_msm_admin', 'my_client_id',
        'neo_admin_store_counts', 'neo_admin_store_delete', 'neo_admin_store_preview',
        'neo_can_manage', 'neo_card_clean_rewards', 'neo_card_public', 'neo_card_rank_index', 'neo_card_rewards_public',
        'neo_card_round_rewards', 'neo_card_settings_get', 'neo_change_login_email', 'neo_coupon_available', 'neo_coupon_snapshot',
        'neo_dashboard', 'neo_dev_hash', 'neo_duplicate_survey', 'neo_issue_password_reset', 'neo_master_overview',
        'neo_member_delete', 'neo_member_reissue', 'neo_member_reveal_phone', 'neo_member_stamp_manual', 'neo_random_hex',
        'neo_save_card_settings', 'neo_save_reward_settings', 'neo_stamp_apply', 'neo_stamp_qr_update', 'neo_touch_updated_at',
        'neo_update_review_url', 'neo_update_store_name', 'neo_welcome_claim', 'neo_welcome_done', 'neo_welcome_release'
    ];
    r record;
    v_role text;
begin
    for r in
        select p.oid::regprocedure as fn
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any (v_private_names) and p.proname <> all (v_public_names)
    loop
        -- いまログインしている人・サーバー用の鍵で使えているものは、そのまま使えるように、はっきり許可しておく
        foreach v_role in array array['authenticated', 'service_role'] loop
            if exists (select 1 from pg_roles where rolname = v_role) and has_function_privilege(v_role, r.fn, 'execute') then
                execute format('grant execute on function %s to %I', r.fn, v_role);
            end if;
        end loop;
        -- ログインしていない人の分だけ外す(「誰でも」の許可も外す)
        execute format('revoke execute on function %s from public', r.fn);
        if exists (select 1 from pg_roles where rolname = 'anon') then
            execute format('revoke execute on function %s from anon', r.fn);
        end if;
    end loop;
end $$;

-- ------------------------------------------------------------
-- 2. パスワード再設定URLの発行:スタッフ・管理者のアカウントにつながった店舗には発行しない
-- ------------------------------------------------------------
create or replace function public.neo_issue_password_reset(p_client_id text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_client public.clients%rowtype;
  v_token text;
  v_expires timestamptz := now() + interval '24 hours';
begin
  if not public.is_msm_staff() then raise exception 'not_allowed'; end if;
  select * into v_client from public.clients where id::text = p_client_id;
  if v_client.id is null then raise exception 'client_not_found'; end if;
  if v_client.auth_id is null then raise exception 'no_login_account'; end if;
  if exists (select 1 from public.staff_members s where s.auth_user_id::text = v_client.auth_id::text) then
    raise exception 'is_staff';
  end if;

  update public.neo_password_resets set used_at = now()
   where auth_id = v_client.auth_id::uuid and used_at is null;
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into public.neo_password_resets (token_hash, auth_id, client_id, created_by, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_client.auth_id::uuid, v_client.id::text, auth.uid(), v_expires);
  return json_build_object('token', v_token, 'company_name', v_client.company_name, 'email', v_client.email, 'expires_at', v_expires);
end;
$$;

-- ------------------------------------------------------------
-- 3. 再設定URLでパスワードを変えるとき:スタッフ・管理者のアカウントなら断る(使えないURLと同じ扱い)
-- ------------------------------------------------------------
create or replace function public.neo_check_password_reset(p_token text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_name text;
begin
  select c.company_name into v_name
    from public.neo_password_resets r
    left join public.clients c on c.auth_id::text = r.auth_id::text
   where r.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and r.used_at is null and r.expires_at > now()
     and not exists (select 1 from public.staff_members s where s.auth_user_id = r.auth_id)
   limit 1;
  if not found then return null; end if;
  return json_build_object('company_name', v_name);
end;
$$;

create or replace function public.neo_reset_password_with_token(p_token text, p_new_password text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_reset public.neo_password_resets%rowtype;
begin
  if char_length(coalesce(p_new_password, '')) < 8 then raise exception 'password_too_short'; end if;
  if octet_length(p_new_password) > 72 then raise exception 'password_too_long'; end if;
  select * into v_reset from public.neo_password_resets
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and used_at is null and expires_at > now()
   for update;
  if v_reset.id is null or exists (select 1 from public.staff_members s where s.auth_user_id = v_reset.auth_id) then
    perform pg_sleep(1);
    raise exception 'invalid_token';
  end if;
  update auth.users set encrypted_password = crypt(p_new_password, gen_salt('bf', 10)), updated_at = now()
   where id = v_reset.auth_id;
  update public.neo_password_resets set used_at = now() where id = v_reset.id;
  return true;
end;
$$;

-- すでに発行済みで、まだ使われていない「スタッフ・管理者のアカウントの再設定URL」を使えなくする
update public.neo_password_resets r set used_at = now()
 where r.used_at is null and exists (select 1 from public.staff_members s where s.auth_user_id = r.auth_id);

-- だれが呼べるか(これまでと同じ)
revoke all on function public.neo_issue_password_reset(text) from public, anon;
revoke all on function public.neo_check_password_reset(text) from public;
revoke all on function public.neo_reset_password_with_token(text, text) from public;
grant execute on function public.neo_issue_password_reset(text) to authenticated;
grant execute on function public.neo_check_password_reset(text) to anon, authenticated;
grant execute on function public.neo_reset_password_with_token(text, text) to anon, authenticated;
