-- MapOn NEO:設定画面から店舗名を変更できるようにする(何度実行しても問題ありません)
-- 契約者は自分の店舗だけ、MSMスタッフはどの店舗でも変更できる。変えられるのは店舗名だけ。
begin;

create or replace function public.neo_update_store_name(p_client_id text, p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_count int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if v_name = '' then raise exception 'name_required'; end if;
  if char_length(v_name) > 100 then raise exception 'name_too_long'; end if;
  update public.clients set company_name = v_name
   where id::text = p_client_id
     and (public.is_msm_staff() or auth_id::text = auth.uid()::text);
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'not_allowed'; end if;
  return v_name;
end;
$$;
revoke all on function public.neo_update_store_name(text, text) from public;
grant execute on function public.neo_update_store_name(text, text) to authenticated;

commit;
