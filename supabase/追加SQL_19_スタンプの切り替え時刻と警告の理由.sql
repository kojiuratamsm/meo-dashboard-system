-- ============================================================
-- 追加SQL_19:スタンプの切り替え時刻(お店ごと)と、やることリストの警告の理由
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。表やデータは削除しません。
--
-- 内容:
--  1. ショップカードの設定に「スタンプの切り替え時刻」(reset_hour。0〜23時)を足す。
--     初めは0時(=これまでと同じ。日本時間の0時で、次の日になる)。
--     「同じ会員は1日1回」の「1日」を、この時刻で区切る。
--     例:5時にしたお店では、午前2時の来店は「前の日」として数える。
--     ・スタンプの記録に入る日付(jst_date)を、この時刻で決める(記録するときに自動で入れる。
--       これまでの初期値(日本時間の0時で区切った日付)は外す。記録済みの日付は変えない)
--     ・QRコードでスタンプを付けるとき(neo_stamp_by_qr)の「今日すでに付いているか」の判定
--     ・会員証の画面(neo_wallet_view)の「本日のスタンプは付いています」の判定と、切り替え時刻の案内
--     ・切り替え時刻を保存する関数(neo_save_card_reset_hour)。店舗の本人か、MSMスタッフだけ
--     QRコードの読み取り期限は、これまでどおり、日本時間の日付(選んだ日の終わりまで)で判定します。
--  2. やることリストの警告の理由を返す関数(neo_dashboard_alerts)を足す。店舗の本人か、MSMスタッフだけ。
--     ・ショップカードの特典(ランクごとの特典を含む)のクーポンが、使えない状態になっていないか
--     ・アンケートのお礼(決まったクーポン/ルーレットの景品)のクーポンが、使えない状態になっていないか
--     ・理由:停止中/削除済み/有効期限切れ/発行枚数の上限。ルーレットを止めている間(追加SQL_18)も知らせる
--
-- 関数 neo_stamp_by_qr と neo_wallet_view は、追加SQL_10 の中身に、上のための数行だけを足したものです。
-- 呼べる人の設定は、変えません。
-- 実行の順番:このSQLを実行してから、画面のファイルをアップロードしてください。
--   (逆の順番でも、画面は動きます。SQLを実行するまでは、切り替え時刻の設定と警告の理由が出ないだけです)
-- ============================================================

-- ------------------------------------------------------------
-- 1. スタンプの切り替え時刻
-- ------------------------------------------------------------
alter table public.neo_card_settings
  add column if not exists reset_hour smallint not null default 0 check (reset_hour between 0 and 23);

-- そのお店の「今日」(切り替え時刻で区切った日付)
create or replace function public.neo_card_day(p_client text)
returns date language sql stable security definer set search_path = public as $$
  select ((now() at time zone 'Asia/Tokyo')
          - make_interval(hours => coalesce((select s.reset_hour from public.neo_card_settings s where s.client_id = p_client), 0)::int))::date;
$$;

-- スタンプの記録に、そのお店の「今日」の日付を入れる(どの操作で記録しても同じ決め方にする)。
-- 日付を指定して記録したとき(データの移行など)は、その日付のまま。
create or replace function public.neo_stamp_events_set_day()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.jst_date is null then
    new.jst_date := public.neo_card_day(new.client_id);
  end if;
  return new;
end;
$$;
drop trigger if exists neo_stamp_events_set_day on public.neo_stamp_events;
create trigger neo_stamp_events_set_day before insert on public.neo_stamp_events
  for each row execute function public.neo_stamp_events_set_day();
-- これまでの初期値(日本時間の0時で区切った日付)は外し、上の決め方で入れる(列は、これまでどおり空にはできない)
alter table public.neo_stamp_events alter column jst_date drop default;

-- 切り替え時刻を保存する(店舗の本人か、MSMスタッフだけ)
create or replace function public.neo_save_card_reset_hour(p_client_id text, p_hour integer)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.neo_can_manage(p_client_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;
  if p_hour is null or p_hour < 0 or p_hour > 23 then raise exception 'invalid_reset_hour' using errcode = 'P0001'; end if;
  perform public.neo_card_settings_get(p_client_id);   -- 行とスタンプ用QRコードを用意する
  update public.neo_card_settings set reset_hour = p_hour, updated_at = now() where client_id = p_client_id;
  return (select to_jsonb(s) from public.neo_card_settings s where s.client_id = p_client_id);
end;
$$;

-- QRコードでスタンプを付ける(「今日すでに付いているか」を、切り替え時刻で判定する)
create or replace function public.neo_stamp_by_qr(p_device text, p_qr text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if exists (select 1 from public.neo_stamp_events e where e.member_id = v_member and e.kind = 'qr' and e.jst_date = public.neo_card_day(v_qr.client_id)) then
    return jsonb_build_object('status', 'already_today', 'card_key', v_set.card_key);
  end if;
  v_res := public.neo_stamp_apply(v_member, 1, 'qr', v_qr.id, null);
  return v_res || jsonb_build_object('status', 'stamped', 'card_key', v_set.card_key);
end;
$function$;

-- 会員証の画面(「本日のスタンプは付いています」を切り替え時刻で判定し、切り替え時刻も返す)
create or replace function public.neo_wallet_view(p_device text, p_slug text DEFAULT NULL::text, p_card_key text DEFAULT NULL::text, p_member_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- スタンプの切り替え時刻(追加SQL_19)。お客様の画面の案内に使う
  if v_set.client_id is not null and jsonb_typeof(v_out->'card') = 'object' then
    v_out := jsonb_set(v_out, '{card,reset_hour}', to_jsonb(v_set.reset_hour));
  end if;

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
      'stamped_today', exists (select 1 from public.neo_stamp_events e where e.member_id = v_member.id and e.kind = 'qr' and e.jst_date = public.neo_card_day(v_client)),
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
$function$;

-- ------------------------------------------------------------
-- 2. やることリストの警告の理由
-- ------------------------------------------------------------
-- クーポンが使えない理由(使えるときは null)。neo_coupon_available と同じ条件を、理由つきで返す
create or replace function public.neo_coupon_problem(p_coupon_id uuid, p_client text)
returns text language sql stable security definer set search_path = public as $$
  select case
    when c.id is null or c.deleted_at is not null then 'deleted'
    when not c.is_active then 'inactive'
    when c.valid_until is not null and c.valid_until < (now() at time zone 'Asia/Tokyo')::date then 'expired'
    when c.issue_limit is not null
         and (select count(*) from public.neo_coupon_issues i where i.coupon_id = c.id) >= c.issue_limit then 'limit'
  end
  from (select 1) one
  left join public.neo_coupons c on c.id = p_coupon_id and c.client_id = p_client;
$$;

-- 1つのクーポンの警告の内容
create or replace function public.neo_coupon_alert(p_coupon_id uuid, p_client text, p_place text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.neo_coupon_problem(p_coupon_id, p_client) is null then null else
    jsonb_build_object(
      'coupon_id', p_coupon_id,
      'name', (select c.name from public.neo_coupons c where c.id = p_coupon_id and c.client_id = p_client),
      'place', p_place,
      'reason', public.neo_coupon_problem(p_coupon_id, p_client),
      'valid_until', (select c.valid_until from public.neo_coupons c where c.id = p_coupon_id and c.client_id = p_client),
      'issue_limit', (select c.issue_limit from public.neo_coupons c where c.id = p_coupon_id and c.client_id = p_client))
  end;
$$;

-- やることリストの警告の理由(店舗の本人か、MSMスタッフだけ)
create or replace function public.neo_dashboard_alerts(p_client_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_set public.neo_card_settings%rowtype;
  v_rw public.neo_reward_settings%rowtype;
  v_rank_on boolean := false;
  v_stamp jsonb := '[]'::jsonb;
  v_survey jsonb := '[]'::jsonb;
  v_lottery_stopped boolean := false;
  v_on boolean;
  v_a jsonb;
  r record;
begin
  if not public.neo_can_manage(p_client_id) then raise exception 'not_allowed' using errcode = 'P0001'; end if;

  -- ショップカードの特典(公開中のときだけ。非公開なら、お客様に届かないのは当然なので知らせない)
  select * into v_set from public.neo_card_settings where client_id = p_client_id;
  if v_set.client_id is not null and v_set.enabled then
    v_rank_on := public.neo_card_rank_index(v_set.full_mode, v_set.ranks, 0) is not null;
    for r in
      select (x.e->>'coupon_id')::uuid as cid, x.e->>'at' as at, null::text as rank_name, 0 as k, x.ord
        from jsonb_array_elements(coalesce(v_set.rewards, '[]'::jsonb)) with ordinality x(e, ord)
      union all
      select (y.e->>'coupon_id')::uuid, y.e->>'at', k.r->>'name', k.i::int, y.ord
        from jsonb_array_elements(coalesce(v_set.ranks, '[]'::jsonb)) with ordinality k(r, i)
        cross join lateral jsonb_array_elements(case when jsonb_typeof(k.r->'rewards') = 'array' then k.r->'rewards' else '[]'::jsonb end) with ordinality y(e, ord)
       where v_rank_on and k.i > 1
      order by 4, 5
    loop
      v_a := public.neo_coupon_alert(r.cid, p_client_id,
               case when r.rank_name is null then 'スタンプ' || r.at || '個の特典'
                    else '「' || r.rank_name || '」ランクの、スタンプ' || r.at || '個の特典' end);
      if v_a is not null then v_stamp := v_stamp || jsonb_build_array(v_a); end if;
    end loop;
  end if;

  -- アンケートのお礼
  select * into v_rw from public.neo_reward_settings where client_id = p_client_id;
  if v_rw.client_id is not null and v_rw.mode = 'coupon' then
    v_a := public.neo_coupon_alert(v_rw.coupon_id, p_client_id, 'アンケートのお礼');
    if v_a is not null then v_survey := v_survey || jsonb_build_array(v_a); end if;
  elsif v_rw.client_id is not null and v_rw.mode = 'lottery' then
    -- ルーレットを止めている間(追加SQL_18)は、お客様にお礼が出ない
    v_on := true;
    if to_regprocedure('public.neo_lottery_enabled()') is not null then
      execute 'select public.neo_lottery_enabled()' into v_on;
    end if;
    if not coalesce(v_on, false) then
      v_lottery_stopped := true;
    else
      for r in select (p->>'coupon_id')::uuid as cid, coalesce((p->>'fallback')::boolean, false) as fb, ord
                 from jsonb_array_elements(coalesce(v_rw.lottery->'prizes', '[]'::jsonb)) with ordinality t(p, ord) order by ord loop
        v_a := public.neo_coupon_alert(r.cid, p_client_id, case when r.fb then 'ルーレットの参加賞' else 'ルーレットの景品' end);
        if v_a is not null then v_survey := v_survey || jsonb_build_array(v_a); end if;
      end loop;
    end if;
  end if;

  return jsonb_build_object('stamp_rewards', v_stamp, 'survey_rewards', v_survey, 'lottery_stopped', v_lottery_stopped);
end;
$$;

-- ------------------------------------------------------------
-- 3. 呼べる人の設定
-- ------------------------------------------------------------
-- 中で使うだけの関数:だれも直接は呼べない
revoke all on function public.neo_card_day(text) from public;
revoke all on function public.neo_stamp_events_set_day() from public;
revoke all on function public.neo_coupon_problem(uuid, text) from public;
revoke all on function public.neo_coupon_alert(uuid, text, text) from public;
-- 管理画面から呼ぶ関数:ログインした人だけ(中で、店舗の本人かMSMスタッフかを確認する)
revoke all on function public.neo_save_card_reset_hour(text, integer) from public;
revoke all on function public.neo_dashboard_alerts(text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.neo_card_day(text) from anon';
    execute 'revoke all on function public.neo_stamp_events_set_day() from anon';
    execute 'revoke all on function public.neo_coupon_problem(uuid, text) from anon';
    execute 'revoke all on function public.neo_coupon_alert(uuid, text, text) from anon';
    execute 'revoke all on function public.neo_save_card_reset_hour(text, integer) from anon';
    execute 'revoke all on function public.neo_dashboard_alerts(text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.neo_card_day(text) from authenticated';
    execute 'revoke all on function public.neo_stamp_events_set_day() from authenticated';
    execute 'revoke all on function public.neo_coupon_problem(uuid, text) from authenticated';
    execute 'revoke all on function public.neo_coupon_alert(uuid, text, text) from authenticated';
    execute 'grant execute on function public.neo_save_card_reset_hour(text, integer) to authenticated';
    execute 'grant execute on function public.neo_dashboard_alerts(text) to authenticated';
  end if;
end;
$$;
