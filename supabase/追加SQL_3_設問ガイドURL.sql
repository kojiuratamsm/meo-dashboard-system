-- MapOn NEO:設問の書き方ガイド(「確認する」ボタン)のURLを、マスター画面から設定できるようにする
-- 何度実行しても問題ありません。
begin;

create table if not exists public.neo_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
alter table public.neo_settings enable row level security;
grant select, insert, update on public.neo_settings to authenticated;

-- ログインしている人(契約者・スタッフ)は読める。書き換えはMSMスタッフだけ。
drop policy if exists neo_settings_read on public.neo_settings;
create policy neo_settings_read on public.neo_settings
  for select to authenticated using (true);
drop policy if exists neo_settings_staff_write on public.neo_settings;
create policy neo_settings_staff_write on public.neo_settings
  for all to authenticated using (public.is_msm_staff()) with check (public.is_msm_staff());

insert into public.neo_settings (key, value) values ('question_guide_url', null)
  on conflict (key) do nothing;

commit;
