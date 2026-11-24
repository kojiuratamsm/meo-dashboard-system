// neo-gate.js
// MapOn Light の最初の設定:Google口コミ投稿ページのURLが入るまで、管理画面の何も操作できないようにする。
//   ・Light の店舗が管理画面を開いたとき、URLが未設定なら、閉じられないポップアップを出す
//   ・URLを入れると、「設定」の「Google口コミ設定」にも同じURLが入る(同じ場所に保存する)
//   ・Google の口コミ投稿ページのURLではないもの(aaa.com など)は、「入力が間違っています」と出して保存しない
// 画面の下の操作は、ポップアップが開いている間 inert(操作もキー入力も効かない)にする。
// マスター(MSMスタッフ)が店舗の画面を見ているときと、有料の MapOn(担当者が設定する)では出さない。

import { supabase } from './supabase-config.js';
import { el, checkReviewUrl } from './survey-lib.js';
import { reviewUrlGuide } from './neo-guide.js';

const CSS = `
#reviewGate { position: fixed; inset: 0; background: rgba(15,23,42,.62); z-index: 1100; display: flex; align-items: flex-start; justify-content: center; padding: 16px; overflow-y: auto; }
#reviewGate .gate { background: #fff; border-radius: 20px; width: 100%; max-width: 720px; margin: auto; padding: 28px 28px 24px; box-shadow: 0 24px 60px rgba(0,0,0,.3); color: #2D3748; }
#reviewGate .gate-ic { width: 52px; height: 52px; border-radius: 16px; background: linear-gradient(135deg, #4285F4, #7C3AED); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 22px; margin: 0 auto 12px; }
#reviewGate h2 { font-size: 20px; text-align: center; margin: 0 0 6px; line-height: 1.5; }
#reviewGate .gate-lead { font-size: 13.5px; color: #4A5568; text-align: center; line-height: 1.8; margin-bottom: 16px; }
#reviewGate .gate-box { border: 1px solid #E2E8F0; border-radius: 14px; padding: 16px; background: #F8FAFC; }
#reviewGate .gate-box h3 { font-size: 15px; margin: 0 0 10px; }
#reviewGate .gate-row { display: flex; gap: 8px; flex-wrap: wrap; }
#reviewGate .gate-row .input { flex: 1 1 220px; min-width: 0; }
#reviewGate .gate-hint { font-size: 12px; color: #718096; line-height: 1.7; margin-top: 8px; }
#reviewGate .url-guide { margin-top: 16px; }
#reviewGate .url-guide > summary { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 16px 18px; font-size: 17px; font-weight: 800; color: #fff; background: linear-gradient(135deg, #4285F4, #7C3AED); border-radius: 14px; box-shadow: 0 8px 20px rgba(66,133,244,.35); transition: transform .15s, box-shadow .15s; animation: gateGuidePulse 2.6s ease-in-out infinite; }
#reviewGate .url-guide > summary:hover { transform: translateY(-2px); box-shadow: 0 12px 26px rgba(66,133,244,.45); }
#reviewGate .url-guide > summary:focus-visible { outline: 3px solid #1E3A8A; outline-offset: 3px; }
#reviewGate .url-guide > summary::before { content: '\\f03e'; font-family: 'Font Awesome 6 Free'; font-weight: 900; font-size: 18px; margin-right: 0; transform: none !important; }
#reviewGate .url-guide[open] > summary { animation: none; }
#reviewGate .url-guide-steps { max-width: none; gap: 20px; }
#reviewGate .url-guide-step .cap { font-size: 14.5px; padding: 14px 16px; }
#reviewGate .url-guide-step svg { max-width: 560px; }
@keyframes gateGuidePulse { 0%,100% { box-shadow: 0 8px 20px rgba(66,133,244,.35); } 50% { box-shadow: 0 8px 30px rgba(124,58,237,.55); } }
@media (prefers-reduced-motion: reduce) { #reviewGate .url-guide > summary { animation: none; } }
@media (max-width: 480px) { #reviewGate .url-guide > summary { font-size: 14px; padding: 14px 10px; gap: 8px; } }
#reviewGate .gate-done { text-align: center; padding: 14px 0 6px; }
#reviewGate .gate-done .ok { width: 60px; height: 60px; border-radius: 50%; background: #1E7E34; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 26px; margin: 0 auto 14px; }
@media (max-width: 480px) { #reviewGate .gate { padding: 22px 16px 16px; } #reviewGate h2 { font-size: 18px; } }
`;

const LOCKED = ['.sidebar', '#app', '#masterBanner'];
function lockPage(on) {
    LOCKED.forEach((sel) => document.querySelectorAll(sel).forEach((n) => { if (on) n.setAttribute('inert', ''); else n.removeAttribute('inert'); }));
}

/** Light の店舗で、Google口コミ投稿ページのURLが未設定か(マスター表示では聞かない) */
export function needsReviewSetup(client, isMaster) {
    return !isMaster && client?.tier === 'light' && !String(client?.google_review_url || '').trim();
}

/** 最初の設定のポップアップを出す。URLが保存できたら、onDone を呼ぶ */
export function showReviewSetupGate(client, { onDone } = {}) {
    document.getElementById('reviewGate')?.remove();
    if (!document.getElementById('reviewGateCss')) document.head.append(el('style', { id: 'reviewGateCss', text: CSS }));
    const input = el('input', { class: 'input', id: 'gateUrlInput', placeholder: 'https://g.page/r/XXXXXXXX/review', inputmode: 'url', maxlength: '500', autocomplete: 'off', 'aria-describedby': 'gateMsg' });
    const msg = el('p', { class: 'msg', id: 'gateMsg', role: 'alert' });
    const setMsg = (ok, text) => { msg.className = 'msg ' + (ok ? 'ok' : 'ng'); msg.textContent = text; };
    const openBtn = el('button', { class: 'btn sub', type: 'button', id: 'gateOpenBtn', onclick: () => {
        const r = checkReviewUrl(input.value);
        if (!r.ok) { setMsg(false, r.message); return input.focus(); }
        window.open(input.value.trim(), '_blank', 'noopener,noreferrer');
    } }, el('i', { class: 'fa-solid fa-arrow-up-right-from-square', 'aria-hidden': 'true' }), ' リンクを確認');
    const saveBtn = el('button', { class: 'btn', type: 'button', id: 'gateSaveBtn' }, '保存する');
    const box = el('div', { class: 'gate-box', id: 'gateBox' },
        el('h3', { text: 'Google口コミ設定' }),
        el('div', { class: 'field' }, el('label', { for: 'gateUrlInput', text: 'Google口コミ投稿ページURL' }),
            el('div', { class: 'gate-row' }, input, openBtn, saveBtn)),
        msg,
        el('p', { class: 'gate-hint', text: 'お客様がAIで作った文章を、Googleの口コミ投稿ページに送るときの行き先になります。入力例:https://g.page/r/CAbCdEfGhIjKlMnOp/review' }),
        reviewUrlGuide());
    const dialog = el('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gateTitle' },
        el('div', { class: 'gate-ic', 'aria-hidden': 'true' }, el('i', { class: 'fa-brands fa-google' })),
        el('h2', { id: 'gateTitle', text: 'まずはこちらをご登録ください' }),
        el('p', { class: 'gate-lead' }, 'Google口コミ投稿ページのURLを登録すると、', el('br'), 'アンケートやクーポンが使えるようになります。'),
        box);
    const bg = el('div', { id: 'reviewGate' }, dialog);

    // 入力しているとき:Googleの口コミ投稿ページのURLではないものは、すぐ「入力が間違っています」と出す
    input.addEventListener('input', () => {
        const v = input.value.trim();
        if (!v) { msg.textContent = ''; msg.className = 'msg'; return; }
        const r = checkReviewUrl(v);
        if (!r.ok && v.length > 8) setMsg(false, r.message); else { msg.textContent = ''; msg.className = 'msg'; }
    });
    const save = async () => {
        const url = input.value.trim();
        const r = checkReviewUrl(url);
        if (!r.ok) { setMsg(false, r.message); return input.focus(); }
        saveBtn.disabled = true; setMsg(true, '保存しています…');
        const { data, error } = await supabase.rpc('neo_update_review_url', { p_client_id: String(client.id), p_url: url });
        saveBtn.disabled = false;
        if (error) {
            const m = String(error.message || '');
            return setMsg(false, m.includes('invalid_url') ? 'URLの形式が正しくありません。https:// で始まるURLを貼り付けてください。'
                : (m.includes('Could not find') || m.includes('does not exist')) ? '保存できませんでした(データベースの設定が必要です)。担当者にご連絡ください。'
                : '保存できませんでした。時間をおいて、もう一度お試しください。');
        }
        client.google_review_url = (data ?? url) || null;   // 「設定」の「Google口コミ設定」にも、同じURLが入る
        const start = el('button', { class: 'btn', type: 'button', id: 'gateStart' }, '管理画面をはじめる');
        start.addEventListener('click', () => { bg.remove(); lockPage(false); if (onDone) onDone(); });
        dialog.replaceChildren(el('div', { class: 'gate-done', id: 'gateDone' },
            el('div', { class: 'ok', 'aria-hidden': 'true' }, el('i', { class: 'fa-solid fa-check' })),
            el('h2', { text: '登録しました' }),
            el('p', { class: 'gate-lead' }, 'アンケートやクーポンが使えるようになりました。', el('br'), 'このURLは、「設定」の「Google口コミ設定」でいつでも変更できます。'),
            start));
        start.focus();
    };
    saveBtn.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); } });
    // Esc や、まわりをクリックしても閉じない(URLの登録が終わるまで、先に進めない)
    bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault(); });
    lockPage(true);
    document.body.append(bg);
    input.focus();
}
