// master-clients.js
// マスター管理画面(master-dashboard.html)の「契約クライアント一覧」に足す部品
//   ・プラン:店舗名の下に MapOn / MapOn Light のプルダウン。切り替えの確認画面は master-tier.js
//       Light → MapOn:データはそのまま引き継ぐ(MSMスタッフ)
//       MapOn → Light:会員・ショップカードなどを削除する(MSMの管理者だけ。件数を見せて、店舗名の入力で確認)
//   ・店舗名を押すと、申し込みのときに入力された内容などを表示する
// 見られる・変えられる範囲は、DB側の権限(RLS)と関数(追加SQL_21)が決める。

import { supabase } from './supabase-config.js';
import { el } from './survey-lib.js';
import { openTierDialog } from './master-tier.js';

const NAME_PENDING = '(店舗名未入力)';
const OLD_PLANS = { A: '旧・運用代行プラン', B: '旧・MapOn', C: '旧・MapOnモニター' };

const CSS = `
.plan-select { padding: 4px 4px; border-radius: 8px; border: 1px solid #CBD5E1; font-weight: 700; font-size: 12px; max-width: 130px; cursor: pointer; background: #fff; }
.plan-select.std { color: #3730A3; border-color: #A5B4FC; background: #EEF2FF; }
.plan-select.light { color: #0F766E; border-color: #5EEAD4; background: #F0FDFA; }
.plan-select:disabled { cursor: default; opacity: .8; }
.plan-old { color: #A0AEC0; font-size: 12px; }
#clientTable td.plan-name-cell .plan-select { display: block; margin-top: 6px; }
.plan-old { display: inline-block; white-space: normal; max-width: 9em; }
.client-name-btn { display: inline-block; min-width: 5.5em; max-width: 14em; line-height: 1.5; background: none; border: none; padding: 0; font: inherit; color: var(--primary-blue, #4285F4); font-weight: 700; text-decoration: underline; cursor: pointer; text-align: left; }
#clientDetailModal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px; }
#clientDetailModal .cd { background: #fff; border-radius: 18px; width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto; padding: 24px; color: #2D3748; text-align: left; }
#clientDetailModal h3 { margin: 0 0 4px; font-size: 18px; word-break: break-all; }
#clientDetailModal .sub { color: #4A5568; font-size: 12px; margin: 0 0 14px; }
#clientDetailModal h4 { font-size: 13px; color: #4A5568; margin: 16px 0 6px; border-bottom: 1px solid #EDF2F7; padding-bottom: 4px; }
#clientDetailModal dl { display: grid; grid-template-columns: 9.5em 1fr; gap: 7px 12px; font-size: 14px; margin: 0; }
#clientDetailModal dt { color: #4A5568; font-weight: 600; }
#clientDetailModal dd { margin: 0; word-break: break-all; }
#clientDetailModal .none { color: #A0AEC0; }
#clientDetailModal .btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
#clientDetailModal .btns button { border: none; padding: 10px 16px; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; }
#clientDetailModal .btns .close { background: #EDF2F7; color: #2D3748; }
#clientDetailModal .btns .enter { background: #4285F4; color: #fff; }
@media (max-width: 480px) { #clientDetailModal dl { grid-template-columns: 1fr; gap: 2px; } #clientDetailModal dd { margin-bottom: 8px; } }
`;
function injectCss() {
    if (document.getElementById('masterClientsCss')) return;
    document.head.append(el('style', { id: 'masterClientsCss', text: CSS }));
}

/** MSMの管理者か(確かめられないときは false。実際の可否はDB側の関数が決める) */
export async function loadIsAdmin() {
    try { const r = await supabase.rpc('is_msm_admin'); return !r.error && r.data === true; } catch { return false; }
}

/** 一覧のプランのプルダウン(MapOn の店舗だけ。店舗名の下に置く) */
export function planCell(client, { isAdmin = false, onChanged } = {}) {
    injectCss();
    if (client.plan !== 'D') return el('span', { class: 'plan-old', text: OLD_PLANS[client.plan] ? `${OLD_PLANS[client.plan]}(提供終了)` : '-' });
    // 追加SQL_21 を実行する前は、プランの列がない(すべて有料と同じ扱い)
    if (!('tier' in client)) return el('span', { text: 'MapOn' });
    const tier = client.tier === 'light' ? 'light' : 'standard';
    const name = String(client.company_name || client.email || '');
    const sel = el('select', { class: 'plan-select ' + (tier === 'light' ? 'light' : 'std'), 'data-plan-client': String(client.id), 'aria-label': `${name} のプラン` },
        el('option', { value: 'standard', text: 'MapOn' }),
        el('option', { value: 'light', text: 'MapOn Light' }));
    sel.value = tier;
    // MapOn → Light はデータを削除するので、管理者だけ
    if (tier === 'standard' && !isAdmin) {
        sel.options[1].disabled = true;
        sel.title = 'Lightへの切り替え(データの削除をともなう)は、MSMの管理者だけが行えます';
    }
    sel.addEventListener('change', () => {
        const to = sel.value;
        sel.value = tier;   // 確認画面で「切り替える」を押すまでは、元のまま
        if (to !== tier) openTierDialog(client, to, onChanged);
    });
    return sel;
}

/** 一覧の店舗名(押すと、申し込みの内容を表示する) */
export function nameButton(client) {
    injectCss();
    const name = String(client.company_name || '').trim() || NAME_PENDING;
    return el('button', { type: 'button', class: 'client-name-btn', 'data-detail-client': String(client.id), onclick: () => openClientDetail(client) },
        el('i', { class: 'fa-solid fa-shop', 'aria-hidden': 'true' }), ' ', name);
}

const fmt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const val = (v) => (v === null || v === undefined || String(v).trim() === '') ? el('span', { class: 'none', text: '(記録なし)' }) : String(v);

function planName(c) {
    if (c.plan !== 'D') return OLD_PLANS[c.plan] ? `${OLD_PLANS[c.plan]}(提供終了)` : '-';
    return c.tier === 'light' ? 'MapOn Light(無料)' : 'MapOn';
}

/** 店舗の詳細(申し込みのときに入力された内容・契約の状況) */
export async function openClientDetail(client) {
    injectCss();
    document.getElementById('clientDetailModal')?.remove();
    const c = client;
    const name = String(c.company_name || '').trim() || NAME_PENDING;
    const bg = el('div', { id: 'clientDetailModal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cdTitle' });
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const route = el('dd', { id: 'cdRoute', text: '確認しています…' });
    const ai = el('dd', { id: 'cdAi', text: '確認しています…' });
    const row = (label, value, id) => [el('dt', { text: label }), el('dd', id ? { id } : {}, value)];
    const enter = typeof window.masterLoginAs === 'function'
        ? el('button', { type: 'button', class: 'enter', id: 'cdEnter', onclick: () => { close(); window.masterLoginAs(encodeURIComponent(JSON.stringify(c))); } }, '管理画面に入る') : null;
    bg.append(el('div', { class: 'cd' },
        el('h3', { id: 'cdTitle', text: name }),
        el('p', { class: 'sub', text: `店舗ID:${c.id}` }),
        el('h4', { text: '申し込みのときに入力された内容' }),
        el('dl', { id: 'cdSignup' },
            ...row('店舗名', val(c.company_name === NAME_PENDING ? '' : c.company_name), 'cdStore'),
            ...row('お名前', val(c.owner_name), 'cdOwner'),
            ...(c.tier === 'light' || c.line_name ? row('LINE登録名', val(c.line_name), 'cdLine') : []),
            ...(c.tier === 'light' || c.nearest_station ? row('最寄駅', val(c.nearest_station), 'cdStation') : []),
            ...row('メールアドレス', val(c.email), 'cdEmail'),
            ...row('利用規約', c.terms_agreed_at ? `同意済み(${fmt(c.terms_agreed_at)}・版 ${c.terms_version || '-'})` : val(''), 'cdTerms')),
        el('h4', { text: '契約の状況' }),
        el('dl', { id: 'cdStatus' },
            ...row('プラン', planName(c), 'cdPlan'),
            el('dt', { text: '申し込みの方法' }), route,
            ...row('申し込み日時', val(fmt(c.created_at)), 'cdCreated'),
            ...row('ログイン用アカウント', c.auth_id ? 'あり' : 'なし', 'cdAuth'),
            ...row('ステータス', val(c.status), 'cdState'),
            ...(c.plan === 'D' ? [el('dt', { text: '今月のAIの文章' }), ai] : [])),
        el('div', { class: 'btns' }, el('button', { type: 'button', class: 'close', id: 'cdClose', onclick: close }, '閉じる'), enter)));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(bg);
    bg.querySelector('#cdClose').focus();

    // 申し込みの方法(Light の申し込みフォーム/ワンタイムリンク)
    if (c.plan !== 'D') route.textContent = 'マスター画面で登録(旧プラン)';
    else {
        let invite = null;
        try {
            const r = await supabase.rpc('neo_invite_list');
            if (!r.error && Array.isArray(r.data)) invite = r.data.find(i => String(i.used_client_id || '') === String(c.id)) || null;
        } catch { invite = null; }
        if (invite) route.textContent = `ワンタイムリンク(発行 ${fmt(invite.created_at) || '-'}${invite.memo ? `・メモ:${invite.memo}` : ''})`;
        else if (c.line_name) route.textContent = 'MapOn Light の申し込みフォーム';
        else if (c.tier === 'light') route.textContent = 'MapOn Light';
        else route.textContent = 'これまでの申し込みフォーム、またはマスター画面で登録';
    }
    // 今月のAIの文章の回数
    if (c.plan === 'D') {
        try {
            const r = await supabase.rpc('neo_dashboard', { p_client_id: String(c.id), p_days: 7 });
            if (r.error || !r.data?.ai) throw new Error('no');
            const used = Number(r.data.ai.month) || 0, limit = Number(r.data.ai.limit) || Number(c.monthly_ai_limit) || 0;
            ai.textContent = limit ? `${used}回 / 上限 ${limit}回(残り ${Math.max(0, limit - used)}回)` : `${used}回`;
        } catch { ai.textContent = c.monthly_ai_limit ? `上限 ${c.monthly_ai_limit}回(今月の回数は読み込めませんでした)` : '読み込めませんでした'; }
    }
}
