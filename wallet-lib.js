// wallet-lib.js
// お客様の画面(アンケート・クーポン・会員証)で共用する部品。
// ・サーバー(/api/public/wallet)とのやりとり
// ・「持っているクーポン」の一覧の表示
// 端末の印(Cookie)は、ブラウザのプログラムからは読めない設定のため、このファイルでは扱わない(サーバーが受け渡しする)。

import { couponHeadline, formatDateJa } from './coupon-lib.js';

const WALLET_API = '/api/public/wallet';

/** サーバーに頼む。通信できなかったときは { ok:false, reason:'network' } を返す(例外にしない) */
export async function walletApi(body, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(WALLET_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            signal: controller.signal, body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        if (!data || typeof data !== 'object') return { ok: false, reason: 'network' };
        return data;
    } catch {
        return { ok: false, reason: 'network' };
    } finally {
        clearTimeout(timer);
    }
}

export const couponUrl = (token) => `/coupon?t=${encodeURIComponent(token)}`;
export const cardUrl = (cardKey) => `/card?k=${encodeURIComponent(cardKey)}`;

/** 有効期限の表示(「この時刻より前まで使える」ので、日付はその直前の日にする) */
export function lastDayText(expiresAt) {
    return formatDateJa(new Date(new Date(expiresAt).getTime() - 1000).toISOString());
}

/** クーポンの種類の表示 */
export function sourceLabel(source) {
    return source === 'stamp' ? 'ショップカードの特典' : 'アンケートご回答のお礼';
}

function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
}

/** 「持っているクーポン」の一覧(1枚ずつ、クーポン画面へのリンク)。文字はすべて textContent で入れる */
export function renderCouponList(listNode, coupons) {
    listNode.replaceChildren(...(coupons || []).map(c => {
        const a = node('a', 'wl-item');
        a.href = couponUrl(c.token);
        const main = node('div', 'wl-main');
        main.append(node('b', 'wl-head', couponHeadline(c.coupon)), node('span', 'wl-name', `${c.coupon?.name || ''}`),
            node('small', 'wl-exp', `${lastDayText(c.expires_at)}まで ・ ${sourceLabel(c.source)}`));
        a.append(main, node('span', 'wl-go', '使う'));
        const li = node('li');
        li.append(a);
        return li;
    }));
}

export const WALLET_CSS = `
.wl-list { list-style: none; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; }
.wl-item { display: flex; align-items: center; gap: 10px; background: #fff; border: 1.5px solid #E9B949; border-radius: 14px; padding: 12px 14px; text-decoration: none; color: #1F2A44; min-height: 64px; }
.wl-main { flex: 1; min-width: 0; display: flex; flex-direction: column; text-align: left; }
.wl-head { font-size: 18px; color: #8A4B00; line-height: 1.3; word-break: break-word; }
.wl-name { font-size: 13px; font-weight: 700; word-break: break-word; }
.wl-exp { font-size: 12px; color: #55607A; }
.wl-go { flex: none; background: #8A4B00; color: #fff; font-size: 14px; font-weight: 700; border-radius: 10px; padding: 8px 14px; }
`;
