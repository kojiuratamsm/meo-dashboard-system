// api/public/notify-signup.js
// MapOn と MapOn Light のお申し込みがあったとき、運営(MSM)に「申し込みプラン」と「申し込みフォームの内容」を通知するサーバー処理。
// 通知先は2つ:ChatWork のルームと、運営のメールアドレス。どちらか一方だけ設定しても動く。
// 呼び出すのは、申し込みフォーム(signup-neo.html と、MapOn Light の signup-light.html)だけ。お迎えメール(welcome.js)と同じ仕組み。
//
// 安全のための決まり
// ・申し込みをした本人のログインの情報で、本人であることを確かめる。通知に入れる内容は、DBに保存された値だけ(画面から内容を指定できない)。
// ・1人に1回だけ。登録から15分以内だけ。MapOn・MapOn Light の申し込みだけ。(追加SQL_25 の関数が判定する)
// ・メールアドレスとパスワードは、通知に入れない(DBからも返さない)。
// ・申し込みフォームに入力された文字は、ChatWork の記法([info] や [To:…] など)として読まれない形に直してから入れる。
//   メールでは、HTMLとして読まれない形に直す。
// ・通知が送れなくても、申し込み自体は完了している。
//
// 必要な Vercel の環境変数(秘密の値は、ここ以外には書かない。MEO_UPLOAD にも書かない)
//   CHATWORK_API_TOKEN … ChatWork の API トークン(秘密)
//   CHATWORK_ROOM_ID   … 通知するルームのID(数字。「rid」が付いていてもよい)
//   NOTIFY_EMAIL_TO    … 通知を送る運営のメールアドレス(カンマ区切りで複数も可)
//   RESEND_API_KEY     … お迎えメールと同じもの(メール通知に使う)
//   任意:WELCOME_FROM(差出人)、SITE_URL

import { sameOrigin, escapeHtml, cleanText, supa } from './welcome.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const CHATWORK_BASE = 'https://api.chatwork.com/v2';
const TIMEOUT_MS = 8000;

/** プランの表示名 */
export function planLabel(tier) { return tier === 'light' ? 'MapOn Light(無料)' : 'MapOn'; }

/** 入力された文字から、ChatWork の記法として読まれる [ ] を、全角に直す */
export function chatworkSafe(v, max = 100) { return cleanText(v, max).replace(/\[/g, '［').replace(/\]/g, '］'); }

/** 日本時間の「2026/11/26 12:34」 */
export function jstText(v) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    const p = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** 通知する項目(プラン・氏名・LINE登録名・店舗名・最寄駅・日時)。メールアドレスとパスワードは入れない */
function items(c, clean) {
    const light = c.tier === 'light';
    const v = (x) => clean(x) || '(未入力)';
    return [
        ['プラン', planLabel(c.tier)],
        ['氏名', v(c.owner_name)],
        ...(light ? [['LINE登録名', v(c.line_name)]] : []),
        ['店舗名', v(c.company_name)],
        ...(light ? [['最寄駅', v(c.nearest_station)]] : []),
        ['申し込み日時', (jstText(c.registered_at) || '(不明)') + '(日本時間)']
    ];
}

/** ChatWork に投稿する本文 */
export function buildChatworkMessage(c, siteUrl) {
    const url = String(siteUrl || 'https://www.mapon-meo.com').replace(/\/+$/, '') + '/master-dashboard';
    const lines = items(c, chatworkSafe).map(([k, v]) => `${k}:${v}`);
    return `[info][title]【MapOn】新しいお申し込みがありました[/title]${lines.join('\n')}\nマスター画面:${url}[/info]`;
}

/** 運営宛てのメール(件名・テキスト・HTML) */
export function buildNoticeMail(c, siteUrl) {
    const url = String(siteUrl || 'https://www.mapon-meo.com').replace(/\/+$/, '') + '/master-dashboard';
    const rows = items(c, (x) => cleanText(x));
    const store = cleanText(c.company_name) || '(店舗名なし)';
    const subject = `【MapOn】新しいお申し込み:${planLabel(c.tier)}/${store}`;
    const text = ['MapOn に、新しいお申し込みがありました。', '', ...rows.map(([k, v]) => `${k}:${v}`), '', `マスター画面:${url}`].join('\n');
    const e = escapeHtml;
    const html = `<div style="font-family:'Hiragino Sans','Noto Sans JP',Meiryo,sans-serif;font-size:15px;line-height:1.8;color:#1e293b;max-width:560px;">
<p>MapOn に、新しいお申し込みがありました。</p>
<table style="border-collapse:collapse;font-size:15px;">
${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top;">${e(k)}</td><td style="padding:6px 0;color:#1e293b;font-weight:bold;">${e(v)}</td></tr>`).join('\n')}
</table>
<p style="margin:20px 0 0;"><a href="${e(url)}" style="color:#4f46e5;">マスター画面を開く</a></p>
</div>`;
    return { subject, text, html };
}

/** 環境変数から、通知先の設定を読む(秘密の値は、ここでしか読まない) */
export function readConfig(env = process.env) {
    const room = String(env.CHATWORK_ROOM_ID || '').trim().replace(/^rid/i, '');
    const token = String(env.CHATWORK_API_TOKEN || '').trim();
    const chatwork = /^\d{1,15}$/.test(room) && token ? { token, room } : null;
    const to = String(env.NOTIFY_EMAIL_TO || '').split(',').map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    const mail = env.RESEND_API_KEY && to.length ? { key: env.RESEND_API_KEY, to, from: env.WELCOME_FROM || 'MapOn <contact@msm-fund.com>' } : null;
    return { chatwork, mail };
}

async function timedFetch(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(timer); }
}

async function sendChatwork(cfg, message) {
    const res = await timedFetch(`${CHATWORK_BASE}/rooms/${cfg.room}/messages`, {
        method: 'POST',
        headers: { 'x-chatworktoken': cfg.token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ body: message, self_unread: '1' }).toString()
    });
    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()).slice(0, 200); } catch { /* 本文なし */ }
        throw new Error('chatwork_failed:' + res.status + ' ' + detail);
    }
}

async function sendMail(cfg, mail, uid) {
    const res = await timedFetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `mapon-notice-${uid}` },
        body: JSON.stringify({ from: cfg.from, to: cfg.to, subject: mail.subject, html: mail.html, text: mail.text })
    });
    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()).slice(0, 200); } catch { /* 本文なし */ }
        throw new Error('mail_failed:' + res.status + ' ' + detail);
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ notified: false, error: 'method_not_allowed' });
    if (!sameOrigin(req)) return res.status(403).json({ notified: false, error: 'forbidden' });

    const cfg = readConfig();
    if (!cfg.chatwork && !cfg.mail) return res.status(503).json({ notified: false, error: 'not_configured' });

    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token || token.length > 4096) return res.status(401).json({ notified: false, error: 'no_login' });

    let claimed = false, done = false;
    try {
        const me = await supa('/auth/v1/user', token, { method: 'GET' });
        if (!me.ok || !me.body || !me.body.id) return res.status(401).json({ notified: false, error: 'no_login' });

        const claim = await supa('/rest/v1/rpc/neo_notice_claim', token, { method: 'POST', body: '{}' });
        if (!claim.ok) return res.status(500).json({ notified: false, error: 'not_ready' });   // 追加SQL_25 が未実行など
        const c = claim.body || {};
        if (c.ok !== true) return res.status(200).json({ notified: false, reason: String(c.reason || 'skipped') });
        claimed = true;

        const jobs = [];
        if (cfg.chatwork) jobs.push(['chatwork', sendChatwork(cfg.chatwork, buildChatworkMessage(c, process.env.SITE_URL))]);
        if (cfg.mail) jobs.push(['mail', sendMail(cfg.mail, buildNoticeMail(c, process.env.SITE_URL), me.body.id)]);
        const results = await Promise.allSettled(jobs.map(([, p]) => p));
        const ok = {};
        results.forEach((r, i) => {
            ok[jobs[i][0]] = r.status === 'fulfilled';
            if (r.status === 'rejected') console.error('申し込みの通知に失敗:', jobs[i][0], r.reason && r.reason.message);
        });
        if (!Object.values(ok).some(Boolean)) throw new Error('all_failed');
        done = true;
        await supa('/rest/v1/rpc/neo_notice_done', token, { method: 'POST', body: '{}' });
        return res.status(200).json({ notified: true, ...ok });
    } catch (e) {
        console.error('申し込みの通知でエラー:', e && e.message);
        if (claimed && !done) {
            try { await supa('/rest/v1/rpc/neo_notice_release', token, { method: 'POST', body: '{}' }); } catch { /* 取り消しにも失敗 */ }
            return res.status(502).json({ notified: false, error: 'send_failed' });
        }
        return res.status(500).json({ notified: false, error: 'server_error' });
    }
}
