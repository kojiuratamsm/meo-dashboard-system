-- ============================================================
-- 追加SQL_24:Lightの申し込みに「最寄駅」を追加
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。このSQLを実行しただけでは、データは何も消えません。
-- 前提:追加SQL_22(LINE名と利用規約と解約)を実行済みであること。
--
-- 内容:
--  ・clients.nearest_station … 申し込みのときに入力された最寄駅(Lightだけ。50文字まで)
--  ・handle_mapon_signup(申し込みの処理)に、最寄駅の保存を足す(追加SQL_22のものと同じで、最寄駅だけが増える)
--
-- 安全のための決まり:
--  ・最寄駅が空でも、データベースは断らない(入力の確認は申し込みページが行う)。
--    このため、MEO_UPLOAD のアップロードと、このSQLの実行は、どちらが先でも申し込みは止まらない。
--    (SQLより先にアップロードした場合、その間に申し込まれた店舗の最寄駅は保存されない)
--  ・有料(mapon_signup)の申し込みの処理は、追加SQL_22のまま変えない。
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
-- ============================================================

alter table public.clients add column if not exists nearest_station text;

create or replace function public.handle_mapon_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_source text := meta->>'signup_source';
  v_company text := left(coalesce(nullif(trim(meta->>'company_name'), ''), '(店舗名未入力)'), 100);
  v_owner text := left(nullif(trim(meta->>'owner_name'), ''), 100);
  v_line text := left(nullif(trim(meta->>'line_name'), ''), 100);
  v_station text := left(nullif(trim(meta->>'nearest_station'), ''), 50);
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
    insert into public.clients (auth_id, company_name, owner_name, email, plan, status, tier, line_name, nearest_station, terms_version, terms_agreed_at)
    values (new.id, v_company, v_owner, new.email, 'D', '稼働中', 'light', v_line, v_station, v_terms, now());
  end if;
  return new;
end;
$$;
