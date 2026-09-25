-- MapOn NEO:設定画面から、ログイン用メールアドレスを変更できるようにする(何度実行しても問題ありません)
-- ・確認メールは送らず、その場で変更する(Vercel や秘密鍵は不要)
-- ・契約者本人は「今のパスワード」で本人確認してから変更。MSMスタッフは店舗を指定して変更できる
-- ・ログイン用アカウント(auth.users / auth.identities)と clients のメールアドレスをそろえて変更する
begin;

create or replace function public.neo_change_login_email(p_new_email text, p_current_password text default null, p_client_id text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_email text := lower(btrim(coalesce(p_new_email, '')));
  v_client public.clients%rowtype;
  v_hash text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 254 then raise exception 'invalid_email'; end if;

  if p_client_id is not null then
    -- マスター(MSMスタッフ)が、指定した店舗のメールアドレスを変更する
    if not public.is_msm_staff() then raise exception 'not_allowed'; end if;
    select * into v_client from public.clients where id::text = p_client_id;
  else
    -- 契約者本人:今のパスワードで本人確認
    select encrypted_password into v_hash from auth.users where id = auth.uid();
    if coalesce(p_current_password, '') = '' or v_hash is null or crypt(p_current_password, v_hash) <> v_hash then
      perform pg_sleep(1);   -- 総当たり対策
      raise exception 'wrong_password';
    end if;
    select * into v_client from public.clients where auth_id::text = auth.uid()::text;
  end if;

  if v_client.id is null then raise exception 'client_not_found'; end if;
  if v_client.auth_id is null then raise exception 'no_login_account'; end if;
  if exists (select 1 from auth.users where id::text = v_client.auth_id::text and lower(email) = v_email) then raise exception 'same_email'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email and id::text <> v_client.auth_id::text)
     or exists (select 1 from public.clients where lower(email) = v_email and id <> v_client.id) then
    raise exception 'email_in_use';
  end if;

  update auth.users
     set email = v_email, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
   where id::text = v_client.auth_id::text;
  update auth.identities
     set identity_data = jsonb_set(coalesce(identity_data, '{}'::jsonb), '{email}', to_jsonb(v_email)), updated_at = now()
   where user_id::text = v_client.auth_id::text and provider = 'email';
  update public.clients set email = v_email where id = v_client.id;
  return v_email;
end;
$$;
revoke all on function public.neo_change_login_email(text, text, text) from public;
grant execute on function public.neo_change_login_email(text, text, text) to authenticated;

commit;
