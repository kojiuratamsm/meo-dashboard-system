-- ============================================================
-- 追加SQL_17:提供しないサービスの廃止(運用代行プラン・MapOn・MapOn(モニター))
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。表やデータは削除しません。
--
-- 内容:
--  1. 廃止したサービスの表(予約・メニュー・スタッフ・投稿・旧アンケートの質問と回答)を閉じる。
--     ログインしていない人(anon)も、ログインしている人(authenticated)も、読み書きできなくする。
--     (2026/11/17 の確認で、6つとも0件。Supabase の画面の Table Editor からは、これまでどおり見られます)
--  2. 申し込みフォームから作られるアカウントは、必ず「MapOn NEO」(plan = D)として登録する。
--     (申し込みページを消しても、申し込みの仕組みは外から呼べるため、古いプランを指定して作られないようにする)
--
-- MapOn NEO・MEO分析診断・費用対効果作成シート・MapOnメディアの表と関数には、触りません。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 廃止したサービスの表を閉じる
-- ------------------------------------------------------------
do $$
declare
    t text;
begin
    foreach t in array array['menus', 'staff', 'reservations', 'posts', 'survey_questions', 'survey_responses'] loop
        if to_regclass('public.' || t) is null then
            continue;  -- 表がなければ飛ばす
        end if;
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on table public.%I from public', t);
        if exists (select 1 from pg_roles where rolname = 'anon') then
            execute format('revoke all on table public.%I from anon', t);
        end if;
        if exists (select 1 from pg_roles where rolname = 'authenticated') then
            execute format('revoke all on table public.%I from authenticated', t);
        end if;
    end loop;
end $$;

-- ------------------------------------------------------------
-- 2. 申し込みで作られるアカウントは、必ず MapOn NEO として登録する
--    (それ以外は 追加SQL_7 と同じ)
-- ------------------------------------------------------------
create or replace function public.handle_mapon_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_company text := left(coalesce(nullif(trim(meta->>'company_name'), ''), '(店舗名未入力)'), 100);
  v_owner text := left(nullif(trim(meta->>'owner_name'), ''), 100);
begin
  if meta->>'signup_source' is distinct from 'mapon_signup' then
    return new;
  end if;
  insert into public.clients (auth_id, company_name, owner_name, email, plan, status)
  values (new.id, v_company, v_owner, new.email, 'D', '稼働中');
  return new;
end;
$$;
-- 呼べる人の設定は、追加SQL_16 のまま変えません(create or replace は、設定を引き継ぎます)
