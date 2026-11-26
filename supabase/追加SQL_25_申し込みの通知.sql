-- ============================================================
-- 追加SQL_25:申し込みがあったことを、メールとChatWorkに通知するための記録
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。既存のデータは変更・削除しません。
-- 前提:追加SQL_22 と 追加SQL_24 を実行済みであること(LINE登録名・最寄駅の列を使います)。
--
-- 内容:
--  ・通知を送ったかどうかの記録(表 neo_signup_notice)。1人に1回だけ通知するため。
--  ・サーバー処理(api/public/notify-signup.js)が使う3つの関数
--      neo_notice_claim()   … 通知してよいかを判定し、「これから通知する」と記録する。
--                             通知してよいのは、MapOn または MapOn Light の申し込みで、登録から15分以内、まだ通知していない人だけ。
--                             メールアドレスとパスワードは返さない(通知に入れない)。
--      neo_notice_done()    … 通知できたことを記録する
--      neo_notice_release() … 通知できなかったとき、記録を取り消す(もう一度通知できるようにする)
--  ・どれも「ログインしている本人」の分だけを扱います(他人の分は記録も取り消しもできません)。
--
-- 実行の順番:このSQLを実行してから、MEO_UPLOAD をアップロードしてください。
-- ============================================================

create table if not exists public.neo_signup_notice (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    claimed_at timestamptz not null default now(),
    sent_at    timestamptz
);
alter table public.neo_signup_notice enable row level security;
revoke all on public.neo_signup_notice from anon, authenticated;

create or replace function public.neo_notice_claim()
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
    if v_created is null or v_created < now() - interval '15 minutes' then
        return jsonb_build_object('ok', false, 'reason', 'too_old');
    end if;
    select c.company_name, c.owner_name, c.plan, c.tier, c.line_name, c.nearest_station into v_client
      from public.clients c where c.auth_id::text = v_uid::text limit 1;
    if not found or v_client.plan is distinct from 'D' then
        return jsonb_build_object('ok', false, 'reason', 'not_neo');
    end if;
    insert into public.neo_signup_notice (user_id) values (v_uid) on conflict (user_id) do nothing;
    get diagnostics v_n = row_count;
    if v_n = 0 then
        return jsonb_build_object('ok', false, 'reason', 'already');
    end if;
    return jsonb_build_object('ok', true, 'tier', v_client.tier, 'owner_name', v_client.owner_name, 'company_name', v_client.company_name,
                              'line_name', v_client.line_name, 'nearest_station', v_client.nearest_station, 'registered_at', v_created);
end;
$$;
revoke all on function public.neo_notice_claim() from public, anon;
grant execute on function public.neo_notice_claim() to authenticated;

create or replace function public.neo_notice_done()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    if auth.uid() is null then return; end if;
    update public.neo_signup_notice set sent_at = now() where user_id = auth.uid() and sent_at is null;
end;
$$;
revoke all on function public.neo_notice_done() from public, anon;
grant execute on function public.neo_notice_done() to authenticated;

create or replace function public.neo_notice_release()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
    if auth.uid() is null then return; end if;
    delete from public.neo_signup_notice where user_id = auth.uid() and sent_at is null;
end;
$$;
revoke all on function public.neo_notice_release() from public, anon;
grant execute on function public.neo_notice_release() to authenticated;
