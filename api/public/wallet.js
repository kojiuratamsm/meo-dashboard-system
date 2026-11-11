// api/public/wallet.js
// お客様のスマートフォンに「端末の印」(Cookie)を発行して、
//   ・この端末が持っているクーポン(お店のQRコードをもう一度読み取ると表示される)
//   ・会員証・ショップカード(登録した端末では、入力なしで表示される)
// を扱うサーバー処理。呼び出すのは、お客様の画面(survey.html / coupon.html / card.html)だけ。
//
// 端末の印について
// ・サーバーが作る、推測できない64文字。お名前や電話番号などは入っていない。
// ・ブラウザのプログラムからは読めない設定(HttpOnly)で、このサイトにだけ送られる(Secure / SameSite=Lax)。
// ・必要になったとき(クーポンの受け取り・会員登録・カードの再発行)にだけ発行する。見るだけでは発行しない。
// ・有効期間は400日。開くたびに延長する。
// ・DBには、元の値ではなく、変換した値(ハッシュ)だけを保存する(追加SQL_10 の関数が行う)。
//
// DBの処理は、追加SQL_10 の関数が行う(このファイルは、Cookieの受け渡しと入力の確認だけ)。
// 秘密のキーは使っていない(ブラウザにも配っている公開用のキーで、権限はDBの設定で制限している)。

import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jgtcqmdpbgqximqlhiyl.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpndGNxbWRwYmdxeGltcWxoaXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjE1NzgsImV4cCI6MjA5MTE5NzU3OH0.AGAduKEc_INXIQSDoeZQw3In1ctbPQEL_GcMrYYXdrY';

export const COOKIE_NAME = '__Host-mapon_w';
export const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;   // 400日(秒)
const HEX64 = /^[0-9a-f]{64}$/;
const HEX_TOKEN = /^[0-9a-f]{32,128}$/;
const KEY_RE = /^[0-9A-Za-z_-]{8,64}$/;

/** リクエストのCookieから、端末の印を取り出す(形が違うものは無視する) */
export function readDevice(req) {
    const header = String(req?.headers?.cookie || '');
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === COOKIE_NAME) {
            const v = part.slice(i + 1).trim();
            return HEX64.test(v) ? v : null;
        }
    }
    return null;
}

/** 端末の印を保存するCookieの文字列 */
export function deviceCookie(token) {
    return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

/** ほかのサイトのページから呼ばれていないか(呼び出し元が、このサイト自身であること) */
export function sameOrigin(req) {
    const origin = req?.headers?.origin;
    if (!origin) return true;   // ブラウザ以外からの呼び出し(Cookieを持っていないので、ほかの人になりすませない)
    let host = '';
    try { host = new URL(origin).host; } catch { return false; }
    return host === req.headers.host || host === req.headers['x-forwarded-host'];
}

async function rpc(name, args) {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) return { data: null, error: { status: res.status, message: String(data?.message || data?.error || `HTTP ${res.status}`) } };
        return { data, error: null };
    } catch (e) {
        return { data: null, error: { status: 0, message: String(e?.message || e) } };
    }
}

const text = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, reason: 'forbidden' });
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return res.status(415).json({ ok: false, reason: 'invalid_request' });
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, reason: 'invalid_request' });

    const existing = readDevice(req);
    let device = existing;
    // 端末の印を、必要なときだけ新しく作る
    const ensureDevice = () => { if (!device) device = randomBytes(32).toString('hex'); return device; };
    // 端末の印をブラウザに保存する(すでにある場合は、有効期間を延ばす)
    const keep = () => { if (device) res.setHeader('Set-Cookie', deviceCookie(device)); };
    const dbError = (error) => {
        console.error('wallet rpc failed:', error?.status, error?.message);
        return res.status(503).json({ ok: false, reason: 'database_not_ready' });
    };
    const view = (args) => rpc('neo_wallet_view', { p_device: device, p_slug: null, p_card_key: null, p_member_key: null, ...args });

    const action = String(body.action || '');

    // ---- 見る:持っているクーポンと、会員証・ショップカード ----
    if (action === 'view') {
        const slug = text(body.slug, 100);
        const cardKey = KEY_RE.test(String(body.card_key || '')) ? body.card_key : '';
        const memberKey = HEX64.test(String(body.member_key || '')) ? body.member_key : null;
        if (!slug && !cardKey) return res.status(400).json({ ok: false, reason: 'invalid_request' });
        // 会員専用URLで開いたときだけ、端末の印が無ければ発行する(見るだけのときは発行しない)
        const createdNow = !existing && !!memberKey && !!cardKey;
        if (createdNow) ensureDevice();
        const r = await view({ p_slug: slug || null, p_card_key: cardKey || null, p_member_key: memberKey });
        if (r.error) return dbError(r.error);
        if (existing || (createdNow && r.data?.member)) keep();
        return res.status(200).json(r.data || { ok: false, reason: 'not_found' });
    }

    // ---- 受け取ったクーポンを、この端末に記録する ----
    if (action === 'attach') {
        const token = String(body.issue_token || '');
        if (!HEX_TOKEN.test(token)) return res.status(400).json({ ok: false, reason: 'invalid_request' });
        ensureDevice();
        const r = await rpc('neo_wallet_attach', { p_device: device, p_issue_token: token });
        if (r.error) return dbError(r.error);
        if (existing || r.data?.ok) keep();
        return res.status(200).json(r.data || { ok: false, reason: 'coupon_not_found' });
    }

    // ---- スタンプ用QRコードを読み取った ----
    if (action === 'stamp') {
        const qr = String(body.qr || '');
        if (!HEX_TOKEN.test(qr)) return res.status(200).json({ ok: true, stamp: { status: 'qr_invalid' }, view: null });
        const r = await rpc('neo_stamp_by_qr', { p_device: device, p_qr: qr });
        if (r.error) return dbError(r.error);
        const stamp = r.data || { status: 'qr_invalid' };
        let v = { data: null };
        if (stamp.card_key) { v = await view({ p_card_key: stamp.card_key }); if (v.error) return dbError(v.error); }
        if (existing) keep();
        return res.status(200).json({ ok: true, stamp, view: v.data });
    }

    // ---- 会員登録(名前と電話番号) ----
    if (action === 'join') {
        const cardKey = KEY_RE.test(String(body.card_key || '')) ? body.card_key : '';
        const name = text(body.name, 200), phone = text(body.phone, 40);
        const qr = HEX_TOKEN.test(String(body.qr || '')) ? body.qr : '';
        if (!cardKey) return res.status(400).json({ ok: false, reason: 'invalid_request' });
        ensureDevice();
        const r = await rpc('neo_member_join', { p_device: device, p_card_key: cardKey, p_name: name, p_phone: phone, p_consent: body.consent === true });
        if (r.error) return dbError(r.error);
        const status = String(r.data?.status || 'error');
        const done = status === 'joined' || status === 'already_member';
        if (!done) { if (existing) keep(); return res.status(200).json({ ok: false, status }); }
        keep();
        // スタンプ用QRコードから登録に進んだ場合は、登録のあとにスタンプを付ける
        let stamp = null;
        if (qr) { const s = await rpc('neo_stamp_by_qr', { p_device: device, p_qr: qr }); stamp = s.error ? null : s.data; }
        const v = await view({ p_card_key: cardKey });
        if (v.error) return dbError(v.error);
        return res.status(200).json({ ok: true, status, stamp, view: v.data });
    }

    // ---- 店頭で再発行してもらったカードを、この端末で使えるようにする ----
    if (action === 'restore') {
        const code = String(body.code || '');
        if (!HEX_TOKEN.test(code)) return res.status(200).json({ ok: false, status: 'code_invalid' });
        ensureDevice();
        const r = await rpc('neo_member_restore', { p_device: device, p_code: code });
        if (r.error) return dbError(r.error);
        const status = String(r.data?.status || 'code_invalid');
        if (status !== 'restored') { if (existing) keep(); return res.status(200).json({ ok: false, status }); }
        keep();
        const v = await view({ p_card_key: r.data.card_key });
        if (v.error) return dbError(v.error);
        return res.status(200).json({ ok: true, status, view: v.data });
    }

    return res.status(400).json({ ok: false, reason: 'invalid_request' });
}
