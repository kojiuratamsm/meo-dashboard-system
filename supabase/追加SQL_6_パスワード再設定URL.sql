-- MapOn: パスワードを忘れた人向けの「パスワード再設定URL」(何度実行しても問題ありません)
-- ・マスター画面でスタッフが店舗ごとにURLを発行し、本人に手動で送る(メールは送らない。Vercel も不要)
-- ・URLは1人1つ、24時間有効、1回だけ使える。新しく発行すると、前に発行した未使用のURLは使えなくなる
-- ・URLの中の番号(トークン)はデータベースに保存せず、ハッシュ値だけを保存する
begin;

create table if not exists public.neo_password_resets (
  id bigserial primary key,
  token_hash text not null unique,
  auth_id uuid not null,
  client_id text,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table public.neo_password_resets enable row level security;   -- ポリシーなし=画面から直接は読み書きできない
revoke all on public.neo_password_resets from anon, authenticated;

-- スタッフが発行する
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

  update public.neo_password_resets set used_at = now()
   where auth_id = v_client.auth_id::uuid and used_at is null;
  v_token := encode(gen_random_bytes(24), 'hex');
  insert into public.neo_password_resets (token_hash, auth_id, client_id, created_by, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_client.auth_id::uuid, v_client.id::text, auth.uid(), v_expires);
  return json_build_object('token', v_token, 'company_name', v_client.company_name, 'email', v_client.email, 'expires_at', v_expires);
end;
$$;

-- URLを開いたとき:使えるURLか確認し、店舗名を返す(使えなければ null)
create or replace function public.neo_check_password_reset(p_token text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_name text;
begin
  select c.company_name into v_name
    from public.neo_password_resets r
    left join public.clients c on c.auth_id::text = r.auth_id::text
   where r.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and r.used_at is null and r.expires_at > now()
   limit 1;
  if not found then return null; end if;
  return json_build_object('company_name', v_name);
end;
$$;

-- 新しいパスワードを設定する
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
  if v_reset.id is null then
    perform pg_sleep(1);
    raise exception 'invalid_token';
  end if;
  update auth.users set encrypted_password = crypt(p_new_password, gen_salt('bf', 10)), updated_at = now()
   where id = v_reset.auth_id;
  update public.neo_password_resets set used_at = now() where id = v_reset.id;
  return true;
end;
$$;

revoke all on function public.neo_issue_password_reset(text) from public;
revoke all on function public.neo_check_password_reset(text) from public;
revoke all on function public.neo_reset_password_with_token(text, text) from public;
grant execute on function public.neo_issue_password_reset(text) to authenticated;
grant execute on function public.neo_check_password_reset(text) to anon, authenticated;
grant execute on function public.neo_reset_password_with_token(text, text) to anon, authenticated;

commit;
