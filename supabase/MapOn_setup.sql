-- ============================================================
-- MapOn 初期設定SQL(第0段階:権限の是正 + 第1段階:アンケート)
--
-- 使い方:Supabase の管理画面 → 左メニュー「SQL Editor」→「New query」
--         → このファイルの中身をすべて貼り付けて「Run」。
--         「Success. No rows returned」と出れば完了です。
--         何度実行しても大丈夫です(2回目以降は変更がありません)。
--
-- このSQLで行うこと
--   1. MSMスタッフを staff_members テーブルで管理する(浦田さんを最初の管理者として登録)
--   2. clients / MEO分析 / 費用対効果シート / 改善点ストック を「スタッフのみ」にする
--      (店舗オーナーは自店舗の clients 行だけ閲覧できる)
--   3. 申込フォームからの店舗登録を、DBのトリガーで行う(パスワードを clients に保存しない)
--   4. MapOn NEO(アンケート)のテーブル(neo_surveys / neo_survey_responses)と、公開ページ用の関数を作る
--      ※既存の表・関数と名前がぶつからないよう、すべて neo_ で始まる名前にしている
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. MSMスタッフ
-- ------------------------------------------------------------
create table if not exists public.staff_members (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role text not null default 'msm_staff' check (role in ('msm_admin', 'msm_staff')),
  created_at timestamptz not null default now()
);
alter table public.staff_members enable row level security;
revoke all on public.staff_members from anon;
grant select, insert, update, delete on public.staff_members to authenticated;

create or replace function public.is_msm_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff_members where auth_user_id = auth.uid());
$$;
revoke all on function public.is_msm_staff() from public;
grant execute on function public.is_msm_staff() to anon, authenticated;

create or replace function public.is_msm_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff_members where auth_user_id = auth.uid() and role = 'msm_admin');
$$;
revoke all on function public.is_msm_admin() from public;
grant execute on function public.is_msm_admin() to authenticated;

-- ログイン中の店舗オーナーの店舗ID(clients.id の型に合わせて作る)
do $$
declare id_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into id_type
  from pg_attribute a where a.attrelid = 'public.clients'::regclass and a.attname = 'id';
  execute format($f$
    create or replace function public.my_client_id()
    returns %s language sql stable security definer set search_path = public as $b$
      select id from public.clients where auth_id::text = auth.uid()::text limit 1;
    $b$;$f$, id_type);
end $$;
revoke all on function public.my_client_id() from public;
grant execute on function public.my_client_id() to authenticated;

drop policy if exists staff_members_self_select on public.staff_members;
create policy staff_members_self_select on public.staff_members
  for select to authenticated using (auth_user_id = auth.uid() or public.is_msm_admin());
drop policy if exists staff_members_admin_write on public.staff_members;
create policy staff_members_admin_write on public.staff_members
  for all to authenticated using (public.is_msm_admin()) with check (public.is_msm_admin());

insert into public.staff_members (auth_user_id, display_name, role)
select id, '浦田', 'msm_admin' from auth.users where email = 'urata@msm-jap.com'
on conflict (auth_user_id) do nothing;

-- ------------------------------------------------------------
-- 2. 既存テーブルの権限(RLS)
--    対象4テーブルの既存のポリシーを外してから作り直す。
--    (予約・メニュー・スタッフ・ブログのテーブルは変更しない)
-- ------------------------------------------------------------
do $$
declare
  t text;
  r record;
begin
  foreach t in array array['clients', 'keyword_analyses', 'cost_benefit_analyses', 'cb_improvement_stock'] loop
    -- まだ作られていない表は飛ばす
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    -- 今までの「誰が見られるか」の設定を外してから作り直す
    for r in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', r.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    if t = 'clients' then
      -- スタッフは全件、店舗オーナーは自分の行だけ閲覧
      create policy clients_staff_all on public.clients
        for all to authenticated using (public.is_msm_staff()) with check (public.is_msm_staff());
      create policy clients_owner_select on public.clients
        for select to authenticated using (auth_id::text = auth.uid()::text);
    else
      -- MEO分析・費用対効果シート・改善点ストック:スタッフのみ
      execute format(
        'create policy %I on public.%I for all to authenticated using (public.is_msm_staff()) with check (public.is_msm_staff())',
        t || '_staff_all', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3. 申込フォーム(signup-a/b/c)からの店舗登録
-- ------------------------------------------------------------
-- 氏名(申し込みフォームの「氏名」)を保存する列
alter table public.clients add column if not exists owner_name text;

create or replace function public.handle_mapon_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_plan text := meta->>'plan';
  v_company text := left(coalesce(nullif(trim(meta->>'company_name'), ''), '(店舗名未入力)'), 100);
  v_owner text := left(nullif(trim(meta->>'owner_name'), ''), 100);   -- 氏名(未入力なら null)
begin
  if meta->>'signup_source' is distinct from 'mapon_signup' then
    return new;  -- 申込フォーム以外で作られたユーザー(ライター等)は対象外
  end if;
  if v_plan not in ('A', 'B', 'C', 'D') then v_plan := null; end if;  -- D = MapOn NEO
  insert into public.clients (auth_id, company_name, owner_name, email, plan, status)
  values (new.id, v_company, v_owner, new.email, v_plan, '稼働中');
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_mapon_signup on auth.users;
create trigger on_auth_user_created_mapon_signup
  after insert on auth.users for each row execute function public.handle_mapon_signup();

-- ------------------------------------------------------------
-- 4. アンケート
-- ------------------------------------------------------------
-- 店舗の情報(AI下書きの第2段階で使う)
alter table public.clients add column if not exists features text;
alter table public.clients add column if not exists menu_text text;
alter table public.clients add column if not exists monthly_ai_limit integer not null default 300;

-- surveys.client_id は clients.id と同じ型にする
do $$
declare id_type text;
begin
  select format_type(a.atttypid, a.atttypmod) into id_type
  from pg_attribute a where a.attrelid = 'public.clients'::regclass and a.attname = 'id';
  execute format($f$
    create table if not exists public.neo_surveys (
      id uuid primary key default gen_random_uuid(),
      client_id %s not null references public.clients (id) on delete cascade,
      title text not null default '来店アンケート',
      intro_text text not null default '',
      google_review_url text,
      questions jsonb not null default '[]'::jsonb,
      is_published boolean not null default false,
      public_slug text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
      created_by uuid default auth.uid(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      constraint surveys_questions_is_array check (jsonb_typeof(questions) = 'array'),
      constraint surveys_publish_requires_review_url check (
        not is_published or (google_review_url is not null and google_review_url ~ '^https://[^\s/?#]+\.[^\s]+$')
      )
    )$f$, id_type);
end $$;
create index if not exists neo_surveys_client_id_idx on public.neo_surveys (client_id);

create table if not exists public.neo_survey_responses (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.neo_surveys (id) on delete cascade,
  submitted_at timestamptz not null default now(),
  answers jsonb not null default '{}'::jsonb,
  star_rating smallint check (star_rating between 1 and 5),
  ip_hash text,
  action_token uuid not null default gen_random_uuid(),
  review_action text check (review_action in ('copied_and_opened', 'copy_failed_opened', 'self_write', 'declined')),
  review_action_at timestamptz,
  draft_edited boolean
);
create index if not exists neo_survey_responses_survey_idx on public.neo_survey_responses (survey_id, submitted_at desc);
create index if not exists neo_survey_responses_ip_idx on public.neo_survey_responses (ip_hash, submitted_at desc);

create or replace function public.neo_touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists neo_surveys_touch_updated_at on public.neo_surveys;
create trigger neo_surveys_touch_updated_at before update on public.neo_surveys
  for each row execute function public.neo_touch_updated_at();

alter table public.neo_surveys enable row level security;
alter table public.neo_survey_responses enable row level security;
revoke all on public.neo_surveys, public.neo_survey_responses from anon;
grant select, insert, update, delete on public.neo_surveys, public.neo_survey_responses to authenticated;

drop policy if exists neo_surveys_staff_all on public.neo_surveys;
create policy neo_surveys_staff_all on public.neo_surveys
  for all to authenticated using (public.is_msm_staff()) with check (public.is_msm_staff());
-- 契約者(店舗オーナー)は、自分の店舗のアンケートを作成・編集・削除できる
drop policy if exists neo_surveys_owner_select on public.neo_surveys;
drop policy if exists neo_surveys_owner_all on public.neo_surveys;
create policy neo_surveys_owner_all on public.neo_surveys
  for all to authenticated using (client_id = public.my_client_id()) with check (client_id = public.my_client_id());

drop policy if exists neo_survey_responses_staff_all on public.neo_survey_responses;
create policy neo_survey_responses_staff_all on public.neo_survey_responses
  for all to authenticated using (public.is_msm_staff()) with check (public.is_msm_staff());
drop policy if exists neo_survey_responses_owner_select on public.neo_survey_responses;
create policy neo_survey_responses_owner_select on public.neo_survey_responses
  for select to authenticated using (
    exists (select 1 from public.neo_surveys s
            where s.id = survey_id and s.deleted_at is null and s.client_id = public.my_client_id())
  );

-- 一覧用の集計(見る人の権限=RLSで絞り込まれる)
create or replace view public.neo_survey_stats with (security_invoker = true) as
  select survey_id,
         count(*)::int as response_count,
         round(avg(star_rating)::numeric, 2) as avg_star,
         max(submitted_at) as last_submitted_at
  from public.neo_survey_responses
  group by survey_id;
revoke all on public.neo_survey_stats from anon;
grant select on public.neo_survey_stats to authenticated;

-- 公開ページ用:表示に必要な項目だけを返す(店舗の内部情報は返さない)
create or replace function public.neo_get_public_survey(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'store_name', c.company_name,
    'title', s.title,
    'intro_text', s.intro_text,
    'questions', s.questions
  )
  from public.neo_surveys s join public.clients c on c.id = s.client_id
  where s.public_slug = p_slug and s.is_published and s.deleted_at is null;
$$;

-- 公開ページ用:回答を受け付ける(入力チェック・回数制限つき)
create or replace function public.neo_submit_survey_response(p_slug text, p_answers jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_survey public.neo_surveys%rowtype;
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip text;
  v_ip_hash text;
  v_clean jsonb := '{}'::jsonb;
  v_star smallint;
  q jsonb;
  v_qid text; v_type text; v_required boolean; v_val jsonb; v_ids text[]; v_max int;
  v_resp public.neo_survey_responses%rowtype;
begin
  select * into v_survey from public.neo_surveys
  where public_slug = p_slug and is_published and deleted_at is null;
  if not found then
    raise exception 'survey_not_available' using errcode = 'P0001';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'invalid_answers' using errcode = 'P0001';
  end if;

  -- 回数制限(同じ回線から、同じアンケートに 10分で3件・1日20件まで)
  v_ip := coalesce(v_headers->>'cf-connecting-ip', split_part(v_headers->>'x-forwarded-for', ',', 1), v_headers->>'x-real-ip', '');
  v_ip_hash := encode(sha256(convert_to(trim(v_ip) || '|mapon-survey', 'UTF8')), 'hex');
  if trim(v_ip) <> '' then
    if (select count(*) from public.neo_survey_responses
        where ip_hash = v_ip_hash and survey_id = v_survey.id and submitted_at > now() - interval '10 minutes') >= 3
       or (select count(*) from public.neo_survey_responses
        where ip_hash = v_ip_hash and survey_id = v_survey.id and submitted_at > now() - interval '1 day') >= 20 then
      raise exception 'rate_limited' using errcode = 'P0001';
    end if;
  end if;

  -- 設問ごとの入力チェック(設問にない項目は保存しない)
  for q in select * from jsonb_array_elements(v_survey.questions) loop
    v_qid := q->>'id';
    v_type := q->>'type';
    v_required := coalesce((q->>'required')::boolean, false);
    v_val := p_answers -> v_qid;
    select coalesce(array_agg(o->>'id'), '{}') into v_ids from jsonb_array_elements(coalesce(q->'options', '[]'::jsonb)) o;

    if v_val is null or v_val = 'null'::jsonb
       or (jsonb_typeof(v_val) = 'string' and trim(v_val #>> '{}') = '')
       or (jsonb_typeof(v_val) = 'array' and jsonb_array_length(v_val) = 0) then
      if v_required then raise exception 'required_missing:%', v_qid using errcode = 'P0001'; end if;
      continue;
    end if;

    if v_type in ('short_text', 'long_text') then
      v_max := case when v_type = 'short_text' then 200 else 2000 end;
      if jsonb_typeof(v_val) <> 'string' or char_length(v_val #>> '{}') > v_max then
        raise exception 'invalid_value:%', v_qid using errcode = 'P0001';
      end if;
      v_clean := v_clean || jsonb_build_object(v_qid, trim(v_val #>> '{}'));
    elsif v_type in ('single', 'dropdown') then
      if jsonb_typeof(v_val) <> 'string' or not ((v_val #>> '{}') = any (v_ids)) then
        raise exception 'invalid_value:%', v_qid using errcode = 'P0001';
      end if;
      v_clean := v_clean || jsonb_build_object(v_qid, v_val);
    elsif v_type = 'multi' then
      if jsonb_typeof(v_val) <> 'array'
         or exists (select 1 from jsonb_array_elements(v_val) e
                    where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (v_ids))) then
        raise exception 'invalid_value:%', v_qid using errcode = 'P0001';
      end if;
      v_clean := v_clean || jsonb_build_object(v_qid, (select jsonb_agg(distinct e) from jsonb_array_elements(v_val) e));
    elsif v_type = 'stars' then
      if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric not in (1, 2, 3, 4, 5) then
        raise exception 'invalid_value:%', v_qid using errcode = 'P0001';
      end if;
      v_clean := v_clean || jsonb_build_object(v_qid, (v_val #>> '{}')::int);
      if v_star is null then v_star := (v_val #>> '{}')::smallint; end if;
    end if;
  end loop;

  insert into public.neo_survey_responses (survey_id, answers, star_rating, ip_hash)
  values (v_survey.id, v_clean, v_star, case when trim(v_ip) <> '' then v_ip_hash end)
  returning * into v_resp;

  -- 星の数は返さない(口コミ協力ページは、評価にかかわらず同じ内容を表示するため)
  return jsonb_build_object(
    'response_id', v_resp.id,
    'action_token', v_resp.action_token,
    'google_review_url', v_survey.google_review_url
  );
end;
$$;

-- 公開ページ用:「口コミ協力のお願い」ページでの行動を記録する
create or replace function public.neo_record_review_action(p_response_id uuid, p_token uuid, p_action text, p_edited boolean default null)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if p_action not in ('copied_and_opened', 'copy_failed_opened', 'self_write', 'declined') then
    return false;
  end if;
  update public.neo_survey_responses
     set review_action = p_action, review_action_at = now(), draft_edited = p_edited
   where id = p_response_id and action_token = p_token and submitted_at > now() - interval '1 day';
  return found;
end;
$$;

-- スタッフ用:アンケートの複製(GoogleクチコミURLも引き継ぐ。複製後は非公開)
create or replace function public.neo_duplicate_survey(p_survey_id uuid)
returns uuid language plpgsql volatile security invoker set search_path = public as $$
declare v_new uuid;
begin
  insert into public.neo_surveys (client_id, title, intro_text, google_review_url, questions, is_published)
  select client_id, title || '(コピー)', intro_text, google_review_url, questions, false
  from public.neo_surveys where id = p_survey_id and deleted_at is null
  returning id into v_new;
  if v_new is null then raise exception 'survey_not_found' using errcode = 'P0001'; end if;
  return v_new;
end;
$$;

revoke all on function public.neo_get_public_survey(text) from public;
revoke all on function public.neo_submit_survey_response(text, jsonb) from public;
revoke all on function public.neo_record_review_action(uuid, uuid, text, boolean) from public;
revoke all on function public.neo_duplicate_survey(uuid) from public;
grant execute on function public.neo_get_public_survey(text) to anon, authenticated;
grant execute on function public.neo_submit_survey_response(text, jsonb) to anon, authenticated;
grant execute on function public.neo_record_review_action(uuid, uuid, text, boolean) to anon, authenticated;
grant execute on function public.neo_duplicate_survey(uuid) to authenticated;

-- ------------------------------------------------------------
-- MapOn NEO の設定(設問の書き方ガイドのURL)
-- ------------------------------------------------------------
create table if not exists public.neo_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
alter table public.neo_settings enable row level security;
grant select, insert, update on public.neo_settings to authenticated;

-- ログインしている人(契約者・スタッフ)は読める。書き換えはMSMスタッフだけ。
drop policy if exists neo_settings_read on public.neo_settings;
create policy neo_settings_read on public.neo_settings
  for select to authenticated using (true);
drop policy if exists neo_settings_staff_write on public.neo_settings;
create policy neo_settings_staff_write on public.neo_settings
  for all to authenticated using (public.is_msm_staff()) with check (public.is_msm_staff());

insert into public.neo_settings (key, value) values ('question_guide_url', null)
  on conflict (key) do nothing;

-- ------------------------------------------------------------
-- MapOn NEO:設定画面からの店舗名の変更
-- ------------------------------------------------------------
create or replace function public.neo_update_store_name(p_client_id text, p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_count int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if v_name = '' then raise exception 'name_required'; end if;
  if char_length(v_name) > 100 then raise exception 'name_too_long'; end if;
  update public.clients set company_name = v_name
   where id::text = p_client_id
     and (public.is_msm_staff() or auth_id::text = auth.uid()::text);
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'not_allowed'; end if;
  return v_name;
end;
$$;
revoke all on function public.neo_update_store_name(text, text) from public;
grant execute on function public.neo_update_store_name(text, text) to authenticated;

-- ------------------------------------------------------------
-- MapOn NEO:設定画面からのログイン用メールアドレスの変更
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- パスワード再設定URL(マスター画面で発行)
-- ------------------------------------------------------------
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

-- ============================================================
-- 第2段階(2026/11):Google口コミURLの店舗設定 + AIによる口コミ文章の下書き
-- (追加SQL_8 と同じ内容)
-- ============================================================
-- ------------------------------------------------------------
-- A. Google口コミURLを「店舗設定」で管理する
-- ------------------------------------------------------------
alter table public.clients add column if not exists google_review_url text;
alter table public.clients add column if not exists monthly_ai_limit integer not null default 300;

-- これまでアンケートごとに設定していたURLを、店舗のURLとして引き継ぐ
-- (店舗のURLがまだ空のときだけ。公開中のアンケート → 最近更新したアンケートの順で選ぶ)
update public.clients c
   set google_review_url = x.url
  from (
    select distinct on (s.client_id) s.client_id, btrim(s.google_review_url) as url
      from public.neo_surveys s
     where s.deleted_at is null and btrim(coalesce(s.google_review_url, '')) ~ '^https://[^\s/?#]+\.[^\s]+$'
     order by s.client_id, s.is_published desc, s.updated_at desc
  ) x
 where c.id = x.client_id and btrim(coalesce(c.google_review_url, '')) = '';

-- 「公開するにはアンケートごとのURLが必要」という条件を外す
-- (URLは店舗設定で管理する。未設定の店舗では、お客様の画面に口コミのボタンを出さない)
alter table public.neo_surveys drop constraint if exists surveys_publish_requires_review_url;

-- 店舗設定の画面から、Google口コミURLを保存する(本人の店舗か、MSMスタッフだけ)
create or replace function public.neo_update_review_url(p_client_id text, p_url text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
  v_count int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if v_url <> '' and (v_url !~ '^https://[^\s/?#]+\.[^\s]+$' or char_length(v_url) > 500) then
    raise exception 'invalid_url';
  end if;
  update public.clients set google_review_url = nullif(v_url, '')
   where id::text = p_client_id
     and (public.is_msm_staff() or auth_id::text = auth.uid()::text);
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'not_allowed'; end if;
  return v_url;
end;
$$;
revoke all on function public.neo_update_review_url(text, text) from public;
grant execute on function public.neo_update_review_url(text, text) to authenticated;

-- 公開ページ用:表示に必要な項目だけを返す(店舗の内部情報は返さない)
-- review_enabled = その店舗にGoogle口コミURLが設定されているか(URLそのものは回答後に返す)
create or replace function public.neo_get_public_survey(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'store_name', c.company_name,
    'title', s.title,
    'intro_text', s.intro_text,
    'questions', s.questions,
    'review_enabled', coalesce(nullif(btrim(c.google_review_url), ''), nullif(btrim(s.google_review_url), '')) is not null
  )
  from public.neo_surveys s join public.clients c on c.id = s.client_id
  where s.public_slug = p_slug and s.is_published and s.deleted_at is null;
$$;

-- 公開ページ用:回答を受け付ける(入力チェック・回数制限つき)
create or replace function public.neo_submit_survey_response(p_slug text, p_answers jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_survey public.neo_surveys%rowtype;
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip text;
  v_ip_hash text;
  v_clean jsonb := '{}'::jsonb;
  v_star smallint;
  q jsonb;
  v_qid text; v_type text; v_required boolean; v_val jsonb; v_ids text[]; v_max int;
  v_resp public.neo_survey_responses%rowtype;
  v_review_url text;
begin
  select * into v_survey from public.neo_surveys
  where public_slug = p_slug and is_published and deleted_at is null;
  if not found then
    raise exception 'survey_not_available' using errcode = 'P0001';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'invalid_answers' using errcode = 'P0001';
  end if;

  -- 回数制限(同じ回線から、同じアンケートに 10分で3件・1日20件まで)
  v_ip := coalesce(v_headers->>'cf-connecting-ip', split_part(v_headers->>'x-forwarded-for', ',', 1), v_headers->>'x-real-ip', '');
  v_ip_hash := encode(sha256(convert_to(trim(v_ip) || '|mapon-survey', 'UTF8')), 'hex');
  if trim(v_ip) <> '' then
    if (select count(*) from public.neo_survey_responses
        where ip_hash = v_ip_hash and survey_id = v_survey.id and submitted_at > now() - interval '10 minutes') >= 3
       or (select count(*) from public.neo_survey_responses
        where ip_hash = v_ip_hash and survey_id = v_survey.id and submitted_at > now() - interval '1 day') >= 20 then
      raise exception 'rate_limited' using errcode = 'P0001';
    end if;
  end if;

  -- 設問ごとの入力チェック(設問にない項目は保存しない)
  for q in select * from jsonb_array_elements(v_survey.questions) loop
    v_qid := q->>'id';
    v_type := q->>'type';
    v_required := coalesce((q->>'required')::boolean, false);
    v_val := p_answers -> v_qid;
    select coalesce(array_agg(o->>'id'), '{}') into v_ids from jsonb_array_elements(coalesce(q->'options', '[]'::jsonb)) o;

    if v_val is null or v_val = 'null'::jsonb
       or (jsonb_typeof(v_val) = 'string' and trim(v_val #>> '{}') = '')
       or (jsonb_typeof(v_val) = 'array' and jsonb_array_length(v_val) = 0) then
      if v_required then raise exception 'required_missing:%', v_qid using errcode = 'P0001'; end if;
      continue;
    end if;

    if v_type in ('short_text', 'long_text') then
      v_max := case when v_type = 'short_text' then 200 else 2000 end;
      if jsonb_typeof(v_val) <> 'string' or char_length(v_val #>> '{}') > v_max then
        raise exception 'invalid_value:%', v_qid using errcode = 'P0001';
      end if;
      v_clean := v_clean || jsonb_build_object(v_qid, trim(v_val #>> '{}'));
    elsif v_type in ('single', 'dropdown') then
      if jsonb_typeof(v_val) <> 'string' or not ((v_val #>> '{}') = any (v_ids)) then
        raise exception 'invalid_value:%', v_qid using errcode = 'P0001';
      end if;
      v_clean := v_clean || jsonb_build_object(v_qid, v_val);
    elsif v_type = 'multi' then
      if jsonb_typeof(v_val) <> 'array'
         or exists (select 1 from jsonb_array_elements(v_val) e
                    where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (v_ids))) then
        raise exception 'invalid_value:%', v_qid using errcode = 'P0001';
      end if;
      v_clean := v_clean || jsonb_build_object(v_qid, (select jsonb_agg(distinct e) from jsonb_array_elements(v_val) e));
    elsif v_type = 'stars' then
      if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric not in (1, 2, 3, 4, 5) then
        raise exception 'invalid_value:%', v_qid using errcode = 'P0001';
      end if;
      v_clean := v_clean || jsonb_build_object(v_qid, (v_val #>> '{}')::int);
      if v_star is null then v_star := (v_val #>> '{}')::smallint; end if;
    end if;
  end loop;

  insert into public.neo_survey_responses (survey_id, answers, star_rating, ip_hash)
  values (v_survey.id, v_clean, v_star, case when trim(v_ip) <> '' then v_ip_hash end)
  returning * into v_resp;

  -- Google口コミURLは店舗設定のものを使う(未設定なら、以前アンケートごとに設定したURL)
  select coalesce(nullif(btrim(c.google_review_url), ''), nullif(btrim(v_survey.google_review_url), ''))
    into v_review_url from public.clients c where c.id = v_survey.client_id;

  -- 星の数は返さない(口コミ協力ページは、評価にかかわらず同じ内容を表示するため)
  return jsonb_build_object(
    'response_id', v_resp.id,
    'action_token', v_resp.action_token,
    'google_review_url', v_review_url
  );
end;
$$;

grant execute on function public.neo_get_public_survey(text) to anon, authenticated;
grant execute on function public.neo_submit_survey_response(text, jsonb) to anon, authenticated;

-- ------------------------------------------------------------
-- B. AIによる口コミ文章の下書き
-- ------------------------------------------------------------
-- 生成のたびに1行を記録する(月間の上限・1回答あたりの回数・店舗の履歴に使う)
create table if not exists public.neo_ai_drafts (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references public.neo_survey_responses (id) on delete cascade,
  client_id text not null,
  length text not null check (length in ('short', 'normal', 'long')),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  draft_text text,
  input_tokens integer,
  output_tokens integer,
  model text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists neo_ai_drafts_response_idx on public.neo_ai_drafts (response_id, created_at);
create index if not exists neo_ai_drafts_client_idx on public.neo_ai_drafts (client_id, created_at desc);

alter table public.neo_ai_drafts enable row level security;
revoke all on public.neo_ai_drafts from anon;
grant select on public.neo_ai_drafts to authenticated;
drop policy if exists neo_ai_drafts_staff_select on public.neo_ai_drafts;
create policy neo_ai_drafts_staff_select on public.neo_ai_drafts
  for select to authenticated using (public.is_msm_staff());
drop policy if exists neo_ai_drafts_owner_select on public.neo_ai_drafts;
create policy neo_ai_drafts_owner_select on public.neo_ai_drafts
  for select to authenticated using (client_id = public.my_client_id()::text);

-- 生成の開始:回答した本人(回答ID+合い言葉)だけが呼べる。上限を確認して、生成に必要な材料を返す。
--   1回答あたり最大4回(最初の1回+作り直し3回)/店舗ごとの月間上限(clients.monthly_ai_limit、初期値300)
create or replace function public.neo_draft_begin(p_response_id uuid, p_token uuid, p_length text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  c_max_per_response constant int := 4;
  v_resp public.neo_survey_responses%rowtype;
  v_survey public.neo_surveys%rowtype;
  v_client text;
  v_store text;
  v_limit int;
  v_used_resp int;
  v_used_month int;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
  v_id uuid;
begin
  if p_length is null or p_length not in ('short', 'normal', 'long') then
    raise exception 'invalid_length' using errcode = 'P0001';
  end if;
  select * into v_resp from public.neo_survey_responses
   where id = p_response_id and action_token = p_token and submitted_at > now() - interval '1 day';
  if not found then raise exception 'response_not_found' using errcode = 'P0001'; end if;
  select * into v_survey from public.neo_surveys where id = v_resp.survey_id;
  v_client := v_survey.client_id::text;
  select c.company_name, coalesce(c.monthly_ai_limit, 300) into v_store, v_limit
    from public.clients c where c.id = v_survey.client_id;

  -- 同じ店舗の生成が同時に走っても、上限の数え間違いが起きないようにする
  perform pg_advisory_xact_lock(hashtext('neo_ai:' || v_client));

  select count(*) into v_used_resp from public.neo_ai_drafts
   where response_id = p_response_id
     and (status = 'done' or (status = 'pending' and created_at > now() - interval '2 minutes'));
  if v_used_resp >= c_max_per_response then raise exception 'response_limit' using errcode = 'P0001'; end if;
  -- 失敗した分も含めて、1つの回答で試せるのは8回まで(失敗を繰り返してAIの利用料がかさむのを防ぐ)
  if (select count(*) from public.neo_ai_drafts where response_id = p_response_id) >= c_max_per_response * 2 then
    raise exception 'response_limit' using errcode = 'P0001';
  end if;

  select count(*) into v_used_month from public.neo_ai_drafts
   where client_id = v_client and created_at >= v_month_start
     and (status = 'done' or (status = 'pending' and created_at > now() - interval '2 minutes'));
  if v_used_month >= v_limit then raise exception 'monthly_limit' using errcode = 'P0001'; end if;

  insert into public.neo_ai_drafts (response_id, client_id, length) values (p_response_id, v_client, p_length)
  returning id into v_id;

  return jsonb_build_object(
    'draft_id', v_id,
    'store_name', v_store,
    'questions', v_survey.questions,
    'answers', v_resp.answers,
    'previous', coalesce((select jsonb_agg(d.draft_text order by d.created_at) from public.neo_ai_drafts d
                           where d.response_id = p_response_id and d.status = 'done'), '[]'::jsonb),
    'remaining', c_max_per_response - v_used_resp - 1
  );
end;
$$;

-- 生成の終了:結果(成功した文章、または失敗)を記録する
create or replace function public.neo_draft_finish(p_draft_id uuid, p_token uuid, p_ok boolean, p_text text,
                                                    p_input_tokens integer, p_output_tokens integer, p_model text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  update public.neo_ai_drafts d
     set status = case when p_ok then 'done' else 'failed' end,
         draft_text = case when p_ok then left(coalesce(p_text, ''), 1200) end,
         input_tokens = p_input_tokens, output_tokens = p_output_tokens,
         model = left(coalesce(p_model, ''), 60), finished_at = now()
    from public.neo_survey_responses r
   where d.id = p_draft_id and d.status = 'pending' and r.id = d.response_id and r.action_token = p_token;
  return found;
end;
$$;
revoke all on function public.neo_draft_begin(uuid, uuid, text) from public;
revoke all on function public.neo_draft_finish(uuid, uuid, boolean, text, integer, integer, text) from public;
grant execute on function public.neo_draft_begin(uuid, uuid, text) to anon, authenticated;
grant execute on function public.neo_draft_finish(uuid, uuid, boolean, text, integer, integer, text) to anon, authenticated;

-- ============================================================
-- 第3段階(2026/11):クーポンとルーレット(追加SQL_9 と同じ内容)
-- ============================================================
-- ------------------------------------------------------------
-- 1. 店舗が作るクーポン
-- ------------------------------------------------------------
create table if not exists public.neo_coupons (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  description text not null default '' check (char_length(description) <= 300),
  kind text not null check (kind in ('amount', 'percent', 'gift')),          -- 金額割引/割合割引/特典
  amount integer check (amount is null or amount between 1 and 1000000),     -- 円(金額割引)
  percent integer check (percent is null or percent between 1 and 100),      -- %(割合割引)
  cap_amount integer check (cap_amount is null or cap_amount between 1 and 1000000),  -- 割合割引の上限額(円)
  benefit text check (benefit is null or char_length(benefit) <= 100),       -- 特典の内容(例:ドリンク1杯無料)
  min_spend integer check (min_spend is null or min_spend between 0 and 10000000),    -- 利用できる最低金額(円)
  conditions text not null default '' check (char_length(conditions) <= 300),         -- そのほかの利用条件
  valid_days integer check (valid_days is null or valid_days between 1 and 730),      -- 発行から何日間使えるか
  valid_until date,                                                          -- この日まで使える
  issue_limit integer check (issue_limit is null or issue_limit between 1 and 1000000),  -- 発行できる枚数の上限(空欄=上限なし)
  is_active boolean not null default true,                                   -- 公開中か(false=下書き)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint neo_coupons_kind_fields check (
    (kind = 'amount' and amount is not null) or (kind = 'percent' and percent is not null)
    or (kind = 'gift' and btrim(coalesce(benefit, '')) <> '')),
  constraint neo_coupons_validity check (valid_days is not null or valid_until is not null)
);
create index if not exists neo_coupons_client_idx on public.neo_coupons (client_id, created_at desc);

drop trigger if exists neo_coupons_touch_updated_at on public.neo_coupons;
create trigger neo_coupons_touch_updated_at before update on public.neo_coupons
  for each row execute function public.neo_touch_updated_at();

alter table public.neo_coupons enable row level security;
revoke all on public.neo_coupons from anon;
grant select, insert, update on public.neo_coupons to authenticated;
drop policy if exists neo_coupons_staff_all on public.neo_coupons;
create policy neo_coupons_staff_all on public.neo_coupons
  for all to authenticated using (public.is_msm_staff()) with check (public.is_msm_staff());
drop policy if exists neo_coupons_owner_all on public.neo_coupons;
create policy neo_coupons_owner_all on public.neo_coupons
  for all to authenticated using (client_id = public.my_client_id()::text) with check (client_id = public.my_client_id()::text);

-- ------------------------------------------------------------
-- 2. アンケート回答のお礼の設定(店舗ごとに1行)
-- ------------------------------------------------------------
create table if not exists public.neo_reward_settings (
  client_id text primary key,
  mode text not null default 'none' check (mode in ('none', 'coupon', 'lottery')),   -- 出さない/決まったクーポン/ルーレット
  coupon_id uuid references public.neo_coupons (id),                                -- mode = coupon のとき出すクーポン
  claim_limit text not null default 'once' check (claim_limit in ('once', 'daily', 'unlimited')),  -- 同じ端末で受け取れる回数
  lottery jsonb not null default '{"prizes": []}'::jsonb,                           -- ルーレットの景品 [{id, coupon_id, percent, fallback}]
  avg_spend integer check (avg_spend is null or avg_spend between 1 and 10000000),  -- 平均客単価(景品表示法の目安の計算用)
  updated_at timestamptz not null default now()
);
alter table public.neo_reward_settings enable row level security;
revoke all on public.neo_reward_settings from anon;
grant select on public.neo_reward_settings to authenticated;   -- 保存は下の関数(内容の確認つき)で行う
drop policy if exists neo_reward_settings_staff_select on public.neo_reward_settings;
create policy neo_reward_settings_staff_select on public.neo_reward_settings
  for select to authenticated using (public.is_msm_staff());
drop policy if exists neo_reward_settings_owner_select on public.neo_reward_settings;
create policy neo_reward_settings_owner_select on public.neo_reward_settings
  for select to authenticated using (client_id = public.my_client_id()::text);

-- ------------------------------------------------------------
-- 3. お客様に発行したクーポン
-- ------------------------------------------------------------
create table if not exists public.neo_coupon_issues (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,            -- クーポン画面のURLに入る、推測できない長い文字
  code text not null,                    -- 画面に表示するクーポン番号
  client_id text not null,
  coupon_id uuid not null references public.neo_coupons (id),
  response_id uuid unique references public.neo_survey_responses (id) on delete set null,  -- 1つの回答につき1枚
  source text not null check (source in ('survey', 'lottery')),
  prize_id text,
  device_hash text,                      -- 同じ端末での受け取り回数を数えるための印(元の値は保存しない)
  snapshot jsonb not null,               -- 発行したときのクーポンの内容(あとで店舗が編集しても変わらない)
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists neo_coupon_issues_client_idx on public.neo_coupon_issues (client_id, issued_at desc);
create index if not exists neo_coupon_issues_coupon_idx on public.neo_coupon_issues (coupon_id);
create index if not exists neo_coupon_issues_device_idx on public.neo_coupon_issues (client_id, device_hash, issued_at desc);

alter table public.neo_coupon_issues enable row level security;
revoke all on public.neo_coupon_issues from anon;
grant select on public.neo_coupon_issues to authenticated;   -- 発行・利用は下の関数だけが行う
drop policy if exists neo_coupon_issues_staff_select on public.neo_coupon_issues;
create policy neo_coupon_issues_staff_select on public.neo_coupon_issues
  for select to authenticated using (public.is_msm_staff());
drop policy if exists neo_coupon_issues_owner_select on public.neo_coupon_issues;
create policy neo_coupon_issues_owner_select on public.neo_coupon_issues
  for select to authenticated using (client_id = public.my_client_id()::text);

-- クーポンごとの発行数・利用数(見る人の権限で絞り込まれる)
create or replace view public.neo_coupon_stats with (security_invoker = true) as
  select coupon_id, count(*)::int as issued_count, count(used_at)::int as used_count
  from public.neo_coupon_issues group by coupon_id;
revoke all on public.neo_coupon_stats from anon;
grant select on public.neo_coupon_stats to authenticated;

-- ------------------------------------------------------------
-- 4. 内部で使う部品(画面からは直接呼べない)
-- ------------------------------------------------------------
-- そのクーポンを、いま発行できるか(公開中・削除されていない・期限内・枚数の上限に達していない)
create or replace function public.neo_coupon_available(p_coupon_id uuid, p_client text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.neo_coupons c
     where c.id = p_coupon_id and c.client_id = p_client and c.is_active and c.deleted_at is null
       and (c.valid_until is null or c.valid_until >= (now() at time zone 'Asia/Tokyo')::date)
       and (c.issue_limit is null
            or (select count(*) from public.neo_coupon_issues i where i.coupon_id = c.id) < c.issue_limit));
$$;
revoke all on function public.neo_coupon_available(uuid, text) from public, anon, authenticated;

-- 発行するときに保存する、クーポンの内容
create or replace function public.neo_coupon_snapshot(p_coupon_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'name', c.name, 'description', c.description, 'kind', c.kind, 'amount', c.amount, 'percent', c.percent,
    'cap_amount', c.cap_amount, 'benefit', c.benefit, 'min_spend', c.min_spend, 'conditions', c.conditions)
  from public.neo_coupons c where c.id = p_coupon_id;
$$;
revoke all on function public.neo_coupon_snapshot(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. お礼の設定を保存する(店舗の本人か、MSMスタッフだけ。内容を確認してから保存する)
-- ------------------------------------------------------------
create or replace function public.neo_save_reward_settings(p_client_id text, p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_mode text := coalesce(p_settings->>'mode', 'none');
  v_limit text := coalesce(p_settings->>'claim_limit', 'once');
  v_coupon uuid := nullif(p_settings->>'coupon_id', '')::uuid;
  v_avg int := nullif(p_settings->>'avg_spend', '')::int;
  v_prizes jsonb := coalesce(p_settings->'prizes', '[]'::jsonb);
  v_clean jsonb := '[]'::jsonb;
  v_total int := 0;
  v_fallbacks int := 0;
  p jsonb; v_pc uuid; v_tenths int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from public.clients c where c.id::text = p_client_id
                  and (public.is_msm_staff() or c.auth_id::text = auth.uid()::text)) then
    raise exception 'not_allowed';
  end if;
  if v_mode not in ('none', 'coupon', 'lottery') then raise exception 'invalid_mode'; end if;
  if v_limit not in ('once', 'daily', 'unlimited') then raise exception 'invalid_limit'; end if;
  if v_avg is not null and (v_avg < 1 or v_avg > 10000000) then raise exception 'invalid_avg_spend'; end if;

  if v_mode = 'coupon' then
    if v_coupon is null or not exists (select 1 from public.neo_coupons c
        where c.id = v_coupon and c.client_id = p_client_id and c.deleted_at is null and c.is_active) then
      raise exception 'coupon_required';
    end if;
  end if;

  if jsonb_typeof(v_prizes) <> 'array' then raise exception 'invalid_prizes'; end if;
  if v_mode = 'lottery' or jsonb_array_length(v_prizes) > 0 then
    if jsonb_array_length(v_prizes) > 12 then raise exception 'too_many_prizes'; end if;
    for p in select * from jsonb_array_elements(v_prizes) loop
      v_pc := nullif(p->>'coupon_id', '')::uuid;
      v_tenths := round(coalesce((p->>'percent')::numeric, 0) * 10)::int;   -- 0.1%単位で扱う
      if v_pc is null or not exists (select 1 from public.neo_coupons c
          where c.id = v_pc and c.client_id = p_client_id and c.deleted_at is null and c.is_active) then
        raise exception 'prize_coupon_invalid';
      end if;
      if v_tenths < 1 or v_tenths > 1000 then raise exception 'prize_percent_invalid'; end if;
      if coalesce((p->>'fallback')::boolean, false) then
        v_fallbacks := v_fallbacks + 1;
        -- 上限に達した景品の代わりに出す景品(参加賞)は、枚数の上限なしのクーポンにする
        if exists (select 1 from public.neo_coupons c where c.id = v_pc and c.issue_limit is not null) then
          raise exception 'fallback_needs_no_limit';
        end if;
      end if;
      v_total := v_total + v_tenths;
      v_clean := v_clean || jsonb_build_array(jsonb_build_object(
        'id', coalesce(nullif(left(p->>'id', 40), ''), replace(gen_random_uuid()::text, '-', '')),
        'coupon_id', v_pc, 'percent', v_tenths / 10.0, 'fallback', coalesce((p->>'fallback')::boolean, false)));
    end loop;
    if v_mode = 'lottery' then
      if jsonb_array_length(v_prizes) < 2 then raise exception 'too_few_prizes'; end if;
      if v_total <> 1000 then raise exception 'percent_total_not_100'; end if;   -- 確率の合計は100%
      if v_fallbacks <> 1 then raise exception 'fallback_required'; end if;
    end if;
  end if;

  insert into public.neo_reward_settings (client_id, mode, coupon_id, claim_limit, lottery, avg_spend, updated_at)
  values (p_client_id, v_mode, v_coupon, v_limit, jsonb_build_object('prizes', v_clean), v_avg, now())
  on conflict (client_id) do update
    set mode = excluded.mode, coupon_id = excluded.coupon_id, claim_limit = excluded.claim_limit,
        lottery = excluded.lottery, avg_spend = excluded.avg_spend, updated_at = now();
  return (select to_jsonb(s) from public.neo_reward_settings s where s.client_id = p_client_id);
end;
$$;
revoke all on function public.neo_save_reward_settings(text, jsonb) from public;
grant execute on function public.neo_save_reward_settings(text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6. お客様の画面用:お礼があるかどうか(回答した本人だけが呼べる)
-- ------------------------------------------------------------
create or replace function public.neo_get_reward_info(p_response_id uuid, p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_client text;
  v_set public.neo_reward_settings%rowtype;
  v_issue public.neo_coupon_issues%rowtype;
  v_prizes jsonb;
begin
  select s.client_id::text into v_client
    from public.neo_survey_responses r join public.neo_surveys s on s.id = r.survey_id
   where r.id = p_response_id and r.action_token = p_token and r.submitted_at > now() - interval '1 day';
  if v_client is null then return jsonb_build_object('mode', 'none'); end if;

  -- すでに受け取っている場合は、そのクーポンを案内する
  select * into v_issue from public.neo_coupon_issues where response_id = p_response_id;
  if found then
    return jsonb_build_object('mode', 'claimed', 'issue_token', v_issue.token);
  end if;

  select * into v_set from public.neo_reward_settings where client_id = v_client;
  if not found or v_set.mode = 'none' then return jsonb_build_object('mode', 'none'); end if;

  if v_set.mode = 'coupon' then
    if not public.neo_coupon_available(v_set.coupon_id, v_client) then return jsonb_build_object('mode', 'none'); end if;
    return jsonb_build_object('mode', 'coupon');
  end if;

  -- ルーレット:景品の名前だけを返す(当選確率は返さない)
  select jsonb_agg(jsonb_build_object('id', p->>'id', 'label', c.name) order by ord) into v_prizes
    from jsonb_array_elements(v_set.lottery->'prizes') with ordinality as t(p, ord)
    join public.neo_coupons c on c.id = (p->>'coupon_id')::uuid;
  if v_prizes is null or jsonb_array_length(v_prizes) < 2 then return jsonb_build_object('mode', 'none'); end if;
  return jsonb_build_object('mode', 'lottery', 'prizes', v_prizes);
end;
$$;

-- ------------------------------------------------------------
-- 7. お客様の画面用:お礼を受け取る(クーポンの発行。ルーレットの抽選はここで行う)
--    ・1つの回答につき1回だけ。もう一度呼ばれたら、同じ結果を返す(再読み込みや通信のやり直しで引き直せない)
--    ・抽選の結果は、このサーバー側の処理だけで決まる(お客様の画面からは操作できない)
-- ------------------------------------------------------------
create or replace function public.neo_claim_reward(p_response_id uuid, p_token uuid, p_device text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_client text;
  v_set public.neo_reward_settings%rowtype;
  v_issue public.neo_coupon_issues%rowtype;
  v_coupon public.neo_coupons%rowtype;
  v_device_hash text;
  v_coupon_id uuid;
  v_prize_id text;
  v_source text;
  v_roll int; v_acc int := 0;
  v_fallback jsonb; p jsonb;
  v_token text; v_expires timestamptz;
  v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
begin
  select s.client_id::text into v_client
    from public.neo_survey_responses r join public.neo_surveys s on s.id = r.survey_id
   where r.id = p_response_id and r.action_token = p_token and r.submitted_at > now() - interval '1 day';
  if v_client is null then raise exception 'response_not_found' using errcode = 'P0001'; end if;

  -- 同じ店舗の発行を1件ずつ処理する(同時に押されても、枚数の上限や二重発行がずれない)
  perform pg_advisory_xact_lock(hashtext('neo_reward:' || v_client));

  select * into v_issue from public.neo_coupon_issues where response_id = p_response_id;
  if found then
    return jsonb_build_object('issue_token', v_issue.token, 'prize_id', v_issue.prize_id, 'source', v_issue.source,
                              'coupon', v_issue.snapshot, 'already', true);
  end if;

  select * into v_set from public.neo_reward_settings where client_id = v_client;
  if not found or v_set.mode = 'none' then raise exception 'reward_not_available' using errcode = 'P0001'; end if;

  -- 同じ端末での受け取り回数(端末の印が送られてきたときだけ確認できる)
  if p_device is not null and char_length(p_device) between 8 and 200 then
    v_device_hash := encode(sha256(convert_to(p_device || '|' || v_client, 'UTF8')), 'hex');
    if v_set.claim_limit = 'once' and exists (
         select 1 from public.neo_coupon_issues i where i.client_id = v_client and i.device_hash = v_device_hash) then
      raise exception 'limit_reached' using errcode = 'P0001';
    end if;
    if v_set.claim_limit = 'daily' and exists (
         select 1 from public.neo_coupon_issues i
          where i.client_id = v_client and i.device_hash = v_device_hash and i.issued_at >= v_today_start) then
      raise exception 'limit_reached' using errcode = 'P0001';
    end if;
  end if;

  if v_set.mode = 'coupon' then
    v_coupon_id := v_set.coupon_id; v_source := 'survey';
    if not public.neo_coupon_available(v_coupon_id, v_client) then
      raise exception 'reward_not_available' using errcode = 'P0001';
    end if;
  else
    -- 抽選:0〜999 の乱数を引き、景品ごとの確率(0.1%単位)を順に足していって、当たった景品を決める
    v_source := 'lottery';
    v_roll := (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000)::int;
    for p in select * from jsonb_array_elements(v_set.lottery->'prizes') loop
      if coalesce((p->>'fallback')::boolean, false) then v_fallback := p; end if;
      if v_coupon_id is null then
        v_acc := v_acc + round((p->>'percent')::numeric * 10)::int;
        if v_roll < v_acc then v_coupon_id := (p->>'coupon_id')::uuid; v_prize_id := p->>'id'; end if;
      end if;
    end loop;
    -- 当たった景品が上限に達している(または使えない)ときは、参加賞に切り替える。ほかの景品の確率は変えない。
    if v_coupon_id is null or not public.neo_coupon_available(v_coupon_id, v_client) then
      if v_fallback is null or not public.neo_coupon_available((v_fallback->>'coupon_id')::uuid, v_client) then
        raise exception 'reward_not_available' using errcode = 'P0001';
      end if;
      v_coupon_id := (v_fallback->>'coupon_id')::uuid; v_prize_id := v_fallback->>'id';
    end if;
  end if;

  select * into v_coupon from public.neo_coupons where id = v_coupon_id;
  -- 有効期限:「発行から○日」と「○月○日まで」の両方があるときは、早いほう
  v_expires := least(
    case when v_coupon.valid_days is not null then now() + make_interval(days => v_coupon.valid_days) end,
    case when v_coupon.valid_until is not null then ((v_coupon.valid_until + 1)::timestamp at time zone 'Asia/Tokyo') end);
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.neo_coupon_issues (token, code, client_id, coupon_id, response_id, source, prize_id, device_hash, snapshot, expires_at)
  values (v_token,
          upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
          v_client, v_coupon_id, p_response_id, v_source, v_prize_id, v_device_hash,
          public.neo_coupon_snapshot(v_coupon_id), v_expires)
  returning * into v_issue;

  return jsonb_build_object('issue_token', v_issue.token, 'prize_id', v_issue.prize_id, 'source', v_issue.source,
                            'coupon', v_issue.snapshot, 'already', false);
end;
$$;

-- ------------------------------------------------------------
-- 8. お客様の画面用:クーポンを表示する/利用済みにする(クーポンのURLを知っている人だけ)
-- ------------------------------------------------------------
create or replace function public.neo_get_coupon(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'store_name', c.company_name, 'coupon', i.snapshot, 'code', i.code,
    'issued_at', i.issued_at, 'expires_at', i.expires_at, 'used_at', i.used_at,
    'status', case when i.used_at is not null then 'used' when i.expires_at <= now() then 'expired' else 'unused' end)
  from public.neo_coupon_issues i join public.clients c on c.id::text = i.client_id
  where i.token = p_token and char_length(p_token) >= 32;
$$;

-- 「クーポンを使う」:未使用で期限内のときだけ、利用済みにする。同時に押されても、利用済みにできるのは1回だけ。
create or replace function public.neo_use_coupon(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_used timestamptz;
  v_issue public.neo_coupon_issues%rowtype;
begin
  update public.neo_coupon_issues set used_at = now()
   where token = p_token and char_length(p_token) >= 32 and used_at is null and expires_at > now()
  returning used_at into v_used;
  if found then return jsonb_build_object('ok', true, 'used_at', v_used); end if;

  select * into v_issue from public.neo_coupon_issues where token = p_token;
  if not found then raise exception 'coupon_not_found' using errcode = 'P0001'; end if;
  if v_issue.used_at is not null then raise exception 'already_used' using errcode = 'P0001'; end if;
  raise exception 'coupon_expired' using errcode = 'P0001';
end;
$$;

revoke all on function public.neo_get_reward_info(uuid, uuid) from public;
revoke all on function public.neo_claim_reward(uuid, uuid, text) from public;
revoke all on function public.neo_get_coupon(text) from public;
revoke all on function public.neo_use_coupon(text) from public;
grant execute on function public.neo_get_reward_info(uuid, uuid) to anon, authenticated;
grant execute on function public.neo_claim_reward(uuid, uuid, text) to anon, authenticated;
grant execute on function public.neo_get_coupon(text) to anon, authenticated;
grant execute on function public.neo_use_coupon(text) to anon, authenticated;

-- ============================================================
-- 第4段階(2026/11):会員証・ショップカード・スタンプ・持っているクーポン(追加SQL_10 と同じ内容)
-- ============================================================
-- ------------------------------------------------------------
-- 1. 発行したクーポンに「どの端末・どの会員が持っているか」を記録する列を足す
-- ------------------------------------------------------------
alter table public.neo_coupon_issues add column if not exists wallet_hash text;     -- 端末の印(元の値は保存しない)
alter table public.neo_coupon_issues add column if not exists member_id uuid;       -- 会員
alter table public.neo_coupon_issues add column if not exists stamp_round integer;  -- 何枚目のカードの特典か
alter table public.neo_coupon_issues add column if not exists stamp_at integer;     -- スタンプ何個目の特典か
alter table public.neo_coupon_issues drop constraint if exists neo_coupon_issues_source_check;
alter table public.neo_coupon_issues add constraint neo_coupon_issues_source_check
  check (source in ('survey', 'lottery', 'stamp'));
create index if not exists neo_coupon_issues_wallet_idx on public.neo_coupon_issues (client_id, wallet_hash) where wallet_hash is not null;
create index if not exists neo_coupon_issues_member_idx on public.neo_coupon_issues (member_id) where member_id is not null;
-- 同じ会員・同じカード・同じ個数の特典は1枚だけ
create unique index if not exists neo_coupon_issues_stamp_uidx on public.neo_coupon_issues (member_id, stamp_round, stamp_at) where source = 'stamp';

-- ------------------------------------------------------------
-- 2. ショップカードの設定(店舗ごとに1行)
-- ------------------------------------------------------------
create table if not exists public.neo_card_settings (
  client_id text primary key,
  card_key text not null unique,                                   -- 会員証のURLに入る、お店ごとの文字
  enabled boolean not null default false,                          -- 公開中か
  card_name text not null default 'ショップカード' check (char_length(btrim(card_name)) between 1 and 30),
  stamp_goal integer not null default 10 check (stamp_goal between 3 and 30),   -- カード1枚のスタンプの数
  rewards jsonb not null default '[]'::jsonb,                      -- 特典 [{at: スタンプの個数, coupon_id}]
  expire_months integer check (expire_months is null or expire_months between 1 and 60),  -- 最後のスタンプから何か月で消えるか(空=期限なし)
  join_notice text not null default '' check (char_length(join_notice) <= 1000),          -- 登録画面に出す、お店からの注意書き
  updated_at timestamptz not null default now()
);
alter table public.neo_card_settings enable row level security;
revoke all on public.neo_card_settings from anon;
revoke all on public.neo_card_settings from authenticated;
grant select on public.neo_card_settings to authenticated;         -- 保存は下の関数(内容の確認つき)で行う
drop policy if exists neo_card_settings_staff_select on public.neo_card_settings;
create policy neo_card_settings_staff_select on public.neo_card_settings
  for select to authenticated using (public.is_msm_staff());
drop policy if exists neo_card_settings_owner_select on public.neo_card_settings;
create policy neo_card_settings_owner_select on public.neo_card_settings
  for select to authenticated using (client_id = public.my_client_id()::text);

-- ------------------------------------------------------------
-- 3. スタンプ用QRコード(店舗ごとに、使えるものは1つ)
-- ------------------------------------------------------------
create table if not exists public.neo_stamp_qrs (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  token text not null unique,            -- QRコードのURLに入る文字
  expires_on date,                       -- この日まで読み取れる(空=期限なし)
  created_at timestamptz not null default now(),
  revoked_at timestamptz                 -- 作り直したときに、古いものを使えなくした日時
);
create unique index if not exists neo_stamp_qrs_active_uidx on public.neo_stamp_qrs (client_id) where revoked_at is null;
alter table public.neo_stamp_qrs enable row level security;
revoke all on public.neo_stamp_qrs from anon;
revoke all on public.neo_stamp_qrs from authenticated;
grant select on public.neo_stamp_qrs to authenticated;
drop policy if exists neo_stamp_qrs_staff_select on public.neo_stamp_qrs;
create policy neo_stamp_qrs_staff_select on public.neo_stamp_qrs
  for select to authenticated using (public.is_msm_staff());
drop policy if exists neo_stamp_qrs_owner_select on public.neo_stamp_qrs;
create policy neo_stamp_qrs_owner_select on public.neo_stamp_qrs
  for select to authenticated using (client_id = public.my_client_id()::text);

-- ------------------------------------------------------------
-- 4. 会員
-- ------------------------------------------------------------
create table if not exists public.neo_members (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  member_no integer not null,                                      -- 店舗ごとの通し番号(画面では A0001 の形)
  name text not null,
  phone_last4 text not null,                                       -- 電話番号の下4桁(全部の番号は下の表に分けて保管)
  stamps integer not null default 0 check (stamps >= 0),           -- いまのカードのスタンプの数
  cards_completed integer not null default 0 check (cards_completed >= 0),   -- いっぱいになったカードの枚数
  total_stamps integer not null default 0,
  last_stamp_at timestamptz,
  consent_at timestamptz not null,                                 -- 利用規約と個人情報の利用目的を確認した日時
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (client_id, member_no)
);
create index if not exists neo_members_client_idx on public.neo_members (client_id, created_at desc);
alter table public.neo_members enable row level security;
revoke all on public.neo_members from anon;
revoke all on public.neo_members from authenticated;
grant select on public.neo_members to authenticated;               -- 登録・変更は下の関数だけが行う
drop policy if exists neo_members_staff_select on public.neo_members;
create policy neo_members_staff_select on public.neo_members
  for select to authenticated using (public.is_msm_staff());
drop policy if exists neo_members_owner_select on public.neo_members;
create policy neo_members_owner_select on public.neo_members
  for select to authenticated using (client_id = public.my_client_id()::text);

-- 会員の電話番号(全部)と、会員専用URLの合い言葉。画面からは直接読めない(下の関数だけが使う)
create table if not exists public.neo_member_private (
  member_id uuid primary key references public.neo_members (id) on delete cascade,
  client_id text not null,
  phone text not null,
  member_key text not null unique,
  unique (client_id, phone)                                        -- 同じ店舗に、同じ電話番号は1人だけ
);
alter table public.neo_member_private enable row level security;
revoke all on public.neo_member_private from anon;
revoke all on public.neo_member_private from authenticated;

-- 会員証を表示できる端末(端末の印は、元の値を保存しない)
create table if not exists public.neo_member_devices (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.neo_members (id) on delete cascade,
  client_id text not null,
  device_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists neo_member_devices_active_uidx on public.neo_member_devices (client_id, device_hash) where revoked_at is null;
create index if not exists neo_member_devices_member_idx on public.neo_member_devices (member_id);
alter table public.neo_member_devices enable row level security;
revoke all on public.neo_member_devices from anon;
revoke all on public.neo_member_devices from authenticated;

-- カードの再発行(店頭でスタッフが出す、1回だけ使える合い言葉。元の値は保存しない)
create table if not exists public.neo_member_reissues (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.neo_members (id) on delete cascade,
  client_id text not null,
  code_hash text not null unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table public.neo_member_reissues enable row level security;
revoke all on public.neo_member_reissues from anon;
revoke all on public.neo_member_reissues from authenticated;

-- スタンプの履歴(QRで付いた・手で付けた・取り消した・期限切れ)
create table if not exists public.neo_stamp_events (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.neo_members (id) on delete cascade,
  client_id text not null,
  kind text not null check (kind in ('qr', 'manual', 'cancel', 'expire')),
  delta integer not null,
  stamps_after integer not null,
  round_after integer not null default 0,
  qr_id uuid,
  by_auth uuid,                          -- 手で操作した人(店舗またはMSMのログインID)
  note text,
  jst_date date not null default ((now() at time zone 'Asia/Tokyo')::date),
  created_at timestamptz not null default now()
);
-- 同じ会員がQRでスタンプを付けられるのは、1日1回
create unique index if not exists neo_stamp_events_daily_uidx on public.neo_stamp_events (member_id, jst_date) where kind = 'qr';
create index if not exists neo_stamp_events_member_idx on public.neo_stamp_events (member_id, created_at desc);
create index if not exists neo_stamp_events_client_idx on public.neo_stamp_events (client_id, created_at desc);
alter table public.neo_stamp_events enable row level security;
revoke all on public.neo_stamp_events from anon;
revoke all on public.neo_stamp_events from authenticated;
grant select on public.neo_stamp_events to authenticated;
drop policy if exists neo_stamp_events_staff_select on public.neo_stamp_events;
create policy neo_stamp_events_staff_select on public.neo_stamp_events
  for select to authenticated using (public.is_msm_staff());
drop policy if exists neo_stamp_events_owner_select on public.neo_stamp_events;
create policy neo_stamp_events_owner_select on public.neo_stamp_events
  for select to authenticated using (client_id = public.my_client_id()::text);

-- 会員に関する操作の記録(登録・再発行・電話番号の表示・削除など)
create table if not exists public.neo_member_logs (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  member_id uuid,
  action text not null,
  by_auth uuid,
  created_at timestamptz not null default now()
);
create index if not exists neo_member_logs_client_idx on public.neo_member_logs (client_id, created_at desc);
alter table public.neo_member_logs enable row level security;
revoke all on public.neo_member_logs from anon;
revoke all on public.neo_member_logs from authenticated;
grant select on public.neo_member_logs to authenticated;
drop policy if exists neo_member_logs_staff_select on public.neo_member_logs;
create policy neo_member_logs_staff_select on public.neo_member_logs
  for select to authenticated using (public.is_msm_staff());
drop policy if exists neo_member_logs_owner_select on public.neo_member_logs;
create policy neo_member_logs_owner_select on public.neo_member_logs
  for select to authenticated using (client_id = public.my_client_id()::text);

-- ------------------------------------------------------------
-- 5. 内部で使う部品(画面からは直接呼べない)
-- ------------------------------------------------------------
-- 端末の印(サーバーが発行した64文字)を、保存用の形に変える。形が違うものは null
create or replace function public.neo_dev_hash(p_device text)
returns text language sql immutable set search_path = public as $$
  select case when p_device ~ '^[0-9a-f]{64}$' then encode(sha256(convert_to(p_device, 'UTF8')), 'hex') end;
$$;
revoke all on function public.neo_dev_hash(text) from public, anon, authenticated;

-- ログイン中の人が、その店舗を管理できるか(店舗の本人か、MSMスタッフ)
create or replace function public.neo_can_manage(p_client_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.clients c where c.id::text = p_client_id
       and (public.is_msm_staff() or c.auth_id::text = auth.uid()::text));
$$;
revoke all on function public.neo_can_manage(text) from public, anon, authenticated;

-- 推測できない長い文字(64文字)
create or replace function public.neo_random_hex()
returns text language sql volatile set search_path = public as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;
revoke all on function public.neo_random_hex() from public, anon, authenticated;

-- お客様の画面に出す、お店とショップカードの内容
create or replace function public.neo_card_public(p_client text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'store_name', c.company_name,
    'card', case when s.client_id is null then jsonb_build_object('enabled', false)
      else jsonb_build_object(
        'enabled', s.enabled, 'key', s.card_key, 'name', s.card_name, 'goal', s.stamp_goal,
        'expire_months', s.expire_months, 'join_notice', s.join_notice,
        'rewards', coalesce((
          select jsonb_agg(jsonb_build_object('at', (r->>'at')::int, 'label', k.name, 'coupon', public.neo_coupon_snapshot(k.id)) order by (r->>'at')::int)
            from jsonb_array_elements(s.rewards) r join public.neo_coupons k on k.id = (r->>'coupon_id')::uuid), '[]'::jsonb)) end)
  from public.clients c left join public.neo_card_settings s on s.client_id = c.id::text
  where c.id::text = p_client;
$$;
revoke all on function public.neo_card_public(text) from public, anon, authenticated;

-- スタンプを増やす・減らす(特典のクーポンの発行と、カードがいっぱいになったときの切り替えもここで行う)
create or replace function public.neo_stamp_apply(p_member_id uuid, p_delta integer, p_kind text, p_qr_id uuid default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_m public.neo_members%rowtype;
  v_set public.neo_card_settings%rowtype;
  v_coupon public.neo_coupons%rowtype;
  v_goal int; v_i int; v_at int; v_cid uuid; v_tok text;
  v_completed int := 0;
  v_rewards jsonb := '[]'::jsonb;
  v_missed boolean := false;
  v_note text := p_note;
begin
  select * into v_m from public.neo_members where id = p_member_id and deleted_at is null for update;
  if not found then raise exception 'member_not_found' using errcode = 'P0001'; end if;
  select * into v_set from public.neo_card_settings where client_id = v_m.client_id;
  if not found then raise exception 'card_not_ready' using errcode = 'P0001'; end if;
  v_goal := v_set.stamp_goal;

  if p_delta > 0 then
    -- 有効期限が切れていたら、いまのカードのスタンプを0個に戻してから付ける
    if v_set.expire_months is not null and v_m.stamps > 0 and v_m.last_stamp_at is not null
       and v_m.last_stamp_at < now() - make_interval(months => v_set.expire_months) then
      insert into public.neo_stamp_events (member_id, client_id, kind, delta, stamps_after, round_after, note)
      values (v_m.id, v_m.client_id, 'expire', -v_m.stamps, 0, v_m.cards_completed, '有効期限切れ');
      v_m.stamps := 0;
    end if;
    -- クーポンの発行枚数の上限がずれないよう、同じ店舗の発行を1件ずつ処理する
    perform pg_advisory_xact_lock(hashtext('neo_reward:' || v_m.client_id));
    for v_i in 1..p_delta loop
      v_m.stamps := v_m.stamps + 1;
      v_m.total_stamps := v_m.total_stamps + 1;
      v_at := least(v_m.stamps, v_goal);
      select (r->>'coupon_id')::uuid into v_cid from jsonb_array_elements(v_set.rewards) r where (r->>'at')::int = v_at limit 1;
      if v_cid is not null then
        if public.neo_coupon_available(v_cid, v_m.client_id) then
          select * into v_coupon from public.neo_coupons where id = v_cid;
          v_tok := null;
          insert into public.neo_coupon_issues (token, code, client_id, coupon_id, source, snapshot, expires_at, member_id, stamp_round, stamp_at)
          values (public.neo_random_hex(),
                  upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
                  v_m.client_id, v_cid, 'stamp', public.neo_coupon_snapshot(v_cid),
                  least(case when v_coupon.valid_days is not null then now() + make_interval(days => v_coupon.valid_days) end,
                        case when v_coupon.valid_until is not null then ((v_coupon.valid_until + 1)::timestamp at time zone 'Asia/Tokyo') end),
                  v_m.id, v_m.cards_completed, v_at)
          on conflict (member_id, stamp_round, stamp_at) where source = 'stamp' do nothing
          returning token into v_tok;
          if v_tok is not null then
            v_rewards := v_rewards || jsonb_build_array(jsonb_build_object('at', v_at, 'label', v_coupon.name));
          end if;
        else
          v_missed := true;
        end if;
      end if;
      if v_m.stamps >= v_goal then
        v_m.cards_completed := v_m.cards_completed + 1;
        v_m.stamps := 0;
        v_completed := v_completed + 1;
      end if;
    end loop;
    v_m.last_stamp_at := now();
    if v_missed then
      v_note := btrim(coalesce(v_note, '') || ' 特典のクーポンを発行できませんでした(公開中でない、または発行枚数の上限に達しています)');
    end if;
  elsif p_delta < 0 then
    for v_i in 1..(-p_delta) loop
      if v_m.stamps > 0 then
        -- 取り消すスタンプで受け取った特典が未使用なら、その特典も取り消す
        delete from public.neo_coupon_issues
         where member_id = v_m.id and source = 'stamp' and stamp_round = v_m.cards_completed and stamp_at = v_m.stamps and used_at is null;
        v_m.stamps := v_m.stamps - 1;
      elsif v_m.cards_completed > 0 then
        v_m.cards_completed := v_m.cards_completed - 1;
        delete from public.neo_coupon_issues
         where member_id = v_m.id and source = 'stamp' and stamp_round = v_m.cards_completed and stamp_at = v_goal and used_at is null;
        v_m.stamps := v_goal - 1;
      else
        raise exception 'no_stamps' using errcode = 'P0001';
      end if;
      v_m.total_stamps := greatest(v_m.total_stamps - 1, 0);
    end loop;
  else
    raise exception 'invalid_delta' using errcode = 'P0001';
  end if;

  update public.neo_members
     set stamps = v_m.stamps, cards_completed = v_m.cards_completed, total_stamps = v_m.total_stamps, last_stamp_at = v_m.last_stamp_at
   where id = v_m.id;
  insert into public.neo_stamp_events (member_id, client_id, kind, delta, stamps_after, round_after, qr_id, by_auth, note)
  values (v_m.id, v_m.client_id, p_kind, p_delta, v_m.stamps, v_m.cards_completed, p_qr_id, auth.uid(), nullif(left(coalesce(v_note, ''), 200), ''));

  return jsonb_build_object('stamps', v_m.stamps, 'cards_completed', v_m.cards_completed, 'completed', v_completed,
                            'rewards', v_rewards, 'reward_missed', v_missed);
end;
$$;
revoke all on function public.neo_stamp_apply(uuid, integer, text, uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6. お客様の画面用:この端末が持っているクーポンと、会員証・ショップカードを表示する
--    ・端末の印(p_device)は、サーバーが発行したCookieの値。知らない人は、ほかの人の内容を見られない
--    ・お店は、アンケートのURL(p_slug)か、会員証のURL(p_card_key)で決まる
-- ------------------------------------------------------------
create or replace function public.neo_wallet_view(p_device text, p_slug text default null, p_card_key text default null, p_member_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_client text;
  v_hash text := public.neo_dev_hash(p_device);
  v_member public.neo_members%rowtype;
  v_set public.neo_card_settings%rowtype;
  v_out jsonb; v_coupons jsonb; v_mkey text;
  v_expired boolean := false;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if p_card_key is not null and char_length(p_card_key) between 8 and 64 then
    select client_id into v_client from public.neo_card_settings where card_key = p_card_key;
  end if;
  if v_client is null and p_slug is not null and char_length(p_slug) between 1 and 100 then
    select s.client_id::text into v_client from public.neo_surveys s where s.public_slug = p_slug and s.deleted_at is null limit 1;
  end if;
  if v_client is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  v_out := public.neo_card_public(v_client);
  select * into v_set from public.neo_card_settings where client_id = v_client;

  if v_hash is not null then
    select m.* into v_member from public.neo_member_devices d join public.neo_members m on m.id = d.member_id
     where d.client_id = v_client and d.device_hash = v_hash and d.revoked_at is null and m.deleted_at is null;
    -- 会員専用URLで開いたとき:この端末でも会員証を表示できるようにする
    if v_member.id is null and p_member_key is not null and p_member_key ~ '^[0-9a-f]{64}$' then
      select m.* into v_member from public.neo_member_private p join public.neo_members m on m.id = p.member_id
       where p.client_id = v_client and p.member_key = p_member_key and m.deleted_at is null;
      if v_member.id is not null then
        insert into public.neo_member_devices (member_id, client_id, device_hash) values (v_member.id, v_client, v_hash)
        on conflict (client_id, device_hash) where revoked_at is null do nothing;
        update public.neo_coupon_issues set member_id = v_member.id
         where client_id = v_client and wallet_hash = v_hash and member_id is null;
        insert into public.neo_member_logs (client_id, member_id, action) values (v_client, v_member.id, 'link_url');
      end if;
    end if;
    if v_member.id is not null then
      update public.neo_member_devices set last_seen_at = now()
       where client_id = v_client and device_hash = v_hash and revoked_at is null and last_seen_at < now() - interval '1 hour';
    end if;
  end if;

  select coalesce(jsonb_agg(x.j), '[]'::jsonb) into v_coupons from (
    select jsonb_build_object('token', i.token, 'coupon', i.snapshot, 'expires_at', i.expires_at, 'source', i.source) as j
      from public.neo_coupon_issues i
     where i.client_id = v_client and i.used_at is null and i.expires_at > now()
       and ((v_hash is not null and i.wallet_hash = v_hash) or (v_member.id is not null and i.member_id = v_member.id))
     order by i.expires_at, i.issued_at limit 30) x;

  if v_member.id is not null then
    select member_key into v_mkey from public.neo_member_private where member_id = v_member.id;
    v_expired := v_set.expire_months is not null and v_member.stamps > 0 and v_member.last_stamp_at is not null
                 and v_member.last_stamp_at < now() - make_interval(months => v_set.expire_months);
    v_out := v_out || jsonb_build_object('member', jsonb_build_object(
      'no', 'A' || lpad(v_member.member_no::text, 4, '0'),
      'name', v_member.name,
      'stamps', case when v_expired then 0 else v_member.stamps end,
      'cards_completed', v_member.cards_completed,
      'stamped_today', exists (select 1 from public.neo_stamp_events e where e.member_id = v_member.id and e.kind = 'qr' and e.jst_date = v_today),
      'stamps_expire_on', case when v_set.expire_months is not null and v_member.stamps > 0 and v_member.last_stamp_at is not null and not v_expired
                               then ((v_member.last_stamp_at + make_interval(months => v_set.expire_months)) at time zone 'Asia/Tokyo')::date end,
      'key', v_mkey,
      'history', (select coalesce(jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', e.kind, 'delta', e.delta)), '[]'::jsonb)
                    from (select created_at, kind, delta from public.neo_stamp_events where member_id = v_member.id order by created_at desc limit 8) e)));
  else
    v_out := v_out || jsonb_build_object('member', null);
  end if;
  return v_out || jsonb_build_object('ok', true, 'coupons', v_coupons);
end;
$$;

-- 受け取ったクーポンを、この端末(会員なら会員)に記録する。次にお店のQRコードを読み取ったときに表示される
create or replace function public.neo_wallet_attach(p_device text, p_issue_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_hash text := public.neo_dev_hash(p_device);
  v_issue public.neo_coupon_issues%rowtype;
  v_member uuid;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'reason', 'device_required'); end if;
  select * into v_issue from public.neo_coupon_issues where token = p_issue_token and char_length(p_issue_token) >= 32;
  if not found then return jsonb_build_object('ok', false, 'reason', 'coupon_not_found'); end if;
  select d.member_id into v_member from public.neo_member_devices d join public.neo_members m on m.id = d.member_id
   where d.client_id = v_issue.client_id and d.device_hash = v_hash and d.revoked_at is null and m.deleted_at is null;
  -- 先に記録した端末・会員が優先(あとからURLを開いた別の端末のものにはならない)
  update public.neo_coupon_issues
     set wallet_hash = coalesce(wallet_hash, v_hash), member_id = coalesce(member_id, v_member)
   where id = v_issue.id
     and ((wallet_hash is null and (member_id is null or member_id = v_member)) or wallet_hash = v_hash);
  select * into v_issue from public.neo_coupon_issues where id = v_issue.id;
  return jsonb_build_object('ok', true,
    'held', coalesce(v_issue.wallet_hash = v_hash, false) or coalesce(v_issue.member_id = v_member, false),
    'member', v_member is not null, 'source', v_issue.source,
    'card_key', (select s.card_key from public.neo_card_settings s where s.client_id = v_issue.client_id and s.enabled));
end;
$$;

-- ------------------------------------------------------------
-- 7. お客様の画面用:会員登録(名前と電話番号)
--    同じ電話番号がすでに登録されているときは、登録も表示もしない(店頭でスタッフが再発行する)
-- ------------------------------------------------------------
create or replace function public.neo_member_join(p_device text, p_card_key text, p_name text, p_phone text, p_consent boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_hash text := public.neo_dev_hash(p_device);
  v_set public.neo_card_settings%rowtype;
  v_name text; v_phone text; v_no int; v_id uuid;
begin
  if v_hash is null then return jsonb_build_object('status', 'device_required'); end if;
  select * into v_set from public.neo_card_settings where card_key = p_card_key and char_length(p_card_key) between 8 and 64;
  if not found or not v_set.enabled then return jsonb_build_object('status', 'card_disabled'); end if;

  if exists (select 1 from public.neo_member_devices d join public.neo_members m on m.id = d.member_id
              where d.client_id = v_set.client_id and d.device_hash = v_hash and d.revoked_at is null and m.deleted_at is null) then
    return jsonb_build_object('status', 'already_member');
  end if;

  v_name := btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:][:space:] ]+', ' ', 'g'));
  if char_length(v_name) < 1 or char_length(v_name) > 40 then return jsonb_build_object('status', 'invalid_name'); end if;
  -- 電話番号:全角の数字を半角に直し、数字以外(ハイフンなど)を取り除く
  v_phone := regexp_replace(translate(coalesce(p_phone, ''), '0123456789', '0123456789'), '[^0-9]', '', 'g');
  if v_phone ~ '^81[1-9][0-9]{8,9}$' then v_phone := '0' || substr(v_phone, 3); end if;
  if v_phone !~ '^0[0-9]{9,10}$' then return jsonb_build_object('status', 'invalid_phone'); end if;
  if not coalesce(p_consent, false) then return jsonb_build_object('status', 'consent_required'); end if;

  -- 同じ店舗の登録を1件ずつ処理する(会員番号と電話番号の重複を防ぐ)
  perform pg_advisory_xact_lock(hashtext('neo_member:' || v_set.client_id));
  -- いたずらで大量に登録・確認されないための上限(店舗ごと。1時間に60回、1日に300人まで)
  if (select count(*) from public.neo_member_logs l where l.client_id = v_set.client_id
        and l.action in ('join', 'join_duplicate') and l.created_at > now() - interval '1 hour') >= 60
     or (select count(*) from public.neo_member_logs l where l.client_id = v_set.client_id
        and l.action = 'join' and l.created_at > now() - interval '1 day') >= 300 then
    return jsonb_build_object('status', 'busy');
  end if;

  if exists (select 1 from public.neo_member_private p where p.client_id = v_set.client_id and p.phone = v_phone) then
    insert into public.neo_member_logs (client_id, action) values (v_set.client_id, 'join_duplicate');
    return jsonb_build_object('status', 'phone_exists');
  end if;

  select coalesce(max(member_no), 0) + 1 into v_no from public.neo_members where client_id = v_set.client_id;
  insert into public.neo_members (client_id, member_no, name, phone_last4, consent_at)
  values (v_set.client_id, v_no, v_name, right(v_phone, 4), now()) returning id into v_id;
  insert into public.neo_member_private (member_id, client_id, phone, member_key) values (v_id, v_set.client_id, v_phone, public.neo_random_hex());
  insert into public.neo_member_devices (member_id, client_id, device_hash) values (v_id, v_set.client_id, v_hash);
  insert into public.neo_member_logs (client_id, member_id, action) values (v_set.client_id, v_id, 'join');
  -- この端末がすでに持っているクーポンを、会員にひも付ける(機種変更のあとも引き継げる)
  update public.neo_coupon_issues set member_id = v_id
   where client_id = v_set.client_id and wallet_hash = v_hash and member_id is null;
  return jsonb_build_object('status', 'joined', 'member_no', 'A' || lpad(v_no::text, 4, '0'));
end;
$$;

-- ------------------------------------------------------------
-- 8. お客様の画面用:スタンプ用QRコードを読み取って、スタンプを付ける(同じ会員は1日1回)
-- ------------------------------------------------------------
create or replace function public.neo_stamp_by_qr(p_device text, p_qr text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_hash text := public.neo_dev_hash(p_device);
  v_qr public.neo_stamp_qrs%rowtype;
  v_set public.neo_card_settings%rowtype;
  v_member uuid;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_res jsonb;
begin
  select * into v_qr from public.neo_stamp_qrs where token = p_qr and char_length(p_qr) >= 16;
  if not found then return jsonb_build_object('status', 'qr_invalid'); end if;
  select * into v_set from public.neo_card_settings where client_id = v_qr.client_id;
  if not found or not v_set.enabled then return jsonb_build_object('status', 'card_disabled'); end if;
  -- 作り直す前の古いQRコード:スタンプは付けない(どのお店かは分かるので、会員証は表示できる)
  if v_qr.revoked_at is not null then return jsonb_build_object('status', 'qr_invalid', 'card_key', v_set.card_key); end if;
  if v_qr.expires_on is not null and v_qr.expires_on < v_today then
    return jsonb_build_object('status', 'qr_expired', 'card_key', v_set.card_key);
  end if;
  if v_hash is not null then
    select d.member_id into v_member from public.neo_member_devices d join public.neo_members m on m.id = d.member_id
     where d.client_id = v_qr.client_id and d.device_hash = v_hash and d.revoked_at is null and m.deleted_at is null;
  end if;
  if v_member is null then return jsonb_build_object('status', 'need_join', 'card_key', v_set.card_key); end if;

  -- 同じ会員の操作を1件ずつ処理する(同時に読み取っても、付くのは1個)
  perform 1 from public.neo_members where id = v_member for update;
  if exists (select 1 from public.neo_stamp_events e where e.member_id = v_member and e.kind = 'qr' and e.jst_date = v_today) then
    return jsonb_build_object('status', 'already_today', 'card_key', v_set.card_key);
  end if;
  v_res := public.neo_stamp_apply(v_member, 1, 'qr', v_qr.id, null);
  return v_res || jsonb_build_object('status', 'stamped', 'card_key', v_set.card_key);
end;
$$;

-- ------------------------------------------------------------
-- 9. お客様の画面用:店頭で再発行してもらったカードを、この端末で使えるようにする
--    ・合い言葉は1回だけ使える(15分以内)
--    ・それまでの端末と会員専用URLは使えなくなる(なくしたスマートフォンで使われない)
-- ------------------------------------------------------------
create or replace function public.neo_member_restore(p_device text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_hash text := public.neo_dev_hash(p_device);
  v_r public.neo_member_reissues%rowtype;
begin
  if v_hash is null then return jsonb_build_object('status', 'device_required'); end if;
  if p_code is null or p_code !~ '^[0-9a-f]{32,64}$' then return jsonb_build_object('status', 'code_invalid'); end if;
  select r.* into v_r from public.neo_member_reissues r join public.neo_members m on m.id = r.member_id
   where r.code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
     and r.used_at is null and r.expires_at > now() and m.deleted_at is null
   for update of r;
  if not found then return jsonb_build_object('status', 'code_invalid'); end if;

  update public.neo_member_reissues set used_at = now() where id = v_r.id;
  update public.neo_member_devices set revoked_at = now()
   where revoked_at is null and (member_id = v_r.member_id or (client_id = v_r.client_id and device_hash = v_hash));
  insert into public.neo_member_devices (member_id, client_id, device_hash) values (v_r.member_id, v_r.client_id, v_hash);
  update public.neo_member_private set member_key = public.neo_random_hex() where member_id = v_r.member_id;
  update public.neo_coupon_issues set member_id = v_r.member_id
   where client_id = v_r.client_id and wallet_hash = v_hash and member_id is null;
  insert into public.neo_member_logs (client_id, member_id, action) values (v_r.client_id, v_r.member_id, 'restore');
  return jsonb_build_object('status', 'restored',
    'card_key', (select s.card_key from public.neo_card_settings s where s.client_id = v_r.client_id));
end;
$$;

-- クーポンの表示に「何のクーポンか」(アンケートのお礼/抽選/ショップカードの特典)を足す
create or replace function public.neo_get_coupon(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'store_name', c.company_name, 'coupon', i.snapshot, 'code', i.code, 'source', i.source,
    'issued_at', i.issued_at, 'expires_at', i.expires_at, 'used_at', i.used_at,
    'status', case when i.used_at is not null then 'used' when i.expires_at <= now() then 'expired' else 'unused' end)
  from public.neo_coupon_issues i join public.clients c on c.id::text = i.client_id
  where i.token = p_token and char_length(p_token) >= 32;
$$;

-- ------------------------------------------------------------
-- 10. 店舗の管理画面用(店舗の本人か、MSMスタッフだけ)
-- ------------------------------------------------------------
-- 設定とスタンプ用QRコードを取り出す(まだ無ければ、ここで用意する)
create or replace function public.neo_card_settings_get(p_client_id text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.neo_can_manage(p_client_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  insert into public.neo_card_settings (client_id, card_key)
  values (p_client_id, substr(public.neo_random_hex(), 1, 20)) on conflict (client_id) do nothing;
  insert into public.neo_stamp_qrs (client_id, token)
  select p_client_id, substr(public.neo_random_hex(), 1, 32)
   where not exists (select 1 from public.neo_stamp_qrs q where q.client_id = p_client_id and q.revoked_at is null)
  on conflict do nothing;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from public.neo_card_settings s where s.client_id = p_client_id),
    'qr', (select jsonb_build_object('token', q.token, 'expires_on', q.expires_on, 'created_at', q.created_at)
             from public.neo_stamp_qrs q where q.client_id = p_client_id and q.revoked_at is null));
end;
$$;

-- ショップカードの設定を保存する(内容を確認してから保存する)
create or replace function public.neo_save_card_settings(p_client_id text, p_settings jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_enabled boolean := coalesce((p_settings->>'enabled')::boolean, false);
  v_name text := btrim(coalesce(p_settings->>'card_name', ''));
  v_goal int := nullif(p_settings->>'stamp_goal', '')::int;
  v_months int := nullif(p_settings->>'expire_months', '')::int;
  v_notice text := btrim(coalesce(p_settings->>'join_notice', ''));
  v_rewards jsonb := coalesce(p_settings->'rewards', '[]'::jsonb);
  v_clean jsonb := '[]'::jsonb;
  r jsonb; v_at int; v_cid uuid; v_seen int[] := '{}';
begin
  if not public.neo_can_manage(p_client_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then raise exception 'invalid_card_name' using errcode = 'P0001'; end if;
  if v_goal is null or v_goal < 3 or v_goal > 30 then raise exception 'invalid_goal' using errcode = 'P0001'; end if;
  if v_months is not null and (v_months < 1 or v_months > 60) then raise exception 'invalid_expire' using errcode = 'P0001'; end if;
  if char_length(v_notice) > 1000 then raise exception 'invalid_notice' using errcode = 'P0001'; end if;
  if jsonb_typeof(v_rewards) <> 'array' or jsonb_array_length(v_rewards) > 5 then raise exception 'invalid_rewards' using errcode = 'P0001'; end if;
  for r in select * from jsonb_array_elements(v_rewards) loop
    v_at := nullif(r->>'at', '')::int;
    v_cid := nullif(r->>'coupon_id', '')::uuid;
    if v_at is null or v_at < 1 or v_at > v_goal or v_at = any (v_seen) then raise exception 'reward_at_invalid' using errcode = 'P0001'; end if;
    if v_cid is null or not exists (select 1 from public.neo_coupons c
        where c.id = v_cid and c.client_id = p_client_id and c.deleted_at is null and c.is_active) then
      raise exception 'reward_coupon_invalid' using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_at;
    v_clean := v_clean || jsonb_build_array(jsonb_build_object('at', v_at, 'coupon_id', v_cid));
  end loop;

  perform public.neo_card_settings_get(p_client_id);   -- 行とスタンプ用QRコードを用意する
  update public.neo_card_settings
     set enabled = v_enabled, card_name = v_name, stamp_goal = v_goal, rewards = v_clean,
         expire_months = v_months, join_notice = v_notice, updated_at = now()
   where client_id = p_client_id;
  return (select to_jsonb(s) from public.neo_card_settings s where s.client_id = p_client_id);
end;
$$;

-- スタンプ用QRコード:作り直す(古いものは使えなくなる)/読み取り期限を変える
create or replace function public.neo_stamp_qr_update(p_client_id text, p_action text, p_expires_on date default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if not public.neo_can_manage(p_client_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if p_expires_on is not null and p_expires_on < v_today then raise exception 'expires_in_past' using errcode = 'P0001'; end if;
  if p_action = 'renew' then
    update public.neo_stamp_qrs set revoked_at = now() where client_id = p_client_id and revoked_at is null;
    insert into public.neo_stamp_qrs (client_id, token, expires_on) values (p_client_id, substr(public.neo_random_hex(), 1, 32), p_expires_on);
    insert into public.neo_member_logs (client_id, action, by_auth) values (p_client_id, 'qr_renew', auth.uid());
  elsif p_action = 'expiry' then
    update public.neo_stamp_qrs set expires_on = p_expires_on where client_id = p_client_id and revoked_at is null;
  else
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
  return (public.neo_card_settings_get(p_client_id))->'qr';
end;
$$;

-- 手でスタンプを付ける・取り消す(修正用。だれが操作したかを履歴に残す)
create or replace function public.neo_member_stamp_manual(p_member_id uuid, p_delta integer, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_client text;
begin
  select client_id into v_client from public.neo_members where id = p_member_id and deleted_at is null;
  if v_client is null or not public.neo_can_manage(v_client) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if p_delta is null or p_delta = 0 or p_delta < -30 or p_delta > 30 then raise exception 'invalid_delta' using errcode = 'P0001'; end if;
  return public.neo_stamp_apply(p_member_id, p_delta, case when p_delta > 0 then 'manual' else 'cancel' end, null, p_note);
end;
$$;

-- カードの再発行:お客様のスマートフォンで読み取ってもらう、1回だけ使える合い言葉を出す(15分間)
create or replace function public.neo_member_reissue(p_member_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_client text; v_code text; v_exp timestamptz := now() + interval '15 minutes';
begin
  select client_id into v_client from public.neo_members where id = p_member_id and deleted_at is null;
  if v_client is null or not public.neo_can_manage(v_client) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  -- 前に出した合い言葉は使えなくする
  update public.neo_member_reissues set expires_at = now() where member_id = p_member_id and used_at is null and expires_at > now();
  v_code := substr(public.neo_random_hex(), 1, 40);
  insert into public.neo_member_reissues (member_id, client_id, code_hash, created_by, expires_at)
  values (p_member_id, v_client, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), auth.uid(), v_exp);
  insert into public.neo_member_logs (client_id, member_id, action, by_auth) values (v_client, p_member_id, 'reissue', auth.uid());
  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end;
$$;

-- 電話番号を全部表示する(表示した操作を記録する)
create or replace function public.neo_member_reveal_phone(p_member_id uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  v_client text; v_phone text;
begin
  select client_id into v_client from public.neo_members where id = p_member_id and deleted_at is null;
  if v_client is null or not public.neo_can_manage(v_client) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  select phone into v_phone from public.neo_member_private where member_id = p_member_id;
  insert into public.neo_member_logs (client_id, member_id, action, by_auth) values (v_client, p_member_id, 'reveal_phone', auth.uid());
  return v_phone;
end;
$$;

-- 会員を削除する(名前と電話番号を消す。お客様から削除の申し出があったとき用)
create or replace function public.neo_member_delete(p_member_id uuid)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  v_client text;
begin
  select client_id into v_client from public.neo_members where id = p_member_id and deleted_at is null;
  if v_client is null or not public.neo_can_manage(v_client) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  delete from public.neo_member_private where member_id = p_member_id;
  update public.neo_member_devices set revoked_at = now() where member_id = p_member_id and revoked_at is null;
  update public.neo_member_reissues set expires_at = now() where member_id = p_member_id and used_at is null and expires_at > now();
  delete from public.neo_coupon_issues where member_id = p_member_id and source = 'stamp' and used_at is null;
  update public.neo_members set name = '(削除済み)', phone_last4 = '', deleted_at = now() where id = p_member_id;
  insert into public.neo_member_logs (client_id, member_id, action, by_auth) values (v_client, p_member_id, 'delete', auth.uid());
  return true;
end;
$$;

-- ------------------------------------------------------------
-- 11. だれが呼べるか
-- ------------------------------------------------------------
revoke all on function public.neo_wallet_view(text, text, text, text) from public;
revoke all on function public.neo_wallet_attach(text, text) from public;
revoke all on function public.neo_member_join(text, text, text, text, boolean) from public;
revoke all on function public.neo_stamp_by_qr(text, text) from public;
revoke all on function public.neo_member_restore(text, text) from public;
revoke all on function public.neo_get_coupon(text) from public;
grant execute on function public.neo_wallet_view(text, text, text, text) to anon, authenticated;
grant execute on function public.neo_wallet_attach(text, text) to anon, authenticated;
grant execute on function public.neo_member_join(text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.neo_stamp_by_qr(text, text) to anon, authenticated;
grant execute on function public.neo_member_restore(text, text) to anon, authenticated;
grant execute on function public.neo_get_coupon(text) to anon, authenticated;

revoke all on function public.neo_card_settings_get(text) from public, anon;
revoke all on function public.neo_save_card_settings(text, jsonb) from public, anon;
revoke all on function public.neo_stamp_qr_update(text, text, date) from public, anon;
revoke all on function public.neo_member_stamp_manual(uuid, integer, text) from public, anon;
revoke all on function public.neo_member_reissue(uuid) from public, anon;
revoke all on function public.neo_member_reveal_phone(uuid) from public, anon;
revoke all on function public.neo_member_delete(uuid) from public, anon;
grant execute on function public.neo_card_settings_get(text) to authenticated;
grant execute on function public.neo_save_card_settings(text, jsonb) to authenticated;
grant execute on function public.neo_stamp_qr_update(text, text, date) to authenticated;
grant execute on function public.neo_member_stamp_manual(uuid, integer, text) to authenticated;
grant execute on function public.neo_member_reissue(uuid) to authenticated;
grant execute on function public.neo_member_reveal_phone(uuid) to authenticated;
grant execute on function public.neo_member_delete(uuid) to authenticated;

-- ============================================================
-- 追加(2026/11):スタンプ100個までのカード/AIの口コミ文章の設定(追加SQL_11 と同じ内容)
-- ============================================================
-- ------------------------------------------------------------
-- 1. ショップカード:スタンプの数を100個まで
-- ------------------------------------------------------------
alter table public.neo_card_settings drop constraint if exists neo_card_settings_stamp_goal_check;
alter table public.neo_card_settings add constraint neo_card_settings_stamp_goal_check check (stamp_goal between 3 and 100);

create or replace function public.neo_save_card_settings(p_client_id text, p_settings jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_enabled boolean := coalesce((p_settings->>'enabled')::boolean, false);
  v_name text := btrim(coalesce(p_settings->>'card_name', ''));
  v_goal int := nullif(p_settings->>'stamp_goal', '')::int;
  v_months int := nullif(p_settings->>'expire_months', '')::int;
  v_notice text := btrim(coalesce(p_settings->>'join_notice', ''));
  v_rewards jsonb := coalesce(p_settings->'rewards', '[]'::jsonb);
  v_clean jsonb := '[]'::jsonb;
  r jsonb; v_at int; v_cid uuid; v_seen int[] := '{}';
begin
  if not public.neo_can_manage(p_client_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then raise exception 'invalid_card_name' using errcode = 'P0001'; end if;
  if v_goal is null or v_goal < 3 or v_goal > 100 then raise exception 'invalid_goal' using errcode = 'P0001'; end if;
  if v_months is not null and (v_months < 1 or v_months > 60) then raise exception 'invalid_expire' using errcode = 'P0001'; end if;
  if char_length(v_notice) > 1000 then raise exception 'invalid_notice' using errcode = 'P0001'; end if;
  if jsonb_typeof(v_rewards) <> 'array' or jsonb_array_length(v_rewards) > 5 then raise exception 'invalid_rewards' using errcode = 'P0001'; end if;
  for r in select * from jsonb_array_elements(v_rewards) loop
    v_at := nullif(r->>'at', '')::int;
    v_cid := nullif(r->>'coupon_id', '')::uuid;
    if v_at is null or v_at < 1 or v_at > v_goal or v_at = any (v_seen) then raise exception 'reward_at_invalid' using errcode = 'P0001'; end if;
    if v_cid is null or not exists (select 1 from public.neo_coupons c
        where c.id = v_cid and c.client_id = p_client_id and c.deleted_at is null and c.is_active) then
      raise exception 'reward_coupon_invalid' using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_at;
    v_clean := v_clean || jsonb_build_array(jsonb_build_object('at', v_at, 'coupon_id', v_cid));
  end loop;

  perform public.neo_card_settings_get(p_client_id);   -- 行とスタンプ用QRコードを用意する
  update public.neo_card_settings
     set enabled = v_enabled, card_name = v_name, stamp_goal = v_goal, rewards = v_clean,
         expire_months = v_months, join_notice = v_notice, updated_at = now()
   where client_id = p_client_id;
  return (select to_jsonb(s) from public.neo_card_settings s where s.client_id = p_client_id);
end;
$$;

create or replace function public.neo_member_stamp_manual(p_member_id uuid, p_delta integer, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_client text;
begin
  select client_id into v_client from public.neo_members where id = p_member_id and deleted_at is null;
  if v_client is null or not public.neo_can_manage(v_client) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if p_delta is null or p_delta = 0 or p_delta < -100 or p_delta > 100 then raise exception 'invalid_delta' using errcode = 'P0001'; end if;
  return public.neo_stamp_apply(p_member_id, p_delta, case when p_delta > 0 then 'manual' else 'cancel' end, null, p_note);
end;
$$;

-- ------------------------------------------------------------
-- 2. アンケートごとの「AIが作る口コミ文章の設定」
--    {"area": 地域名, "category": 業種, "keywords": [狙いたいキーワード]}
--    ・地域名と業種は、お店の事実として、毎回の文章に1回入る
--    ・キーワードは、お客様がその言葉を含む選択肢を選んだ(または自分で書いた)ときだけ、言い換えずに文章に入る
--    ・お客様の画面には出さない(文章を作るサーバー処理だけが使う)
-- ------------------------------------------------------------
alter table public.neo_surveys add column if not exists ai_settings jsonb not null default '{}'::jsonb;
alter table public.neo_surveys drop constraint if exists neo_surveys_ai_settings_check;
alter table public.neo_surveys add constraint neo_surveys_ai_settings_check
  check (jsonb_typeof(ai_settings) = 'object' and char_length(ai_settings::text) <= 3000);

-- 文章を作るときに、設定もいっしょに返す
create or replace function public.neo_draft_begin(p_response_id uuid, p_token uuid, p_length text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  c_max_per_response constant int := 4;
  v_resp public.neo_survey_responses%rowtype;
  v_survey public.neo_surveys%rowtype;
  v_client text;
  v_store text;
  v_limit int;
  v_used_resp int;
  v_used_month int;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
  v_id uuid;
begin
  if p_length is null or p_length not in ('short', 'normal', 'long') then
    raise exception 'invalid_length' using errcode = 'P0001';
  end if;
  select * into v_resp from public.neo_survey_responses
   where id = p_response_id and action_token = p_token and submitted_at > now() - interval '1 day';
  if not found then raise exception 'response_not_found' using errcode = 'P0001'; end if;
  select * into v_survey from public.neo_surveys where id = v_resp.survey_id;
  v_client := v_survey.client_id::text;
  select c.company_name, coalesce(c.monthly_ai_limit, 300) into v_store, v_limit
    from public.clients c where c.id = v_survey.client_id;

  -- 同じ店舗の生成が同時に走っても、上限の数え間違いが起きないようにする
  perform pg_advisory_xact_lock(hashtext('neo_ai:' || v_client));

  select count(*) into v_used_resp from public.neo_ai_drafts
   where response_id = p_response_id
     and (status = 'done' or (status = 'pending' and created_at > now() - interval '2 minutes'));
  if v_used_resp >= c_max_per_response then raise exception 'response_limit' using errcode = 'P0001'; end if;
  -- 失敗した分も含めて、1つの回答で試せるのは8回まで(失敗を繰り返してAIの利用料がかさむのを防ぐ)
  if (select count(*) from public.neo_ai_drafts where response_id = p_response_id) >= c_max_per_response * 2 then
    raise exception 'response_limit' using errcode = 'P0001';
  end if;

  select count(*) into v_used_month from public.neo_ai_drafts
   where client_id = v_client and created_at >= v_month_start
     and (status = 'done' or (status = 'pending' and created_at > now() - interval '2 minutes'));
  if v_used_month >= v_limit then raise exception 'monthly_limit' using errcode = 'P0001'; end if;

  insert into public.neo_ai_drafts (response_id, client_id, length) values (p_response_id, v_client, p_length)
  returning id into v_id;

  return jsonb_build_object(
    'draft_id', v_id,
    'store_name', v_store,
    'questions', v_survey.questions,
    'answers', v_resp.answers,
    'ai_settings', coalesce(v_survey.ai_settings, '{}'::jsonb),
    'previous', coalesce((select jsonb_agg(d.draft_text order by d.created_at) from public.neo_ai_drafts d
                           where d.response_id = p_response_id and d.status = 'done'), '[]'::jsonb),
    'remaining', c_max_per_response - v_used_resp - 1
  );
end;
$$;

-- アンケートを複製するときに、設定もいっしょに複製する
create or replace function public.neo_duplicate_survey(p_survey_id uuid)
returns uuid language plpgsql volatile security invoker set search_path = public as $$
declare v_new uuid;
begin
  insert into public.neo_surveys (client_id, title, intro_text, google_review_url, questions, ai_settings, is_published)
  select client_id, title || '(コピー)', intro_text, google_review_url, questions, ai_settings, false
  from public.neo_surveys where id = p_survey_id and deleted_at is null
  returning id into v_new;
  if v_new is null then raise exception 'survey_not_found' using errcode = 'P0001'; end if;
  return v_new;
end;
$$;

-- ------------------------------------------------------------
-- 3. だれが呼べるか(これまでと同じ)
-- ------------------------------------------------------------
revoke all on function public.neo_save_card_settings(text, jsonb) from public, anon;
revoke all on function public.neo_member_stamp_manual(uuid, integer, text) from public, anon;
grant execute on function public.neo_save_card_settings(text, jsonb) to authenticated;
grant execute on function public.neo_member_stamp_manual(uuid, integer, text) to authenticated;
revoke all on function public.neo_draft_begin(uuid, uuid, text) from public;
grant execute on function public.neo_draft_begin(uuid, uuid, text) to anon, authenticated;
revoke all on function public.neo_duplicate_survey(uuid) from public;
grant execute on function public.neo_duplicate_survey(uuid) to authenticated;
