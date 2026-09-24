-- MapOn NEO:契約者が自分でアンケートを作れるようにする(MapOn_setup.sql の後に1回実行)
begin;

-- 申し込みフォーム(signup-neo)からの登録を、プラン「D」(MapOn NEO)として受け付ける
create or replace function public.handle_mapon_signup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_plan text := meta->>'plan';
  v_company text := left(coalesce(nullif(trim(meta->>'company_name'), ''), '(店舗名未入力)'), 100);
begin
  if meta->>'signup_source' is distinct from 'mapon_signup' then
    return new;
  end if;
  if v_plan not in ('A', 'B', 'C', 'D') then v_plan := null; end if;
  insert into public.clients (auth_id, company_name, email, plan, status)
  values (new.id, v_company, new.email, v_plan, '稼働中');
  return new;
end;
$$;

-- 契約者は、自分の店舗のアンケートを作成・編集・削除できる(他の店舗のものは見えない)
drop policy if exists neo_surveys_owner_select on public.neo_surveys;
drop policy if exists neo_surveys_owner_all on public.neo_surveys;
create policy neo_surveys_owner_all on public.neo_surveys
  for all to authenticated using (client_id = public.my_client_id()) with check (client_id = public.my_client_id());

commit;
