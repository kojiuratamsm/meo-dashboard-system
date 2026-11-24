// neo-plan.js
// MapOn Light(無料プラン)の表示:左のメニューの「Light」表示・鍵・AIメーター、使えない機能のポップアップ、アップグレードのボタン。
// Light の制限そのもの(AIは月25回・アンケートとクーポンは1つまで・会員証なし)は、データベースが断る(追加SQL_21・追加SQL_23)。
// ここは、店舗に分かりやすく知らせるための表示だけ。有料(MapOn)の店舗では、何も表示しない。

import { supabase } from './supabase-config.js';
import { el } from './survey-lib.js';

/** 店舗が Light か(clients.tier。追加SQL_21 の前は、列がないので有料と同じ扱い) */
export const isLight = (client) => client?.tier === 'light';

/** Light の AIの文章の月の上限(実際の上限はデータベースが決める。ここは、回数を読み込む前の表示用) */
export const LIGHT_AI_LIMIT = 25;

// 「アップグレードするにはこちらから」「アップグレード」を押したときの行き先(公式LINE。新しいタブで開く)。
export const UPGRADE_URL = 'https://sub.msm-fund.com/line/open/pGWnP0xB1H1g?mtid=GOjXkbMxi5P3';
export function openUpgrade() {
    if (UPGRADE_URL) window.open(UPGRADE_URL, '_blank', 'noopener');
}
export function upgradeButton(label = 'アップグレードするにはこちらから', extra = {}) {
    return el('button', { class: 'btn plan-upgrade', type: 'button', 'data-upgrade': '', onclick: openUpgrade, ...extra }, label);
}

export const PLAN_CSS = `
.plan-badge { display: inline-block; margin-top: 8px; font-size: 11px; font-weight: 700; background: #99F6E4; color: #134E4A; padding: 3px 10px; border-radius: 999px; }
.nav-item.plan-locked { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: #718096; border: 1px dashed #4A5568; }
.nav-item.plan-locked .fa-lock { font-size: 12px; color: #A0AEC0; }
.plan-meter { margin: 6px 0 14px; padding: 14px; border-radius: 12px; background: #2D3748; color: #fff; }
.plan-meter .l { font-size: 12px; color: #CBD5E0; font-weight: 700; }
.plan-meter .n { font-size: 20px; font-weight: 800; margin: 2px 0 6px; }
.plan-meter .n small { font-size: 13px; color: #A0AEC0; font-weight: 500; margin-left: 2px; }
.plan-meter .bar { height: 8px; border-radius: 999px; background: #4A5568; overflow: hidden; margin-bottom: 10px; }
.plan-meter .bar i { display: block; height: 8px; background: #34D399; }
.plan-meter .bar i.warn { background: #FBBF24; }
.plan-meter .bar i.full { background: #F87171; }
.plan-meter .left { font-size: 12px; font-weight: 700; color: #E2E8F0; margin: -4px 0 10px; }
.plan-meter .left.warn { color: #FBBF24; }
.plan-meter .left.full { color: #FCA5A5; }
.plan-meter.std .left { margin-bottom: 0; }
.plan-meter .plan-upgrade { width: 100%; justify-content: center; padding: 9px; font-size: 13px; background: #4F46E5; }
.plan-pop { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px 4px 0; }
.plan-pop .ic { width: 52px; height: 52px; border-radius: 999px; background: #CCFBF1; color: #0F766E; display: flex; align-items: center; justify-content: center; font-size: 22px; }
.plan-pop h3 { margin: 0; font-size: 17px; line-height: 1.5; color: #1E293B; }
.plan-pop p { font-size: 13px; color: #475569; line-height: 1.7; }
.plan-pop .plan-upgrade { width: 100%; justify-content: center; padding: 12px; background: #4F46E5; }
.plan-pop .plan-close { background: transparent; border: none; color: #475569; font-weight: 700; font-size: 13px; padding: 8px; cursor: pointer; }
.plan-note { background: #F0FDFA; border: 1px solid #99F6E4; color: #134E4A; border-radius: 12px; padding: 12px 14px; font-size: 13px; line-height: 1.7; margin-bottom: 16px; }
.plan-lockcard { text-align: center; padding: 40px 20px; }
.plan-lockcard .ic { width: 60px; height: 60px; border-radius: 999px; background: #CCFBF1; color: #0F766E; display: inline-flex; align-items: center; justify-content: center; font-size: 26px; margin-bottom: 12px; }
.plan-lockcard p { color: #475569; line-height: 1.8; font-size: 14px; margin-bottom: 14px; }
.plan-lockcard .plan-upgrade { background: #4F46E5; }
@media (max-width: 768px) { .plan-meter { flex: 1 1 100%; margin: 4px 0; padding: 10px 12px; } .plan-meter .n { font-size: 16px; margin: 0 0 4px; } .plan-badge { margin: 0 0 0 6px; } }
`;

const LOCK_TEXT = {
    card: '会員証・ショップカードは、有料のMapOnでお使いいただけます。',
    coupon: 'Lightでは、クーポンは1つまで作れます。2つ目以降は、有料のMapOnでお使いいただけます。',
    survey: 'Lightでは、アンケートは1つまで作れます。2つ目以降は、有料のMapOnでお使いいただけます。',
};

/** 使えない機能を押したときのポップアップ(kind:card / coupon / survey) */
export function showLockPopup(kind) {
    document.getElementById('planPopup')?.remove();
    const bg = el('div', { class: 'modal-bg', id: 'planPopup', 'data-kind': kind });
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const closeBtn = el('button', { class: 'plan-close', type: 'button', id: 'planPopupClose', onclick: close }, '閉じる');
    bg.append(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'planPopupTitle', style: { maxWidth: '400px' } },
        el('div', { class: 'plan-pop' },
            el('div', { class: 'ic', 'aria-hidden': 'true' }, el('i', { class: 'fa-solid fa-lock' })),
            el('h3', { id: 'planPopupTitle' }, 'MapOn Lightでは', el('br'), 'この機能は使えません。'),
            el('p', { id: 'planPopupText', text: LOCK_TEXT[kind] || LOCK_TEXT.card }),
            upgradeButton('アップグレードするにはこちらから', { id: 'planPopupUpgrade' }),
            closeBtn)));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(bg);
    closeBtn.focus();
}

/** データベースが Light の制限で断ったか(断ったときは、その種類を返す) */
export function lightLimitKind(error) {
    const m = String(error?.message || '').match(/light_limit_(survey|coupon|card)/);
    return m ? m[1] : null;
}

/** 会員・ショップカードの画面の代わりに出す(Light) */
export function lockedMembersPage(app) {
    app.replaceChildren(el('div', { class: 'page-title' }, '会員・ショップカード'),
        el('div', { class: 'card plan-lockcard', id: 'planLocked' },
            el('div', { class: 'ic', 'aria-hidden': 'true' }, el('i', { class: 'fa-solid fa-lock' })),
            el('p', {}, 'MapOn Lightでは、会員証・ショップカードは使えません。', el('br'), '有料のMapOnでお使いいただけます。'),
            upgradeButton()));
    showLockPopup('card');
}

/** 左のメニュー:今月のAIの回数と残り(Light・有料のMapOnの両方)。Light は、さらに「MapOn Light」の表示・会員証の鍵・アップグレード */
export async function decorateSidebar(client) {
    if (!client) return;
    const light = isLight(client);
    if (!document.getElementById('planCss')) document.head.append(el('style', { id: 'planCss', text: PLAN_CSS }));
    const logo = document.querySelector('.sidebar .logo-area');
    if (light && logo && !document.getElementById('planBadge')) logo.append(el('div', { class: 'plan-badge', id: 'planBadge', text: 'MapOn Light' }));
    const members = document.querySelector('.sidebar .nav-item[data-view="members"]');
    if (light && members && !members.classList.contains('plan-locked')) {
        members.classList.add('plan-locked');
        members.setAttribute('aria-label', '会員・ショップカード(MapOn Lightでは使えません)');
        members.append(el('i', { class: 'fa-solid fa-lock', 'aria-hidden': 'true' }));
        members.addEventListener('click', (e) => { e.preventDefault(); showLockPopup('card'); });
    }
    const settings = document.querySelector('.sidebar .nav-item[data-view="settings"]');
    if ((!settings && !members) || document.getElementById('planMeter')) return;
    const fallback = light ? LIGHT_AI_LIMIT : (Number(client.monthly_ai_limit) || 300);
    const meter = el('div', { class: 'plan-meter' + (light ? '' : ' std'), id: 'planMeter' },
        el('div', { class: 'l', text: '今月のAIの文章' }),
        el('div', { class: 'n', id: 'planMeterCount' }, '-', el('small', { text: `/ ${fallback}回` })),
        el('div', { class: 'bar' }, el('i', { id: 'planMeterBar', style: { width: '0%' } })),
        el('div', { class: 'left', id: 'planMeterLeft', text: '残り -回' }),
        light ? upgradeButton('アップグレード', { id: 'planMeterUpgrade' }) : null);
    if (members) members.after(meter); else settings.before(meter);   // メニューのすぐ下(「設定」は、これまでどおり一番下)
    try {
        const { data, error } = await supabase.rpc('neo_dashboard', { p_client_id: String(client.id), p_days: 7 });
        if (error || !data?.ai) return;
        const used = Number(data.ai.month) || 0, limit = Number(data.ai.limit) || fallback;
        const left = Math.max(0, limit - used);
        document.getElementById('planMeterCount').replaceChildren(String(used), el('small', { text: `/ ${limit}回` }));
        const bar = document.getElementById('planMeterBar');
        bar.style.width = `${Math.min(100, Math.round(used / limit * 100))}%`;
        bar.className = used >= limit ? 'full' : used >= limit * 0.8 ? 'warn' : '';
        const leftEl = document.getElementById('planMeterLeft');
        leftEl.textContent = left > 0 ? `今月の残り ${left}回` : '今月の上限に達しました';
        leftEl.className = 'left' + (left === 0 ? ' full' : used >= limit * 0.8 ? ' warn' : '');
    } catch { /* 回数を読めないときは「-」のまま */ }
}
