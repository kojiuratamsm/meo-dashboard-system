-- ============================================================
-- 追加SQL_8:Google口コミURLを店舗設定へ移す + AIによる口コミ文章の下書き
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。既存の回答・アンケート・店舗のデータは削除しません。
--
-- 内容:
--  A. Google口コミURLを、アンケートごとではなく「店舗設定」で管理する
--     ・これまでアンケートに設定していたURLは、店舗のURLとして自動で引き継ぐ
--     ・「公開するにはURLが必要」という条件を外す(URLが未設定の店舗では、口コミのボタンを出さない)
--  B. AIによる口コミ文章の下書きに必要な表と関数を追加する
--
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
-- 実行時に「destructive operations」という確認が出ます(条件を1つ外す・権限を設定し直す命令が
-- 含まれるためです)。データは消えないので、そのまま「Run query」を押してください。
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
