-- ============================================================
-- 追加SQL_18:ルーレットを止める(あとで戻せる形)
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。表やデータ(ルーレットの景品の設定を含む)は、削除しません。
--
-- 理由:ルーレット(抽選)で渡すクーポンは、景品表示法の「一般懸賞」に当たる可能性があるため、いったん止める。
--
-- 内容:
--  1. 切り替えのスイッチ(neo_settings の lottery_enabled)を作る。初めは「止める」(false)。
--  2. スイッチが止まっている間は:
--     ・お客様の画面に、ルーレットを出さない(neo_get_reward_info が「お礼なし」を返す)
--     ・ルーレットの抽選をしない(neo_claim_reward)
--     ・店舗の管理画面で、ルーレットを選んで保存できない(neo_save_reward_settings)。
--       保存済みの景品の設定は、そのまま残す。
--  3. 関数の中身は、追加SQL_9 と同じ(上のための数行だけを足した)。呼べる人の設定も、変えない。
--
-- ルーレットを戻すとき(MSMの判断で):
--   update public.neo_settings set value = 'true', updated_at = now() where key = 'lottery_enabled';
-- 再び止めるとき:
--   update public.neo_settings set value = 'false', updated_at = now() where key = 'lottery_enabled';
-- ============================================================

-- ------------------------------------------------------------
-- 1. スイッチ(すでにあるときは、今の値のまま)
-- ------------------------------------------------------------
insert into public.neo_settings (key, value) values ('lottery_enabled', 'false')
on conflict (key) do nothing;

create or replace function public.neo_lottery_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true' from public.neo_settings where key = 'lottery_enabled'), false);
$$;
revoke all on function public.neo_lottery_enabled() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.neo_lottery_enabled() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.neo_lottery_enabled() from authenticated';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. お客様の画面:ルーレットを出さない
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

  -- ルーレットを止めている間は、お客様の画面に出さない(追加SQL_18)
  if not public.neo_lottery_enabled() then return jsonb_build_object('mode', 'none'); end if;

  -- ルーレット:景品の名前だけを返す(当選確率は返さない)
  select jsonb_agg(jsonb_build_object('id', p->>'id', 'label', c.name) order by ord) into v_prizes
    from jsonb_array_elements(v_set.lottery->'prizes') with ordinality as t(p, ord)
    join public.neo_coupons c on c.id = (p->>'coupon_id')::uuid;
  if v_prizes is null or jsonb_array_length(v_prizes) < 2 then return jsonb_build_object('mode', 'none'); end if;
  return jsonb_build_object('mode', 'lottery', 'prizes', v_prizes);
end;
$$;

-- ------------------------------------------------------------
-- 3. 抽選しない
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
  -- ルーレットを止めている間は、抽選しない(追加SQL_18)
  if v_set.mode = 'lottery' and not public.neo_lottery_enabled() then raise exception 'reward_not_available' using errcode = 'P0001'; end if;

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
-- 4. 店舗の管理画面:ルーレットを選んで保存できない(景品の設定は残す)
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
  v_lottery_on boolean := public.neo_lottery_enabled();
  v_lottery jsonb;
  p jsonb; v_pc uuid; v_tenths int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from public.clients c where c.id::text = p_client_id
                  and (public.is_msm_staff() or c.auth_id::text = auth.uid()::text)) then
    raise exception 'not_allowed';
  end if;
  if v_mode not in ('none', 'coupon', 'lottery') then raise exception 'invalid_mode'; end if;
  -- ルーレットを止めている間は、ルーレットを選べない(追加SQL_18)
  if v_mode = 'lottery' and not v_lottery_on then raise exception 'lottery_disabled'; end if;
  if v_limit not in ('once', 'daily', 'unlimited') then raise exception 'invalid_limit'; end if;
  if v_avg is not null and (v_avg < 1 or v_avg > 10000000) then raise exception 'invalid_avg_spend'; end if;

  if v_mode = 'coupon' then
    if v_coupon is null or not exists (select 1 from public.neo_coupons c
        where c.id = v_coupon and c.client_id = p_client_id and c.deleted_at is null and c.is_active) then
      raise exception 'coupon_required';
    end if;
  end if;

  if jsonb_typeof(v_prizes) <> 'array' then raise exception 'invalid_prizes'; end if;
  -- ルーレットを止めている間は、景品の設定を確かめず、保存済みのものをそのまま残す
  if v_lottery_on and (v_mode = 'lottery' or jsonb_array_length(v_prizes) > 0) then
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

  v_lottery := case when v_lottery_on then jsonb_build_object('prizes', v_clean)
    else coalesce((select s.lottery from public.neo_reward_settings s where s.client_id = p_client_id), '{"prizes": []}'::jsonb) end;
  insert into public.neo_reward_settings (client_id, mode, coupon_id, claim_limit, lottery, avg_spend, updated_at)
  values (p_client_id, v_mode, v_coupon, v_limit, v_lottery, v_avg, now())
  on conflict (client_id) do update
    set mode = excluded.mode, coupon_id = excluded.coupon_id, claim_limit = excluded.claim_limit,
        lottery = excluded.lottery, avg_spend = excluded.avg_spend, updated_at = now();
  return (select to_jsonb(s) from public.neo_reward_settings s where s.client_id = p_client_id);
end;
$$;

-- 呼べる人の設定は、追加SQL_16 のまま変えません(create or replace は、設定を引き継ぎます)
