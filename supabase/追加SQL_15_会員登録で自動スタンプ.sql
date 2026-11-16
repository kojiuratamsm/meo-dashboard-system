-- ============================================================
-- 追加SQL_15:ショップカードに会員登録したら、スタンプを1個自動で付ける
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。表やデータは変更・削除しません(関数 neo_member_join を作り直すだけ)。
--
-- 内容:
--  ・お客様がショップカードに登録すると、登録と同時にスタンプが1個付く。
--    (これまでは、スタンプ用のQRコードから登録したときだけ付いていた)
--  ・このスタンプは「その日のQRコードのスタンプ」として数える。
--    同じ日にスタンプ用のQRコードを読み取っても、2個目は付かない(1日1回のまま)。
--    スタンプ用のQRコードから登録した場合も、付くのは1個だけ。
--  ・スタンプの履歴には「スタンプ」と表示される(メモ欄に「会員登録」と記録する)。
--  ・カードがいっぱいになったときの特典・ランクアップは、QRコードのスタンプと同じように動く。
--  ・スタンプを付けられなかったとき(想定外のエラー)も、登録そのものは完了する。
--  ・登録の上限(1店舗あたり1時間60回・1日300人)、同じ電話番号の重複登録の禁止は、これまでと同じ。
--
-- 実行の順番:このSQLを実行してから、api/public/wallet.js をアップロードしてください。
--   (逆の順番でも、画面は動きます。SQLを実行するまでは、これまでと同じ動きになります)
-- ============================================================

create or replace function public.neo_member_join(p_device text, p_card_key text, p_name text, p_phone text, p_consent boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_hash text := public.neo_dev_hash(p_device);
  v_set public.neo_card_settings%rowtype;
  v_name text; v_phone text; v_no int; v_id uuid;
  v_stamp jsonb;
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
  -- 登録は、お店に来たときに行うもの。登録と同時にスタンプを1個付ける。
  -- その日のQRコードのスタンプとして数えるので、同じ日にQRコードを読み取っても、2個目は付かない(1日1回のまま)。
  -- スタンプを付けられなかったときも、登録は完了させる(スタンプの分だけ取り消す)。
  begin
    v_stamp := public.neo_stamp_apply(v_id, 1, 'qr', null, '会員登録') || jsonb_build_object('status', 'stamped');
  exception when others then
    v_stamp := null;
  end;
  return jsonb_build_object('status', 'joined', 'member_no', 'A' || lpad(v_no::text, 4, '0'), 'stamp', v_stamp);
end;
$$;

revoke all on function public.neo_member_join(text, text, text, text, boolean) from public;
grant execute on function public.neo_member_join(text, text, text, text, boolean) to anon, authenticated;
