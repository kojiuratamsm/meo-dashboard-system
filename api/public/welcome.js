// api/public/welcome.js
// MapOn NEO の申し込み直後に、登録したメールアドレスへ「お迎えメール」(ログインURLの案内)を送るサーバー処理。
// 呼び出すのは、申し込みフォーム(signup-neo.html)だけ。
//
// 安全のための決まり
// ・送り先は、ログインの情報(申し込み直後に Supabase が返すもの)で確かめた「本人のメールアドレス」だけ。
//   画面から送り先を指定することはできない(他人にメールを送らせない)。
// ・1人に1回だけ。登録から15分以内だけ。MapOn NEO(plan='D')の申し込みだけ。(追加SQL_13 の関数が判定する)
// ・氏名と店舗名は、申し込みのときにDBに保存された値(clients)を使い、HTMLとして書き換えられない形に直してから入れる。
// ・パスワードは、メールに入れない。
// ・送れなくても、申し込み自体は完了している(画面は「ログインURL」を表示する)。
//
// 必要な Vercel の環境変数:RESEND_API_KEY(Resend の API Keys で作った、送信専用のキー)
//   任意:WELCOME_FROM(差出人。初期値は MapOn NEO <contact@msm-fund.com>)、SITE_URL(初期値は https://www.mapon-meo.com)
// 秘密のキーは、この環境変数だけ。Supabase は、ブラウザにも配っている公開用のキー+本人のログインの情報で呼ぶ。

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jgtcqmdpbgqximqlhiyl.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpndGNxbWRwYmdxeGltcWxoaXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjE1NzgsImV4cCI6MjA5MTE5NzU3OH0.AGAduKEc_INXIQSDoeZQw3In1ctbPQEL_GcMrYYXdrY';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const NAME_PENDING = '(店舗名未入力)';

export const SUBJECT = '【MapOn NEO】お申し込みありがとうございます(ログインURLのご案内)';

/** 呼び出し元が、このサイト自身であること(ほかのサイトのページから呼ばせない) */
export function sameOrigin(req) {
    const origin = req?.headers?.origin;
    if (!origin) return true;
    let host = '';
    try { host = new URL(origin).host; } catch { return false; }
    return host === req.headers.host || host === req.headers['x-forwarded-host'];
}

/** HTMLに入れる文字を、タグとして読まれない形に直す */
export function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 改行やタブを取り除き、長さをそろえる(件名・本文の崩れを防ぐ) */
export function cleanText(v, max = 100) {
    return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** お迎えメールの本文(HTML と テキスト) */
export function buildWelcomeMail({ ownerName, storeName, email, siteUrl }) {
    const owner = cleanText(ownerName);
    const storeRaw = cleanText(storeName);
    const store = storeRaw && storeRaw !== NAME_PENDING ? storeRaw : '';
    const mail = cleanText(email, 254);
    const loginUrl = String(siteUrl || 'https://www.mapon-meo.com').replace(/\/+$/, '') + '/login';
    const greet = owner ? `${owner} 様` : 'ご担当者様';
    const storeShown = store || '(未入力。ログイン後に入力できます)';

    const text = [
        greet,
        '',
        'このたびは、MapOn NEO にお申し込みいただき、ありがとうございます。',
        '店舗管理画面のアカウントを発行しました。',
        '',
        '■ ご登録内容',
        `お名前:${owner || '(未入力)'}`,
        `店舗名:${storeShown}`,
        `メールアドレス:${mail}`,
        '',
        '■ ログインURL',
        loginUrl,
        '(このURLをブックマークしておくと便利です)',
        '',
        '■ ログインの方法',
        'お申し込みのときに登録した、メールアドレスとパスワードを入力してください。',
        'パスワードは、セキュリティのため、このメールには記載していません。',
        '',
        '■ パスワードを忘れたとき',
        'ログイン画面の「パスワードをお忘れの方」から、メールで再設定できます。',
        '',
        '店舗名は、ログイン後の「設定」で変更できます。',
        '',
        'このメールに心当たりがない場合は、何もせず、このメールを破棄してください。',
        'ご不明な点は、このメールへの返信(contact@msm-fund.com)でお問い合わせください。',
        '',
        '株式会社MSM / MapOn NEO'
    ].join('\n');

    const e = escapeHtml;
    const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:6px 0;color:#1e293b;font-weight:bold;">${v}</td></tr>`;
    const html = `<div style="font-family:'Hiragino Sans','Noto Sans JP',Meiryo,sans-serif;font-size:15px;line-height:1.8;color:#1e293b;max-width:560px;">
<p>${e(greet)}</p>
<p>このたびは、MapOn NEO にお申し込みいただき、ありがとうございます。<br>店舗管理画面のアカウントを発行しました。</p>
<h3 style="font-size:16px;margin:24px 0 8px;">ご登録内容</h3>
<table style="border-collapse:collapse;font-size:15px;">
${row('お名前', e(owner || '(未入力)'))}
${row('店舗名', e(storeShown))}
${row('メールアドレス', e(mail))}
</table>
<h3 style="font-size:16px;margin:24px 0 8px;">ログインURL</h3>
<p style="margin:0 0 8px;"><a href="${e(loginUrl)}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">ログイン画面を開く</a></p>
<p style="margin:0;"><a href="${e(loginUrl)}" style="color:#4f46e5;">${e(loginUrl)}</a><br><span style="color:#64748b;font-size:13px;">(このURLをブックマークしておくと便利です)</span></p>
<h3 style="font-size:16px;margin:24px 0 8px;">ログインの方法</h3>
<p style="margin:0;">お申し込みのときに登録した、メールアドレスとパスワードを入力してください。<br>パスワードは、セキュリティのため、このメールには記載していません。</p>
<h3 style="font-size:16px;margin:24px 0 8px;">パスワードを忘れたとき</h3>
<p style="margin:0;">ログイン画面の「パスワードをお忘れの方」から、メールで再設定できます。</p>
<p style="margin:24px 0 0;">店舗名は、ログイン後の「設定」で変更できます。</p>
<p style="margin:24px 0 0;color:#64748b;font-size:13px;">このメールに心当たりがない場合は、何もせず、このメールを破棄してください。<br>ご不明な点は、このメールへの返信(contact@msm-fund.com)でお問い合わせください。</p>
<p style="margin:16px 0 0;">株式会社MSM / MapOn NEO</p>
</div>`;
    return { subject: SUBJECT, text, html };
}

async function supa(path, token, init = {}) {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
        ...init,
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ sent: false, error: 'method_not_allowed' });
    if (!sameOrigin(req)) return res.status(403).json({ sent: false, error: 'forbidden' });

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return res.status(503).json({ sent: false, error: 'not_configured' });

    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token || token.length > 4096) return res.status(401).json({ sent: false, error: 'no_login' });

    let claimed = false, done = false;
    try {
        // 1. ログインの情報から、本人を確かめる(送り先は、ここで分かったメールアドレスだけ)
        const me = await supa('/auth/v1/user', token, { method: 'GET' });
        const email = me.ok && me.body && typeof me.body.email === 'string' ? me.body.email : '';
        if (!email || !me.body.id) return res.status(401).json({ sent: false, error: 'no_login' });

        // 2. 送ってよいかをDBで判定し、「これから送る」と記録する(1人に1回・15分以内・NEOだけ)
        const claim = await supa('/rest/v1/rpc/neo_welcome_claim', token, { method: 'POST', body: '{}' });
        if (!claim.ok) return res.status(500).json({ sent: false, error: 'not_ready' });   // 追加SQL_13 が未実行など
        const c = claim.body || {};
        if (c.ok !== true) return res.status(200).json({ sent: false, reason: String(c.reason || 'skipped') });
        claimed = true;

        // 3. メールを送る(Idempotency-Key で、同じ人に二重に送らない。Resend は24時間保持)
        const mail = buildWelcomeMail({ ownerName: c.owner_name, storeName: c.company_name, email, siteUrl: process.env.SITE_URL });
        const sent = await fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `mapon-welcome-${me.body.id}` },
            body: JSON.stringify({
                from: process.env.WELCOME_FROM || 'MapOn NEO <contact@msm-fund.com>',
                to: [email],
                subject: mail.subject,
                html: mail.html,
                text: mail.text
            })
        });
        if (!sent.ok) {
            let detail = '';
            try { detail = JSON.stringify(await sent.json()).slice(0, 300); } catch { /* 本文なし */ }
            console.error('お迎えメールの送信に失敗:', sent.status, detail);
            throw new Error('send_failed:' + sent.status);
        }
        done = true;
        await supa('/rest/v1/rpc/neo_welcome_done', token, { method: 'POST', body: '{}' });
        return res.status(200).json({ sent: true });
    } catch (e) {
        console.error('お迎えメールの処理でエラー:', e && e.message);
        // 記録したのに送れなかったときは、記録を取り消す(あとで、もう一度送れるようにする)
        if (claimed && !done) {
            try { await supa('/rest/v1/rpc/neo_welcome_release', token, { method: 'POST', body: '{}' }); } catch { /* 取り消しにも失敗 */ }
            return res.status(502).json({ sent: false, error: 'send_failed' });
        }
        return res.status(500).json({ sent: false, error: 'server_error' });
    }
}
