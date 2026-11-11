-- ============================================================
-- 追加SQL_9:クーポンとルーレット(アンケート回答のお礼)
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。既存のデータは変更・削除しません。
--
-- 内容:
--  ・店舗が作るクーポン(neo_coupons)
--  ・アンケート回答のお礼の設定(neo_reward_settings:決まったクーポン/ルーレット/出さない)
--  ・お客様に発行したクーポン(neo_coupon_issues)
--  ・お礼の受け取り(ルーレットの抽選はここで行う)・クーポンの表示・利用済みにする処理
--
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
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
