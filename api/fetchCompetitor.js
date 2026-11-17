// api/fetchCompetitor.js
// 【停止中】旧ダッシュボードの「競合店舗の自動取得」(2026/11/17 停止)
//
// 停止の理由:
//  ・Google の API キーがプログラムに直接書かれていた(GitHub に上がっているため、漏れていると考えるべき状態)
//  ・ログインの確認がなく、どのサイトからでも呼べたため、誰でもMSMのキーでGoogleの利用料を発生させられた
//  ・渡されたURLを、確認なしにサーバーから取りに行っていた
//  ・MapOn NEO では使っていない
//
// 古いキーは、Google Cloud の「認証情報」で削除してください(このファイルを直しても、キー自体はまだ使える状態のため)。

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(410).json({ error: 'この機能は停止しました。' });
}
