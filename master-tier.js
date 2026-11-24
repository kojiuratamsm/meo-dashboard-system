// master-tier.js
// MapOn のプランの切り替え(有料 ⇄ Light)の確認画面。マスター画面の2か所(契約クライアント一覧・MapOn 契約者一覧)で共用する。
//   有料にする:MSMスタッフ。データはそのまま引き継ぐ(AIの上限は月300回になる)
//   Lightにする:MSMの管理者だけ。会員・ショップカードなどを削除するため、件数を見せて、店舗名の入力で確認する
// 実際の可否と処理は、DB側の関数(neo_admin_set_tier・neo_admin_tier_preview。追加SQL_21)が決める。

import { supabase } from './supabase-config.js';
import { el } from './survey-lib.js';

const NAME_PENDING = '(店舗名未入力)';

// どちらのページでも同じ見た目になるように、確認画面の中だけに効くCSS
const TIER_CSS = `
#tierModal.mt-dialog { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px; }
#tierModal .modal { background: #fff; border-radius: 18px; width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto; padding: 24px; color: #2D3748; text-align: left; }
#tierModal h3 { margin: 0 0 14px; font-size: 18px; }
#tierModal .muted { color: #4A5568; font-size: 13px; }
#tierModal .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
#tierModal .field { margin: 0 0 12px; }
#tierModal .field > label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px; color: #2D3748; }
#tierModal .input { width: 100%; padding: 10px 12px; border: 1px solid #E2E8F0; border-radius: 10px; font-size: 14px; box-sizing: border-box; }
#tierModal .btn { background: #4285F4; color: #fff; border: none; padding: 10px 16px; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; }
#tierModal .btn:disabled { opacity: .5; cursor: default; }
#tierModal .btn.sub { background: #EDF2F7; color: #2D3748; }
#tierModal .btn.danger-solid { background: #EA4335; color: #fff; }
#tierModal .msg { font-size: 13px; margin-top: 6px; min-height: 1em; }
#tierModal .msg.ok { color: #1E7E34; }
#tierModal .msg.ng { color: #EA4335; }
#tierModal .del-list { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 14px; margin: 10px 0 14px; }
#tierModal .del-list dt { color: #4A5568; font-weight: 600; }
#tierModal .del-list dd { color: #2D3748; margin: 0; word-break: break-all; }
#tierModal .del-dangerbox { background: #FEECEB; color: #9B1C1C; border-radius: 10px; padding: 12px 14px; font-size: 13px; line-height: 1.7; margin-bottom: 14px; }
`;
function injectCss() {
    if (document.getElementById('tierCss')) return;
    document.head.append(el('style', { id: 'tierCss', text: TIER_CSS }));
}

// ------------------------------------------------------------
// プランの切り替え(追加SQL_21):有料にする=MSMスタッフ/Lightにする=MSMの管理者だけ(データを削除する)
// ------------------------------------------------------------
export function tierErrorText(error) {
    const m = String(error?.message || '');
    if (m.includes('Could not find') || m.includes('does not exist') || m.includes('schema cache')) return 'この機能を使うには、Supabase で「追加SQL_21_ワンタイムリンクとMapOn_Light.sql」を実行してください。';
    if (m.includes('not_allowed')) return 'Lightにする(データを削除する)のは、MSMの管理者だけが行えます。';
    if (m.includes('name_mismatch')) return '入力した店舗名(またはメールアドレス)が一致しません。';
    if (m.includes('not_found')) return 'この店舗は見つかりませんでした。画面を読み込み直してください。';
    if (m.includes('not_neo')) return 'MapOn の店舗ではないため、プランを変えられません。';
    return '切り替えられませんでした。何も変更していません。' + (m ? '(詳細:' + m + ')' : '');
}
export function openTierDialog(c, toTier, onChanged) {
    injectCss();
    const name = String(c.company_name || '').trim();
    const named = name && name !== NAME_PENDING;
    const shown = named ? name : (c.email || '(店舗名が未入力)');
    document.getElementById('tierModal')?.remove();
    const bg = el('div', { class: 'modal-bg mt-dialog', id: 'tierModal' });
    const body = el('div', {}, el('p', { class: 'muted', text: '確認しています…' }));
    let busy = false, done = false;
    const close = () => { if (busy) return; bg.remove(); document.removeEventListener('keydown', onKey); if (done) onChanged?.(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bg.append(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tierTitle' },
        el('h3', { id: 'tierTitle', text: toTier === 'standard' ? '有料(MapOn)に切り替え' : 'Light(無料)に切り替え' }), body));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(bg);
    const closeBtn = (label = '閉じる') => el('button', { class: 'btn sub', type: 'button', id: 'tierClose', onclick: close }, label);
    const finish = (text) => {
        done = true;
        body.replaceChildren(el('p', { class: 'msg ok', id: 'tierDone', style: { fontSize: '15px', fontWeight: '700' }, text }),
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn()));
    };
    const run = async (button, msg, confirmName) => {
        busy = true; button.disabled = true; msg.className = 'msg'; msg.textContent = '切り替えています…';
        let r;
        try { r = await supabase.rpc('neo_admin_set_tier', { p_client_id: String(c.id), p_tier: toTier, p_confirm_name: confirmName ?? null }); } catch (e) { r = { error: e }; }
        busy = false;
        if (r.error || !r.data?.ok) { msg.className = 'msg ng'; msg.textContent = tierErrorText(r.error); button.disabled = false; return false; }
        return true;
    };

    if (toTier === 'standard') {
        const msg = el('p', { class: 'msg', id: 'tierMsg', role: 'alert' });
        const go = el('button', { class: 'btn', type: 'button', id: 'tierGo' }, '切り替える');
        go.addEventListener('click', async () => { if (await run(go, msg)) finish(`「${shown}」を、有料(MapOn)に切り替えました。店舗が画面を開き直すと、全機能が使えます。`); });
        body.replaceChildren(
            el('p', { style: { lineHeight: '1.8', fontSize: '14px' } }, '「', el('b', { text: shown }), '」様を、有料(MapOn)に切り替えますか?'),
            el('p', { class: 'muted', style: { lineHeight: '1.8', marginTop: '6px' }, text: 'これまでのアンケート・回答・クーポンなどのデータは、そのまま引き継ぎます。AIの文章の上限は、月300回になります。会員証・クーポン・アンケートの制限もなくなります。' }),
            msg, el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn('やめる'), go));
        go.focus();
        return;
    }

    (async () => {
        let res;
        try { res = await supabase.rpc('neo_admin_tier_preview', { p_client_id: String(c.id) }); } catch (e) { res = { data: null, error: e }; }
        if (res.error || !res.data) {
            body.replaceChildren(el('p', { class: 'msg ng', id: 'tierMsg', style: { fontSize: '14px', lineHeight: '1.7' }, text: tierErrorText(res.error) }),
                el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn()));
            return;
        }
        const L = res.data.light || {};
        const n = (k) => Number(L[k]) || 0;
        const expect = named ? name : String(res.data.email || c.email || '').trim();
        const matches = (v) => named ? v.trim() === expect : v.trim().toLowerCase() === expect.toLowerCase();
        const input = el('input', { class: 'input', id: 'tierConfirm', autocomplete: 'off', spellcheck: 'false' });
        const msg = el('p', { class: 'msg', id: 'tierMsg', role: 'alert' });
        const go = el('button', { class: 'btn danger-solid', type: 'button', id: 'tierGo', disabled: true }, 'Lightにする');
        input.addEventListener('input', () => { go.disabled = !matches(input.value); msg.textContent = ''; });
        input.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (!go.disabled) go.click(); });
        go.addEventListener('click', async () => {
            if (!matches(input.value) || busy) return;
            input.disabled = true;
            if (await run(go, msg, input.value.trim())) finish(`「${shown}」を、Light(無料)に切り替えました。データを削除し、記録を残しました。`);
            else input.disabled = false;
        });
        const couponText = n('coupons_delete') === 0 ? `${n('coupons_total')}つ(削除なし)`
            : `${n('coupons_total')}つのうち、最初に作った1つ${L.keep_coupon_name ? `(「${L.keep_coupon_name}」)` : ''}を残して、${n('coupons_delete')}つを削除${n('coupon_issues_delete') ? `(お客様に渡した記録 ${n('coupon_issues_delete')}件も削除)` : ''}`;
        const surveyText = n('surveys_delete') === 0 ? `${n('surveys_total')}つ(削除なし)`
            : `${n('surveys_total')}つのうち、最初に作った1つ${L.keep_survey_title ? `(「${L.keep_survey_title}」)` : ''}を残して、${n('surveys_delete')}つを削除${n('responses_delete') ? `(消えるアンケートの回答 ${n('responses_delete')}件も削除)` : ''}`;
        body.replaceChildren(
            el('p', { style: { lineHeight: '1.8', fontSize: '14px' } }, '「', el('b', { text: shown }), '」様を、Light(無料)に切り替えます。次のデータが', el('b', { text: '削除されます' }), ':'),
            el('dl', { class: 'del-list', id: 'tierCounts', style: { marginTop: '10px' } },
                el('dt', { text: '会員・ショップカード' }), el('dd', { 'data-count': 'members', text: `すべて(会員 ${n('members')}人・スタンプの記録 ${n('stamp_events')}件を含む)` }),
                el('dt', { text: 'クーポン' }), el('dd', { 'data-count': 'coupons', text: couponText }),
                el('dt', { text: 'アンケート' }), el('dd', { 'data-count': 'surveys', text: surveyText })),
            el('div', { class: 'del-dangerbox' },
                el('div', { text: '・削除すると、元に戻せません(SupabaseのFreeプランは、バックアップがありません)。' }),
                el('div', { text: '・AIの文章の上限は、月25回になります。誰が・いつ・何を消したかは、記録に残ります。' })),
            el('div', { class: 'field' },
                el('label', { for: 'tierConfirm', text: named ? '確認のため、店舗名を入力してください' : '確認のため、登録のメールアドレスを入力してください' }),
                el('p', { class: 'muted', style: { margin: '0 0 6px', fontSize: '12px' } }, '入力するもの:', el('b', { text: expect })),
                input),
            msg,
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '10px' } }, closeBtn('やめる'), go));
        input.focus();
    })();
}
