-- ============================================================
-- 追加SQL_13:申し込み直後の「お迎えメール」(ログインURLの案内)を、1人に1回だけ送るための記録
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。既存のデータは変更・削除しません。
--
-- 内容:
--  ・お迎えメールを送ったかどうかの記録(表 neo_welcome_mail)
--  ・サーバー処理(api/public/welcome.js)が使う3つの関数
--      neo_welcome_claim()   … 送ってよいかを判定し、「これから送る」と記録する。
--                              送ってよいのは、MapOn NEO(plan='D')の申し込みで、登録から15分以内、まだ送っていない人だけ。
--                              送ってよいときは、申し込みのときに保存された「氏名」と「店舗名」を返す(メールに入れる)。
--      neo_welcome_done()    … 送れたことを記録する
--      neo_welcome_release() … 送れなかったとき、記録を取り消す(もう一度送れるようにする)
--  ・どれも「ログインしている本人」の分だけを扱います(他人の分は記録も取り消しもできません)。
--  ・申し込みフォームの「店舗名」は、これまでの仕組み(handle_mapon_signup)で保存されます。このSQLでは変えません。
--
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
-- ============================================================

create table if not exists public.neo_welcome_mail (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    claimed_at timestamptz not null default now(),
    sent_at    timestamptz
);
alter table public.neo_welcome_mail enable row level security;
revoke all on public.neo_welcome_mail from anon, authenticated;

drop function if exists public.neo_welcome_claim();
create function public.neo_welcome_claim()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_uid uuid := auth.uid();
    v_created timestamptz;
    v_client record;
    v_n integer;
begin
    if v_uid is null then
        return jsonb_build_object('ok', false, 'reason', 'no_user');
    end if;
    select u.created_at into v_created from auth.users u where u.id = v_uid;
    -- 登録から15分をすぎた人には送らない(古いログインの情報で、何度も呼ばれるのを防ぐ)
    if v_created is null or v_created < now() - interval '15 minutes' then
        return jsonb_build_object('ok', false, 'reason', 'too_old');
    end if;
    select c.company_name, c.owner_name, c.plan into v_client
      from public.clients c where c.auth_id::text = v_uid::text limit 1;
    if not found or v_client.plan is distinct from 'D' then
        return jsonb_build_object('ok', false, 'reason', 'not_neo');
    end if;
    insert into public.neo_welcome_mail (user_id) values (v_uid) on conflict (user_id) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then
        return jsonb_build_object('ok', false, 'reason', 'already');
    end if;
    return jsonb_build_object('ok', true, 'owner_name', v_client.owner_name, 'company_name', v_client.company_name);
end;
$$;
revoke all on function public.neo_welcome_claim() from public, anon;
grant execute on function public.neo_welcome_claim() to authenticated;

create or replace function public.neo_welcome_done()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    if auth.uid() is null then return; end if;
    update public.neo_welcome_mail set sent_at = now() where user_id = auth.uid() and sent_at is null;
end;
$$;
revoke all on function public.neo_welcome_done() from public, anon;
grant execute on function public.neo_welcome_done() to authenticated;

create or replace function public.neo_welcome_release()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    if auth.uid() is null then return; end if;
    -- 送れた記録(sent_at あり)は取り消さない
    delete from public.neo_welcome_mail where user_id = auth.uid() and sent_at is null;
end;
$$;
revoke all on function public.neo_welcome_release() from public, anon;
grant execute on function public.neo_welcome_release() to authenticated;
