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
create or replace function public.handle_mapon_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_plan text := meta->>'plan';
  v_company text := left(coalesce(nullif(trim(meta->>'company_name'), ''), '(店舗名未入力)'), 100);
begin
  if meta->>'signup_source' is distinct from 'mapon_signup' then
    return new;  -- 申込フォーム以外で作られたユーザー(ライター等)は対象外
  end if;
  if v_plan not in ('A', 'B', 'C', 'D') then v_plan := null; end if;  -- D = MapOn NEO
  insert into public.clients (auth_id, company_name, email, plan, status)
  values (new.id, v_company, new.email, v_plan, '稼働中');
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

commit;
