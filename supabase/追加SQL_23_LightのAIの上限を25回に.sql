-- ============================================================
-- 追加SQL_23:MapOn Light の AIの文章の上限を、月50回から月25回にする
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。このSQLを実行しても、データは何も消えません。
-- 前提:追加SQL_21(ワンタイムリンクとMapOn Light)を実行済みであること。
--
-- 内容:
--  ・neo_clients_tier_guard(店舗の守り)… Light の店舗のAIの上限を、いつも25回にする(これまでは50回)
--      新しく申し込んだLightの店舗も、有料からLightに変えた店舗も、25回になる。
--  ・すでにある Light の店舗の上限も、25回にそろえる。
--
-- 変わらないこと:
--  ・有料(MapOn)の店舗の上限(月300回)は、変えない。
--  ・「1回」は、AIが文章を1つ作ったことを数える(作り直しも1回)。1つの回答で作れるのは、これまでどおり最大4回。
--  ・今月すでに25回以上使った Light の店舗は、翌月1日(日本時間)まで、AIの文章を作れなくなる。
--
-- 実行の順番:このSQLと MEO_UPLOAD のアップロードは、どちらが先でもかまいません。
-- ============================================================

-- 店舗の守り:プランは neo_admin_set_tier からしか変えられない/Light のAIの上限は、いつも25回
create or replace function public.neo_clients_tier_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.tier is distinct from old.tier
     and coalesce(current_setting('mapon.tier_change', true), '') <> 'on' then
    raise exception 'tier_change_not_allowed' using errcode = 'P0001';
  end if;
  if new.tier = 'light' then
    new.monthly_ai_limit := 25;
  end if;
  return new;
end;
$$;
drop trigger if exists neo_clients_tier_guard on public.clients;
create trigger neo_clients_tier_guard before insert or update on public.clients
  for each row execute function public.neo_clients_tier_guard();

-- 内部の部品なので、誰からも直接は呼べないようにする(追加SQL_21と同じ)
do $$
begin
  execute 'revoke all on function public.neo_clients_tier_guard() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.neo_clients_tier_guard() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.neo_clients_tier_guard() from authenticated'; end if;
end $$;

-- すでにある Light の店舗も25回にする(上の守りが、25回に書き換える)
update public.clients set monthly_ai_limit = 25 where tier = 'light' and monthly_ai_limit is distinct from 25;
