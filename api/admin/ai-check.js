// api/admin/ai-check.js
// マスター画面の「AIの接続テスト」。AI(Claude)にごく短い文を1回だけ送り、設定が正しいかを日本語で返す。
//
// ・呼べるのはMSMスタッフだけ(ログイン中のアクセストークンを、DBの関数 is_msm_staff() で確認する)
// ・APIキーの中身は返さない(設定されているかどうかと、結果だけを返す)
// ・1回のテストで使うAIの利用料は、ごくわずか(数文字ぶん)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jgtcqmdpbgqximqlhiyl.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpndGNxbWRwYmdxeGltcWxoaXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjE1NzgsImV4cCI6MjA5MTE5NzU3OH0.AGAduKEc_INXIQSDoeZQw3In1ctbPQEL_GcMrYYXdrY';
const DEFAULT_MODEL = 'claude-haiku-5-5';

/** AIからのエラーを、次に何をすればよいか分かる言葉にする */
export function explainAiError(status, message) {
    const m = String(message || '');
    if (status === 0) return m === 'timeout' ? 'AIからの返事が時間内に届きませんでした。少し待って、もう一度お試しください。' : 'AIに接続できませんでした。少し待って、もう一度お試しください。';
    if (/workspace/i.test(m)) return 'APIキーにワークスペースの指定が必要です。Vercelの環境変数に ANTHROPIC_WORKSPACE_ID(Claude Console の「ワークスペース」画面に出る wrkspc_ で始まるID)を追加するか、ワークスペースを指定したAPIキーを作り直してください。';
    if (/credit|balance|billing/i.test(m)) return 'Claude Console の残高(クレジット)が不足しています。残高を追加してください。';
    if (status === 401 || status === 403) return 'APIキーが正しくありません(または無効になっています)。Vercelの ANTHROPIC_API_KEY を確認してください。';
    if (status === 404 || /model/i.test(m)) return 'AIのモデル名が見つかりません。Vercelの ANTHROPIC_MODEL を設定している場合は、値を確認してください。';
    if (status === 429) return 'AIの利用が混み合っています(回数の制限)。少し待って、もう一度お試しください。';
    if (status >= 500) return 'AI側で一時的な問題が起きています。少し待って、もう一度お試しください。';
    return 'AIの呼び出しに失敗しました。';
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'Method not allowed' });

    // 1. 呼び出した人がMSMスタッフか確認する
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ ok: false, message: 'ログインが必要です。' });
    let isStaff = false;
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_msm_staff`, {
            method: 'POST', body: '{}',
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        isStaff = r.ok && (await r.json()) === true;
    } catch { isStaff = false; }
    if (!isStaff) return res.status(403).json({ ok: false, message: 'MSMスタッフの権限を確認できませんでした。ログインし直してください。' });

    // 2. 設定の確認
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    if (!apiKey) {
        return res.status(200).json({ ok: false, model, message: 'Vercel に ANTHROPIC_API_KEY が登録されていないか、登録後にまだ反映(デプロイ)されていません。' });
    }

    // 3. ごく短い文を1回だけ送る
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', signal: controller.signal,
            headers: {
                'x-api-key': apiKey, 'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01', 'content-type': 'application/json',
                ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
            },
            body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: '「接続できました」とだけ返してください。' }] }),
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) {
            const detail = String(data?.error?.message || `HTTP ${r.status}`);
            console.error('ai-check failed:', r.status, detail);
            return res.status(200).json({ ok: false, model, message: explainAiError(r.status, detail), detail: detail.slice(0, 300) });
        }
        const text = (data?.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
        return res.status(200).json({ ok: true, model, message: `AIに接続できました(モデル:${model})。`, reply: text.slice(0, 50) });
    } catch (e) {
        const reason = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e);
        return res.status(200).json({ ok: false, model, message: explainAiError(0, reason) });
    } finally {
        clearTimeout(timer);
    }
}
