// api/account/change-email.js
// 【使っていません】メールアドレスの変更は、データベースの関数 neo_change_login_email
// (supabase/追加SQL_5_メールアドレスの変更.sql)で行うように変更しました。
// Vercel の秘密鍵を使わずに済むためです。このファイルは削除しても問題ありません。

export default async function handler(req, res) {
    return res.status(410).json({ error: 'この機能は移動しました。' });
}
