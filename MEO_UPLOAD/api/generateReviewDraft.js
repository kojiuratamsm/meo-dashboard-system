// api/generateReviewDraft.js
// 【停止中】旧・口コミ下書きAPI(2026/9/24 第0段階で停止)
//
// 停止の理由:
//  ・認証も回数制限もなく、誰でもMSMのOpenAIキーを使って文章を生成できる状態だった
//  ・プロンプトが「大満足したお客様」「高評価の口コミ」「500〜800字」「星の既定値5」となっており、
//    Googleのクチコミポリシー(評価や内容に影響を与えない)に反する内容だった
//
// 新しい口コミ下書きは、設計書v0.2 第2段階の /api/public/drafts(Claude API)で作り直します。

export default async function handler(req, res) {
    return res.status(410).json({
        error: 'この機能は停止しました。新しいアンケート機能をご利用ください。'
    });
}
