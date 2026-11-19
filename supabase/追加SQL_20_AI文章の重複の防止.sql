-- ============================================================
-- 追加SQL_20:AIの口コミ文章の重複の防止(同じ文章・似すぎた文章を、お客様に出さない)
-- ============================================================
-- 実行する場所:Supabase の SQL Editor
-- 何度実行しても問題ありません。表やデータは削除しません。
--
-- 内容:
--  1. AIの文章の記録(neo_ai_drafts)に、「書き出しの型」(opening)の列を足す。
--     サーバー(api/public/draft.js)が、最近使っていない書き出しの型を選ぶために使う。
--  2. neo_draft_prepare:そのお店で最近使った「書き出しの型」だけを返す(文章そのものは返さない)。
--  3. neo_draft_check:新しく作った文章が、そのお店の直近1,000件の文章と同じか・どのくらい似ているかを返す。
--     返すのは「同じか」と「似ている度合い(0〜1)」だけ。ほかのお客様の文章は返さない。
--     似ている度合いは、2文字ずつの組み合わせが、どのくらい重なっているか(空白・句読点は除いて比べる)。
--  どちらも、AIの文章を作っている最中(neo_draft_begin のあと、neo_draft_finish の前)の、
--  回答IDと合い言葉の組でしか呼べない(neo_draft_finish と同じ確かめ方)。
--
-- 実行の順番:このSQLを実行してから、api/public/draft.js をアップロードしてください。
--   (逆の順番でも、文章は作れます。SQLを実行するまでは、重複の確認をしないだけです)
-- ============================================================

-- 1. 書き出しの型
alter table public.neo_ai_drafts add column if not exists opening text;

-- 比べるための形(全角・半角をそろえ、空白・句読点・記号を除く)
create or replace function public.neo_draft_norm(p_text text)
returns text language sql immutable set search_path = public as $$
  select lower(regexp_replace(normalize(coalesce(p_text, ''), NFKC), '[[:space:]、。,.!?「」『』()\[\]・…♪~〜"''-]', '', 'g'));
$$;

-- 2. 最近使った書き出しの型(新しい順に30件まで)
create or replace function public.neo_draft_prepare(p_draft_id uuid, p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_client text;
begin
  select d.client_id into v_client
    from public.neo_ai_drafts d join public.neo_survey_responses r on r.id = d.response_id
   where d.id = p_draft_id and d.status = 'pending' and r.action_token = p_token;
  if v_client is null then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'openings', coalesce((
    select jsonb_agg(x.opening order by x.created_at desc) from (
      select d.opening, d.created_at from public.neo_ai_drafts d
       where d.client_id = v_client and d.status = 'done' and d.opening is not null
       order by d.created_at desc limit 30) x), '[]'::jsonb));
end;
$$;

-- 3. 同じ文章・似た文章がないか(そのお店の直近1,000件と比べる)。書き出しの型も、ここで記録する
create or replace function public.neo_draft_check(p_draft_id uuid, p_token uuid, p_text text, p_opening text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_client text;
  v_norm text := public.neo_draft_norm(left(coalesce(p_text, ''), 1200));
  v_exact boolean;
  v_sim numeric;
begin
  select d.client_id into v_client
    from public.neo_ai_drafts d join public.neo_survey_responses r on r.id = d.response_id
   where d.id = p_draft_id and d.status = 'pending' and r.action_token = p_token;
  if v_client is null then return jsonb_build_object('ok', false); end if;
  if p_opening is not null then
    update public.neo_ai_drafts set opening = left(p_opening, 30) where id = p_draft_id;
  end if;
  if char_length(v_norm) < 2 then return jsonb_build_object('ok', true, 'exact', false, 'similarity', 0); end if;

  with recent as (
    select d.id, public.neo_draft_norm(d.draft_text) as t
      from public.neo_ai_drafts d
     where d.client_id = v_client and d.status = 'done' and d.id <> p_draft_id and d.draft_text is not null
     order by d.created_at desc limit 1000
  ),
  a as (select distinct substr(v_norm, i, 2) as g from generate_series(1, char_length(v_norm) - 1) i),
  na as (select count(*)::numeric as n from a),
  b as (select distinct r.id, substr(r.t, i, 2) as g from recent r, generate_series(1, greatest(char_length(r.t) - 1, 0)) i),
  nb as (select id, count(*)::numeric as n from b group by id),
  inter as (select b.id, count(*)::numeric as n from b join a using (g) group by b.id)
  select exists (select 1 from recent where t = v_norm),
         coalesce(max(coalesce(inter.n, 0) / nullif(na.n + nb.n - coalesce(inter.n, 0), 0)), 0)
    into v_exact, v_sim
    from nb left join inter using (id) cross join na;

  return jsonb_build_object('ok', true, 'exact', coalesce(v_exact, false), 'similarity', round(coalesce(v_sim, 0), 3));
end;
$$;

-- 呼べる人の設定
revoke all on function public.neo_draft_norm(text) from public;
revoke all on function public.neo_draft_prepare(uuid, uuid) from public;
revoke all on function public.neo_draft_check(uuid, uuid, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.neo_draft_norm(text) from anon';
    execute 'grant execute on function public.neo_draft_prepare(uuid, uuid) to anon';
    execute 'grant execute on function public.neo_draft_check(uuid, uuid, text, text) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.neo_draft_norm(text) from authenticated';
    execute 'grant execute on function public.neo_draft_prepare(uuid, uuid) to authenticated';
    execute 'grant execute on function public.neo_draft_check(uuid, uuid, text, text) to authenticated';
  end if;
end;
$$;
