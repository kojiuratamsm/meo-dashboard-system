-- ============================================================
-- 追加SQL_10:会員証・ショップカード・スタンプ・「持っているクーポン」
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。既存のデータは変更・削除しません。
--
-- 内容:
--  ・この端末が持っているクーポン(お店のQRコードをもう一度読み取ると表示される)
--  ・会員(名前と電話番号)、会員証、ショップカード、スタンプ、特典のクーポン
--  ・スタンプ用QRコード(お客様が自分のスマートフォンで読み取る。同じ会員は1日1回)
--  ・店舗の管理画面用:カードの設定、手動のスタンプ付与・取消、カードの再発行、会員の削除
--
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
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
