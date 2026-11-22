// neo-cancel.js
// 設定画面の一番下の「解約」。
// ・MapOn Light:今のパスワードと確認のチェックのあと、その場で解約する。アカウントとデータは、データベースがすぐに削除する(追加SQL_22)。
// ・MapOn(有料):アプリの中では何も削除しない。公式LINEに「解約を希望します」と送ってもらい、担当者が手作業で手続きする。
// ※ マスターとして店舗の画面を見ているときは、この枠を出さない(neo-app.js 側で判断)。

import { supabase } from './supabase-config.js';
import { el } from './survey-lib.js';
import { isLight } from './neo-plan.js';
import { OFFICIAL_LINE_URL } from './terms.js';

export const CANCEL_CSS = `
.cancel-card h2 { color: #2D3748; }
.cancel-pop h3 { font-size: 18px; margin: 0 0 12px; color: #1E293B; }
.cancel-pop p { font-size: 14px; line-height: 1.8; color: #334155; margin: 0 0 10px; }
.cancel-pop .check { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; font-weight: 700; color: #1E293B; margin: 14px 0 6px; cursor: pointer; }
.cancel-pop .check input { width: 20px; height: 20px; margin-top: 2px; flex-shrink: 0; accent-color: #D93025; }
.cancel-pop .copy-box { display: flex; gap: 8px; align-items: center; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 10px; padding: 10px 12px; margin: 6px 0 4px; }
.cancel-pop .copy-box span { flex: 1; font-size: 14px; font-weight: 700; color: #1E293B; word-break: break-all; }
.cancel-pop .actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; margin-top: 16px; }
.btn.danger-solid { background: #D93025; color: #fff; }
.btn.line { background: #06C755; color: #fff; }
`;

const DATA_TEXT_LIGHT = '解約すると、これまでのデータ(アンケート、回答、クーポン、AIで作った文章など)が、すべて削除されます。お客様に配っているアンケートのURLやQRコードも、使えなくなります。削除したデータは、元に戻せません。';
const DATA_TEXT_NEO = '解約すると、これまでのデータ(アンケート、回答、クーポン、会員証・ショップカード、AIで作った文章など)が、すべて削除されます。お客様に配っているアンケートのURLやQRコードも、使えなくなります。削除したデータは、元に戻せません。';

function cancelErrorText(error) {
    const m = String(error?.message || '');
    if (m.includes('wrong_password')) return '今のパスワードが正しくありません。';
    if (m.includes('not_light')) return '有料(MapOn)の店舗は、ここからは解約できません。公式LINEにご連絡ください。';
    if (m.includes('is_staff')) return 'MSMスタッフのアカウントでは、解約できません。';
    if (m.includes('Could not find') || m.includes('does not exist')) return '解約できませんでした(データベースの設定が必要です)。お手数ですが、公式LINEにご連絡ください。';
    return '解約できませんでした。時間をおいて、もう一度お試しください。';
}

function modal(id, titleText, onCloseExtra) {
    const bg = el('div', { class: 'modal-bg', id });
    const box = el('div', { class: 'modal cancel-pop', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + 'Title', style: { maxWidth: '480px' } },
        el('h3', { id: id + 'Title', text: titleText }));
    const opener = document.activeElement;
    let busy = false;
    const close = () => { if (busy) return; bg.remove(); document.removeEventListener('keydown', onKey); opener?.focus?.(); onCloseExtra?.(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    bg.append(box);
    return { bg, box, close, setBusy: (b) => { busy = b; }, open: () => document.body.append(bg) };
}

/** Light:パスワード+確認のチェックで解約する */
function openLightCancel(onCancelled) {
    const m = modal('cancelPopup', '解約しますか？');
    const pass = el('input', { class: 'input', type: 'password', id: 'cancelPassword', autocomplete: 'current-password', placeholder: '今のパスワード' });
    const check = el('input', { type: 'checkbox', id: 'cancelCheck' });
    const msg = el('p', { class: 'msg', id: 'cancelMsg', role: 'alert' });
    const go = el('button', { class: 'btn danger-solid', type: 'button', id: 'cancelGo', disabled: true }, '解約する');
    const stop = el('button', { class: 'btn sub', type: 'button', id: 'cancelStop', onclick: () => m.close() }, 'やめる');
    const sync = () => { go.disabled = !(check.checked && pass.value.length > 0); };
    check.addEventListener('change', sync);
    pass.addEventListener('input', sync);
    go.addEventListener('click', async () => {
        if (go.disabled) return;
        go.disabled = true; stop.disabled = true; m.setBusy(true);
        msg.className = 'msg'; msg.textContent = '解約しています…';
        let res;
        try { res = await supabase.rpc('neo_light_cancel', { p_current_password: pass.value }); } catch (e) { res = { error: e }; }
        if (res.error || !res.data?.ok) {
            m.setBusy(false); stop.disabled = false; sync();
            msg.className = 'msg ng'; msg.textContent = cancelErrorText(res.error);
            if (String(res.error?.message || '').includes('wrong_password')) { pass.value = ''; sync(); pass.focus(); }
            return;
        }
        m.setBusy(false); m.close();
        await onCancelled();
    });
    m.box.append(
        el('p', { id: 'cancelText', text: DATA_TEXT_LIGHT }),
        el('div', { class: 'field', style: { marginTop: '12px' } }, el('label', { for: 'cancelPassword', text: '今のパスワード(本人確認のため)' }), pass),
        el('label', { class: 'check', for: 'cancelCheck' }, check, el('span', { text: '上記の内容を確認しました。' })),
        msg,
        el('div', { class: 'actions' }, stop, go));
    m.open();
    pass.focus();
}

/** 有料(MapOn):公式LINEに送る文をコピーして、LINEへ案内する */
function openNeoCancel(client) {
    const m = modal('cancelPopup', '解約をご希望ですか？');
    const lineText = `MapOnの解約を希望します。店舗名:${client.company_name || ''}`;
    const copyBtn = el('button', { class: 'btn small sub', type: 'button', id: 'cancelCopy' }, 'コピー');
    copyBtn.addEventListener('click', async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(lineText); ok = true; } catch { ok = false; }
        copyBtn.textContent = ok ? 'コピーしました' : 'コピーできませんでした';
        setTimeout(() => { copyBtn.textContent = 'コピー'; }, 2500);
    });
    const check = el('input', { type: 'checkbox', id: 'cancelCheck' });
    const go = el('button', { class: 'btn line', type: 'button', id: 'cancelLine', disabled: true }, el('i', { class: 'fa-brands fa-line', 'aria-hidden': 'true' }), '公式LINEで解約を連絡する');
    check.addEventListener('change', () => { go.disabled = !check.checked; });
    go.addEventListener('click', () => { if (!go.disabled) window.open(OFFICIAL_LINE_URL, '_blank', 'noopener'); });
    m.box.append(
        el('p', { id: 'cancelText', text: DATA_TEXT_NEO }),
        el('p', { text: '解約は、弊社の公式LINEで承ります。下の文をコピーして、公式LINEにお送りください。担当者が確認して、手続きをご案内します。' }),
        el('div', { class: 'copy-box' }, el('span', { id: 'cancelLineText', text: lineText }), copyBtn),
        el('label', { class: 'check', for: 'cancelCheck' }, check, el('span', { text: '上記の内容を確認しました。' })),
        el('div', { class: 'actions' }, el('button', { class: 'btn sub', type: 'button', id: 'cancelStop', onclick: () => m.close() }, 'やめる'), go));
    m.open();
    check.focus();
}

/** 設定画面の一番下に出す「解約」の枠 */
export function cancelCard(client, onCancelled) {
    if (!document.getElementById('cancelCss')) document.head.append(el('style', { id: 'cancelCss', text: CANCEL_CSS }));
    const light = isLight(client);
    return el('div', { class: 'card cancel-card', id: 'cancelCard' },
        el('h2', { text: '解約' }),
        el('p', { class: 'muted', style: { lineHeight: '1.8', marginBottom: '12px' },
            text: light ? 'MapOn Lightを解約すると、アカウントとデータが、すべて削除されます。' : 'MapOnの解約は、弊社の公式LINEで承ります。' }),
        el('button', { class: 'btn danger', type: 'button', id: 'cancelOpen', onclick: () => light ? openLightCancel(onCancelled) : openNeoCancel(client) }, '解約する'));
}
