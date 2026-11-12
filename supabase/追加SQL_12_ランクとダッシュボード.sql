-- ============================================================
-- 追加SQL_12:ショップカードのランク/店舗のダッシュボード/MSMの全店舗の状況
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。既存のデータは変更・削除しません。
-- 先に「追加SQL_11」まで実行してあることが必要です。
--
-- 内容:
--  ・ショップカードがいっぱいになったあとの動きを、店舗が選べるようにする
--      「また1個目から(同じカード)」/「ランクが上がる(会員証の色が変わる。ランクごとに特典を変えられる)」
--  ・店舗の管理画面の「ダッシュボード」用の集計(回答数・時間帯・お客様の流れ・会員・やること)
--  ・アンケートを開いた回数の記録(ダッシュボードの「お客様の流れ」に使う)
--  ・マスター画面の「全店舗の状況」用の集計
--
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
-- ============================================================

-- ------------------------------------------------------------
-- 1. ショップカード:いっぱいになったあとの動き(ランク)
--    full_mode … 'repeat'=また1個目から(これまでと同じ)/'rank'=ランクが上がる
--    ranks …… [{"name": ランクの名前, "color": 会員証の色, "rewards": null または [{at, coupon_id}]}]
--              1番目が最初のランク。rewards が null のランクは、基本の特典(rewards 列)を使う
--    ランクは「いっぱいになったカードの枚数」で決まる(1枚いっぱいで2番目のランク)。
--    いちばん上のランクでいっぱいになったら、同じランクのまま新しいカードが始まる。
-- ------------------------------------------------------------
alter table public.neo_card_settings add column if not exists full_mode text not null default 'repeat';
alter table public.neo_card_settings drop constraint if exists neo_card_settings_full_mode_check;
alter table public.neo_card_settings add constraint neo_card_settings_full_mode_check check (full_mode in ('repeat', 'rank'));
alter table public.neo_card_settings add column if not exists ranks jsonb not null default '[]'::jsonb;
alter table public.neo_card_settings drop constraint if exists neo_card_settings_ranks_check;
alter table public.neo_card_settings add constraint neo_card_settings_ranks_check
  check (jsonb_typeof(ranks) = 'array' and jsonb_array_length(ranks) <= 5 and char_length(ranks::text) <= 6000);

-- 何枚目のカードか(0始まり)から、ランクの番号(0始まり)を返す。ランクを使わない設定のときは null
create or replace function public.neo_card_rank_index(p_mode text, p_ranks jsonb, p_round integer)
returns integer language sql immutable set search_path = public as $$
  select case when p_mode = 'rank' and jsonb_typeof(p_ranks) = 'array' and jsonb_array_length(p_ranks) >= 2
              then least(greatest(coalesce(p_round, 0), 0), jsonb_array_length(p_ranks) - 1) end;
$$;
revoke all on function public.neo_card_rank_index(text, jsonb, integer) from public, anon, authenticated;

-- そのカード(何枚目か)で使う特典 [{at, coupon_id}]。最初のランクと、特典を決めていないランクは、基本の特典
create or replace function public.neo_card_round_rewards(p_mode text, p_ranks jsonb, p_base jsonb, p_round integer)
returns jsonb language sql immutable set search_path = public as $$
  select case
    when x.i is null or x.i = 0 then coalesce(p_base, '[]'::jsonb)
    when jsonb_typeof(p_ranks -> x.i -> 'rewards') = 'array' then p_ranks -> x.i -> 'rewards'
    else coalesce(p_base, '[]'::jsonb) end
  from (select public.neo_card_rank_index(p_mode, p_ranks, p_round) as i) x;
$$;
revoke all on function public.neo_card_round_rewards(text, jsonb, jsonb, integer) from public, anon, authenticated;

-- 特典を、お客様の画面に出す形にする [{at, label, coupon}]
create or replace function public.neo_card_rewards_public(p_rewards jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('at', (r->>'at')::int, 'label', k.name, 'coupon', public.neo_coupon_snapshot(k.id)) order by (r->>'at')::int)
      from jsonb_array_elements(coalesce(p_rewards, '[]'::jsonb)) r join public.neo_coupons k on k.id = (r->>'coupon_id')::uuid), '[]'::jsonb);
$$;
revoke all on function public.neo_card_rewards_public(jsonb) from public, anon, authenticated;

-- 特典の内容を確認して、保存する形にする(問題があれば止める)
create or replace function public.neo_card_clean_rewards(p_client_id text, p_rewards jsonb, p_goal integer, p_prefix text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb; v_at int; v_cid uuid; v_seen int[] := '{}'; v_clean jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_rewards) <> 'array' or jsonb_array_length(p_rewards) > 5 then
    raise exception '%', p_prefix || 'invalid_rewards' using errcode = 'P0001';
  end if;
  for r in select * from jsonb_array_elements(p_rewards) loop
    v_at := nullif(r->>'at', '')::int;
    v_cid := nullif(r->>'coupon_id', '')::uuid;
    if v_at is null or v_at < 1 or v_at > p_goal or v_at = any (v_seen) then
      raise exception '%', p_prefix || 'reward_at_invalid' using errcode = 'P0001';
    end if;
    if v_cid is null or not exists (select 1 from public.neo_coupons c
        where c.id = v_cid and c.client_id = p_client_id and c.deleted_at is null and c.is_active) then
      raise exception '%', p_prefix || 'reward_coupon_invalid' using errcode = 'P0001';
    end if;
    v_seen := v_seen || v_at;
    v_clean := v_clean || jsonb_build_array(jsonb_build_object('at', v_at, 'coupon_id', v_cid));
  end loop;
  return v_clean;
end;
$$;
revoke all on function public.neo_card_clean_rewards(text, jsonb, integer, text) from public, anon, authenticated;

-- お客様の画面に出す、お店とショップカードの内容(ランクを足した)
create or replace function public.neo_card_public(p_client text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'store_name', c.company_name,
    'card', case when s.client_id is null then jsonb_build_object('enabled', false)
      else jsonb_build_object(
        'enabled', s.enabled, 'key', s.card_key, 'name', s.card_name, 'goal', s.stamp_goal,
        'expire_months', s.expire_months, 'join_notice', s.join_notice,
        'rewards', public.neo_card_rewards_public(s.rewards),
        'full_mode', case when public.neo_card_rank_index(s.full_mode, s.ranks, 0) is null then 'repeat' else 'rank' end,
        'ranks', case when public.neo_card_rank_index(s.full_mode, s.ranks, 0) is null then '[]'::jsonb else (
          select jsonb_agg(jsonb_build_object('name', x.r->>'name', 'color', x.r->>'color',
                   'rewards', public.neo_card_rewards_public(public.neo_card_round_rewards(s.full_mode, s.ranks, s.rewards, (x.i - 1)::int))) order by x.i)
            from jsonb_array_elements(s.ranks) with ordinality x(r, i)) end) end)
  from public.clients c left join public.neo_card_settings s on s.client_id = c.id::text
  where c.id::text = p_client;
$$;
revoke all on function public.neo_card_public(text) from public, anon, authenticated;

-- スタンプを増やす・減らす(特典は、いまのランクのものを使う。ランクが上がったら、その内容を返す)
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
  v_rank_before int; v_rank_after int; v_rank_up jsonb;
begin
  select * into v_m from public.neo_members where id = p_member_id and deleted_at is null for update;
  if not found then raise exception 'member_not_found' using errcode = 'P0001'; end if;
  select * into v_set from public.neo_card_settings where client_id = v_m.client_id;
  if not found then raise exception 'card_not_ready' using errcode = 'P0001'; end if;
  v_goal := v_set.stamp_goal;
  v_rank_before := public.neo_card_rank_index(v_set.full_mode, v_set.ranks, v_m.cards_completed);

  if p_delta > 0 then
    -- 有効期限が切れていたら、いまのカードのスタンプを0個に戻してから付ける(ランクは下がらない)
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
      v_cid := null;
      select (r->>'coupon_id')::uuid into v_cid
        from jsonb_array_elements(public.neo_card_round_rewards(v_set.full_mode, v_set.ranks, v_set.rewards, v_m.cards_completed)) r
       where (r->>'at')::int = v_at limit 1;
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

  v_rank_after := public.neo_card_rank_index(v_set.full_mode, v_set.ranks, v_m.cards_completed);
  if v_rank_after is not null and v_rank_after > coalesce(v_rank_before, 0) then
    v_rank_up := jsonb_build_object('index', v_rank_after, 'name', v_set.ranks -> v_rank_after ->> 'name', 'color', v_set.ranks -> v_rank_after ->> 'color');
  end if;

  return jsonb_build_object('stamps', v_m.stamps, 'cards_completed', v_m.cards_completed, 'completed', v_completed,
                            'rewards', v_rewards, 'reward_missed', v_missed, 'rank', v_rank_after, 'rank_up', v_rank_up);
end;
$$;
revoke all on function public.neo_stamp_apply(uuid, integer, text, uuid, text) from public, anon, authenticated;

-- ショップカードの設定を保存する(「いっぱいになったあと」とランクを足した)
--   full_mode を送らない保存(古い画面からの保存)では、ランクの設定は変えない
create or replace function public.neo_save_card_settings(p_client_id text, p_settings jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_enabled boolean := coalesce((p_settings->>'enabled')::boolean, false);
  v_name text := btrim(coalesce(p_settings->>'card_name', ''));
  v_goal int := nullif(p_settings->>'stamp_goal', '')::int;
  v_months int := nullif(p_settings->>'expire_months', '')::int;
  v_notice text := btrim(coalesce(p_settings->>'join_notice', ''));
  v_rewards jsonb := coalesce(p_settings->'rewards', '[]'::jsonb);
  v_clean jsonb;
  v_has_mode boolean := p_settings ? 'full_mode';
  v_mode text := p_settings->>'full_mode';
  v_ranks jsonb := coalesce(p_settings->'ranks', '[]'::jsonb);
  v_clean_ranks jsonb := '[]'::jsonb;
  v_rank jsonb; v_rname text; v_rcolor text; v_rrewards jsonb; v_names text[] := '{}'; v_n int := 0;
begin
  if not public.neo_can_manage(p_client_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then raise exception 'invalid_card_name' using errcode = 'P0001'; end if;
  if v_goal is null or v_goal < 3 or v_goal > 100 then raise exception 'invalid_goal' using errcode = 'P0001'; end if;
  if v_months is not null and (v_months < 1 or v_months > 60) then raise exception 'invalid_expire' using errcode = 'P0001'; end if;
  if char_length(v_notice) > 1000 then raise exception 'invalid_notice' using errcode = 'P0001'; end if;
  v_clean := public.neo_card_clean_rewards(p_client_id, v_rewards, v_goal, '');

  if v_has_mode then
    if v_mode is null or v_mode not in ('repeat', 'rank') then raise exception 'invalid_full_mode' using errcode = 'P0001'; end if;
    if v_mode = 'rank' then
      if jsonb_typeof(v_ranks) <> 'array' or jsonb_array_length(v_ranks) < 2 or jsonb_array_length(v_ranks) > 5 then
        raise exception 'invalid_ranks' using errcode = 'P0001';
      end if;
      for v_rank in select * from jsonb_array_elements(v_ranks) loop
        v_rname := btrim(coalesce(v_rank->>'name', ''));
        v_rcolor := coalesce(v_rank->>'color', '');
        if char_length(v_rname) < 1 or char_length(v_rname) > 12 then raise exception 'invalid_rank_name' using errcode = 'P0001'; end if;
        if v_rname = any (v_names) then raise exception 'rank_name_duplicate' using errcode = 'P0001'; end if;
        if v_rcolor not in ('blue', 'green', 'red', 'purple', 'bronze', 'silver', 'gold', 'black') then
          raise exception 'invalid_rank_color' using errcode = 'P0001';
        end if;
        -- 最初のランクの特典は、基本の特典。2番目からは、そのランク専用の特典を決められる
        v_rrewards := null;
        if v_n > 0 and jsonb_typeof(v_rank->'rewards') = 'array' then
          v_rrewards := public.neo_card_clean_rewards(p_client_id, v_rank->'rewards', v_goal, 'rank_');
        end if;
        v_names := v_names || v_rname;
        v_clean_ranks := v_clean_ranks || jsonb_build_array(jsonb_build_object('name', v_rname, 'color', v_rcolor, 'rewards', v_rrewards));
        v_n := v_n + 1;
      end loop;
    end if;
  end if;

  perform public.neo_card_settings_get(p_client_id);   -- 行とスタンプ用QRコードを用意する
  update public.neo_card_settings
     set enabled = v_enabled, card_name = v_name, stamp_goal = v_goal, rewards = v_clean,
         expire_months = v_months, join_notice = v_notice,
         full_mode = case when v_has_mode then v_mode else full_mode end,
         ranks = case when v_has_mode and v_mode = 'rank' then v_clean_ranks else ranks end,
         updated_at = now()
   where client_id = p_client_id;
  return (select to_jsonb(s) from public.neo_card_settings s where s.client_id = p_client_id);
end;
$$;
revoke all on function public.neo_save_card_settings(text, jsonb) from public, anon;
grant execute on function public.neo_save_card_settings(text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 2. アンケートを開いた回数(アンケートごと・日ごと。だれが開いたかは記録しない)
-- ------------------------------------------------------------
create table if not exists public.neo_survey_views (
  survey_id uuid not null references public.neo_surveys (id) on delete cascade,
  jst_date date not null,
  views integer not null default 0,
  primary key (survey_id, jst_date)
);
alter table public.neo_survey_views enable row level security;
revoke all on public.neo_survey_views from anon;
revoke all on public.neo_survey_views from authenticated;

-- お客様の画面が、公開中のアンケートを開いたときに呼ぶ
create or replace function public.neo_survey_view(p_slug text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if p_slug is null or char_length(p_slug) < 1 or char_length(p_slug) > 100 then return false; end if;
  select id into v_id from public.neo_surveys where public_slug = p_slug and is_published and deleted_at is null;
  if v_id is null then return false; end if;
  insert into public.neo_survey_views as v (survey_id, jst_date, views)
  values (v_id, (now() at time zone 'Asia/Tokyo')::date, 1)
  on conflict (survey_id, jst_date) do update set views = v.views + 1 where v.views < 1000000;
  return true;
end;
$$;
revoke all on function public.neo_survey_view(text) from public;
grant execute on function public.neo_survey_view(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. 店舗のダッシュボード(店舗の本人か、MSMスタッフだけ)
--    日付と時間は、すべて日本時間で数える。件数は、データベースの中で数える(一覧の件数の上限に影響されない)
-- ------------------------------------------------------------
create or replace function public.neo_dashboard(p_client_id text, p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_days int := case when p_days in (7, 30, 90) then p_days else 30 end;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_from date;
  v_from_ts timestamptz;
  v_prev_ts timestamptz;
  v_month_ts timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
  v_surveys uuid[];
  v_client public.clients%rowtype;
  v_set public.neo_card_settings%rowtype;
  v_resp int; v_resp_prev int;
  v_daily jsonb; v_cells jsonb;
  v_f_resp int; v_f_draft int; v_f_coupon int; v_f_used int;
  v_views bigint; v_views_from date;
  v_drafts int; v_drafts_month int;
  v_m_total int; v_m_new int; v_m_prev int; v_m_stamped int; v_m_repeat int; v_m_reward int;
  v_c_issued int; v_c_used int;
  v_stamps int;
  v_ranks jsonb := null;
  v_rank_on boolean;
  v_qr_expires date;
  v_pub int; v_no_ai jsonb; v_review_ok boolean; v_reward_mode text;
  v_reward_count int := 0; v_reward_bad int := 0;
begin
  if not public.neo_can_manage(p_client_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  v_from := v_today - (v_days - 1);
  v_from_ts := (v_from::timestamp at time zone 'Asia/Tokyo');
  v_prev_ts := ((v_from - v_days)::timestamp at time zone 'Asia/Tokyo');
  select * into v_client from public.clients where id::text = p_client_id;
  select coalesce(array_agg(id), '{}') into v_surveys from public.neo_surveys where client_id::text = p_client_id and deleted_at is null;
  select * into v_set from public.neo_card_settings where client_id = p_client_id;

  -- アンケートの回答(この期間と、その前の同じ長さの期間)
  select count(*) filter (where submitted_at >= v_from_ts), count(*) filter (where submitted_at < v_from_ts)
    into v_resp, v_resp_prev
    from public.neo_survey_responses where survey_id = any (v_surveys) and submitted_at >= v_prev_ts;

  -- 日ごと(回答がない日は0件)
  select jsonb_agg(jsonb_build_object('d', to_char(g.d, 'YYYY-MM-DD'), 'n', coalesce(x.n, 0)) order by g.d) into v_daily
    from generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') g(d)
    left join (select (submitted_at at time zone 'Asia/Tokyo')::date as d, count(*)::int as n
                 from public.neo_survey_responses where survey_id = any (v_surveys) and submitted_at >= v_from_ts group by 1) x
      on x.d = g.d::date;

  -- 日ごと・時間帯ごと [何日目(0始まり), 時(0〜23), 件数]。回答がある所だけ
  select coalesce(jsonb_agg(jsonb_build_array(x.d - v_from, x.h, x.n) order by x.d, x.h), '[]'::jsonb) into v_cells
    from (select (submitted_at at time zone 'Asia/Tokyo')::date as d,
                 extract(hour from submitted_at at time zone 'Asia/Tokyo')::int as h, count(*)::int as n
            from public.neo_survey_responses where survey_id = any (v_surveys) and submitted_at >= v_from_ts group by 1, 2) x;

  -- お客様の流れ(この期間に回答した人が、その後どこまで進んだか)
  select count(*)::int,
         (count(*) filter (where exists (select 1 from public.neo_ai_drafts d where d.response_id = r.id and d.status = 'done')))::int,
         count(i.id)::int, count(i.used_at)::int
    into v_f_resp, v_f_draft, v_f_coupon, v_f_used
    from public.neo_survey_responses r left join public.neo_coupon_issues i on i.response_id = r.id
   where r.survey_id = any (v_surveys) and r.submitted_at >= v_from_ts;

  -- アンケートを開いた回数
  select coalesce(sum(views), 0) into v_views from public.neo_survey_views where survey_id = any (v_surveys) and jst_date >= v_from;
  select min(jst_date) into v_views_from from public.neo_survey_views where survey_id = any (v_surveys);

  -- AIの文章(作り直しも1回と数える)
  select (count(*) filter (where created_at >= v_from_ts))::int, (count(*) filter (where created_at >= v_month_ts))::int
    into v_drafts, v_drafts_month
    from public.neo_ai_drafts where client_id = p_client_id and status = 'done' and created_at >= least(v_from_ts, v_month_ts);

  -- 会員
  select count(*)::int, (count(*) filter (where created_at >= v_from_ts))::int,
         (count(*) filter (where created_at >= v_prev_ts and created_at < v_from_ts))::int
    into v_m_total, v_m_new, v_m_prev
    from public.neo_members where client_id = p_client_id and deleted_at is null;
  -- スタンプが付いた日が1日以上・2日以上ある会員(2日以上=もう一度来店した会員)
  select count(*)::int, (count(*) filter (where x.days >= 2))::int into v_m_stamped, v_m_repeat
    from (select e.member_id, count(distinct e.jst_date) as days
            from public.neo_stamp_events e join public.neo_members m on m.id = e.member_id and m.deleted_at is null
           where e.client_id = p_client_id and e.kind in ('qr', 'manual') and e.delta > 0 group by e.member_id) x;
  select coalesce(sum(delta), 0)::int into v_stamps
    from public.neo_stamp_events where client_id = p_client_id and kind in ('qr', 'manual') and delta > 0 and created_at >= v_from_ts;

  -- クーポン(この期間に発行したものと、そのうち使われたもの。特典のクーポンも含む)
  select count(*)::int, count(used_at)::int, (count(distinct member_id) filter (where source = 'stamp'))::int
    into v_c_issued, v_c_used, v_m_reward
    from public.neo_coupon_issues where client_id = p_client_id and issued_at >= v_from_ts;

  -- ランクごとの会員数
  v_rank_on := v_set.client_id is not null and public.neo_card_rank_index(v_set.full_mode, v_set.ranks, 0) is not null;
  if v_rank_on then
    select jsonb_agg(jsonb_build_object('name', x.r->>'name', 'color', x.r->>'color',
             'n', (select count(*) from public.neo_members m where m.client_id = p_client_id and m.deleted_at is null
                     and public.neo_card_rank_index(v_set.full_mode, v_set.ranks, m.cards_completed) = (x.i - 1)::int)) order by x.i)
      into v_ranks from jsonb_array_elements(v_set.ranks) with ordinality x(r, i);
  end if;

  -- やること(設定の抜け)
  select count(*)::int into v_pub from public.neo_surveys where id = any (v_surveys) and is_published;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title) order by s.created_at), '[]'::jsonb) into v_no_ai
    from public.neo_surveys s
   where s.id = any (v_surveys) and s.is_published
     and btrim(coalesce(s.ai_settings->>'area', '')) = '' and btrim(coalesce(s.ai_settings->>'category', '')) = ''
     and (jsonb_typeof(s.ai_settings->'keywords') is distinct from 'array' or jsonb_array_length(s.ai_settings->'keywords') = 0);
  v_review_ok := btrim(coalesce(v_client.google_review_url, '')) <> ''
     or exists (select 1 from public.neo_surveys s where s.id = any (v_surveys) and btrim(coalesce(s.google_review_url, '')) <> '');
  select mode into v_reward_mode from public.neo_reward_settings where client_id = p_client_id;
  if v_set.client_id is not null then
    select q.expires_on into v_qr_expires from public.neo_stamp_qrs q where q.client_id = p_client_id and q.revoked_at is null;
    select count(*)::int, (count(*) filter (where not public.neo_coupon_available((x.r->>'coupon_id')::uuid, p_client_id)))::int
      into v_reward_count, v_reward_bad
      from (select jsonb_array_elements(v_set.rewards) as r
            union all
            select jsonb_array_elements(k.r->'rewards') from jsonb_array_elements(v_set.ranks) with ordinality k(r, i)
             where v_rank_on and k.i > 1 and jsonb_typeof(k.r->'rewards') = 'array') x;
  end if;

  return jsonb_build_object(
    'days', v_days, 'from', v_from, 'to', v_today,
    'responses', jsonb_build_object('n', v_resp, 'prev', v_resp_prev),
    'daily', v_daily, 'cells', v_cells,
    'funnel', jsonb_build_object('views', v_views, 'views_from', v_views_from, 'responses', v_f_resp,
                                 'drafted', v_f_draft, 'coupons', v_f_coupon, 'used', v_f_used),
    'ai', jsonb_build_object('drafts', v_drafts, 'month', v_drafts_month, 'limit', coalesce(v_client.monthly_ai_limit, 300)),
    'members', jsonb_build_object('total', v_m_total, 'new', v_m_new, 'prev_new', v_m_prev,
                                  'stamped', v_m_stamped, 'repeat', v_m_repeat, 'reward', v_m_reward),
    'coupons', jsonb_build_object('issued', v_c_issued, 'used', v_c_used),
    'stamps', v_stamps,
    'card', jsonb_build_object('ready', v_set.client_id is not null, 'enabled', coalesce(v_set.enabled, false),
                               'goal', v_set.stamp_goal, 'full_mode', case when v_rank_on then 'rank' else 'repeat' end, 'ranks', v_ranks),
    'todo', jsonb_build_object('surveys', coalesce(array_length(v_surveys, 1), 0), 'published', v_pub, 'no_ai', v_no_ai,
                               'review_url', v_review_ok, 'reward_mode', coalesce(v_reward_mode, 'none'),
                               'qr_expires_on', v_qr_expires, 'rewards', v_reward_count, 'rewards_unavailable', v_reward_bad));
end;
$$;
revoke all on function public.neo_dashboard(text, integer) from public, anon;
grant execute on function public.neo_dashboard(text, integer) to authenticated;

-- ------------------------------------------------------------
-- 4. マスター画面の「全店舗の状況」(MSMスタッフだけ)
--    MapOn NEO の契約者(plan = 'D')を、店舗ごとに1行で返す
-- ------------------------------------------------------------
create or replace function public.neo_master_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_30_ts timestamptz := ((v_today - 29)::timestamp at time zone 'Asia/Tokyo');
  v_month_ts timestamptz := date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
begin
  if not public.is_msm_staff() then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  return jsonb_build_object('today', v_today, 'stores', coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', c.id::text, 'name', c.company_name, 'owner_name', to_jsonb(c)->>'owner_name', 'created_at', c.created_at,
        'name_set', btrim(coalesce(c.company_name, '')) not in ('', '(店舗名未入力)'),
        'review_url', btrim(coalesce(c.google_review_url, '')) <> '' or coalesce(sv.has_url, false),
        'published', coalesce(sv.published, 0) > 0,
        'coupon', coalesce(rw.mode, 'none') <> 'none',
        'card', coalesce(cs.enabled, false),
        'responses_30d', coalesce(rs.d30, 0), 'last_response_at', rs.last_at,
        'members', coalesce(mb.n, 0),
        'ai_month', coalesce(ai.n, 0), 'ai_limit', coalesce(c.monthly_ai_limit, 300)) order by c.created_at desc, c.id::text)
      from public.clients c
      left join lateral (select count(*) filter (where s.is_published) as published,
                                bool_or(btrim(coalesce(s.google_review_url, '')) <> '') as has_url,
                                array_agg(s.id) as ids
                           from public.neo_surveys s where s.client_id = c.id and s.deleted_at is null) sv on true
      left join lateral (select count(*)::int as d30,
                                (select max(x.t) from unnest(sv.ids) u(id),
                                   lateral (select r2.submitted_at as t from public.neo_survey_responses r2
                                             where r2.survey_id = u.id order by r2.submitted_at desc limit 1) x) as last_at
                           from public.neo_survey_responses r where r.survey_id = any (sv.ids) and r.submitted_at >= v_30_ts) rs on true
      left join lateral (select count(*)::int as n from public.neo_members m where m.client_id = c.id::text and m.deleted_at is null) mb on true
      left join public.neo_card_settings cs on cs.client_id = c.id::text
      left join public.neo_reward_settings rw on rw.client_id = c.id::text
      left join lateral (select count(*)::int as n from public.neo_ai_drafts d
                          where d.client_id = c.id::text and d.status = 'done' and d.created_at >= v_month_ts) ai on true
     where c.plan = 'D'), '[]'::jsonb));
end;
$$;
revoke all on function public.neo_master_overview() from public, anon;
grant execute on function public.neo_master_overview() to authenticated;
