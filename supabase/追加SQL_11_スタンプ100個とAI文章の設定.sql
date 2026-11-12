-- ============================================================
-- 追加SQL_11:スタンプ100個までのカード/AIの口コミ文章の設定(地域名・業種・キーワード)
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。既存のデータは変更・削除しません。
--
-- 内容:
--  ・ショップカードのスタンプの数を、3〜100個まで設定できるようにする(特典は、そのカードの中の好きな個数に付けられる)
--  ・手でスタンプを付ける・取り消す数を、1回につき100個までにする
--  ・アンケートごとに「AIが作る口コミ文章の設定」(地域名・業種・狙いたいキーワード)を保存できるようにする
--
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
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
