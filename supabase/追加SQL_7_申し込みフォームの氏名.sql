-- ============================================================
-- 追加SQL_7:申し込みフォーム(MapOn NEO)の「氏名」を保存する
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。既存のデータは変更・削除しません。
--
-- 内容:
--  ・clients テーブルに「氏名(owner_name)」の列を追加する
--  ・申し込みフォームから登録されたときに、氏名も保存するようにする
--    (店舗名は申し込み時には聞かず、初回ログインのときに入力してもらう。
--     それまでの店舗名は「(店舗名未入力)」になる。これは今までと同じ動き)
--
-- このSQLを実行していなくても、申し込み・ログインは今までどおり動きます。
-- (その場合、マスター画面の契約者一覧に「氏名」の列が出ないだけです)
-- ============================================================

-- 氏名(申し込みフォームの「氏名」)を保存する列
alter table public.clients add column if not exists owner_name text;

create or replace function public.handle_mapon_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_plan text := meta->>'plan';
  v_company text := left(coalesce(nullif(trim(meta->>'company_name'), ''), '(店舗名未入力)'), 100);
  v_owner text := left(nullif(trim(meta->>'owner_name'), ''), 100);   -- 氏名(未入力なら null)
begin
  if meta->>'signup_source' is distinct from 'mapon_signup' then
    return new;  -- 申込フォーム以外で作られたユーザー(ライター等)は対象外
  end if;
  if v_plan not in ('A', 'B', 'C', 'D') then v_plan := null; end if;  -- D = MapOn NEO
  insert into public.clients (auth_id, company_name, owner_name, email, plan, status)
  values (new.id, v_company, v_owner, new.email, v_plan, '稼働中');
  return new;
end;
$$;

-- トリガーは今までと同じ(念のため作り直す)
drop trigger if exists on_auth_user_created_mapon_signup on auth.users;
create trigger on_auth_user_created_mapon_signup
  after insert on auth.users for each row execute function public.handle_mapon_signup();
