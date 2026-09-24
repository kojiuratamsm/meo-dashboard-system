// api/admin/recovery-link.js
// マスター管理画面の「再設定リンク」。
// パスワード再設定用のリンクを発行して返す(メールは送らない)。スタッフがコピーして、LINEやメールで手動で送る。
//
// ・呼べるのはMSMスタッフだけ(ログイン中のアクセストークンを検証し、staff_members で確認)
// ・リンクの発行には Supabase の秘密鍵が必要なため、ブラウザではなくこのサーバー関数で行う
//
// 必要な Vercel の環境変数:SUPABASE_SECRET_KEY(Supabase →「Project Settings」→「API Keys」の Secret key)
//   ※旧形式の service_role キーでも動きます。名前は SUPABASE_SERVICE_ROLE_KEY でも可。

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jgtcqmdpbgqximqlhiyl.supabase.co';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) {
        return res.status(500).json({
            error: 'Vercel に SUPABASE_SECRET_KEY が登録されていないため、リンクを発行できません。'
        });
    }
    const admin = createClient(SUPABASE_URL, secret, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. 呼び出した人がMSMスタッフか確認
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'ログインが必要です。' });
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData?.user) return res.status(401).json({ error: 'ログインの有効期限が切れています。再度ログインしてください。' });

    const { data: staff, error: staffError } = await admin
        .from('staff_members').select('auth_user_id').eq('auth_user_id', userData.user.id).maybeSingle();
    if (staffError) return res.status(500).json({ error: '権限の確認に失敗しました。' });
    if (!staff) return res.status(403).json({ error: 'MSMスタッフの権限がありません。' });

    // 2. 対象の店舗と、そのログイン用アカウントのメールアドレス
    const clientId = String((req.body || {}).client_id || '');
    const { data: client, error: clientError } = await admin
        .from('clients').select('id, company_name, auth_id').eq('id', clientId).maybeSingle();
    if (clientError || !client) return res.status(404).json({ error: '店舗が見つかりません。' });
    if (!client.auth_id) return res.status(400).json({ error: 'この店舗にはログイン用のアカウントがありません。' });

    const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(client.auth_id);
    if (authUserError || !authUser?.user?.email) return res.status(404).json({ error: 'ログイン用のアカウントが見つかりません。' });
    const email = authUser.user.email;

    // 3. 再設定リンクを発行(メールは送られない)
    const siteUrl = (process.env.SITE_URL || 'https://www.mapon-meo.com').replace(/\/$/, '');
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo: `${siteUrl}/reset-password` },
    });
    if (linkError || !linkData?.properties?.action_link) {
        return res.status(502).json({ error: `リンクを発行できませんでした: ${linkError?.message || '不明なエラー'}` });
    }

    return res.status(200).json({
        link: linkData.properties.action_link,
        company_name: client.company_name,
        email,
    });
}
