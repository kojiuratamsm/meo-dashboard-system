// ai-settings-lib.js
// アンケートごとの「AIが作る口コミ文章の設定」(地域名・業種・狙いたいキーワード)を、管理画面で確認するための部品。
// 実際に文章へ使うかどうかは、サーバー処理(api/public/draft.js)が同じ決まりでもう一度確認する。
//   ・地域名・業種:お店の事実として、文章に自然に合うときだけ使われる(無理には入れない)。評価や宣伝の言葉・文・記号は使えない。
//   ・キーワード:お客様がその言葉を含む選択肢を選んだ(または自分で書いた)ときだけ、文章に自然に合う場合に使われる(無理には入れない)。

// 地域名・業種に入れられない言葉(地名に使われる字と重なる「神」「一番」は入れていない。例:神戸・神田・一番町)
export const PLACE_BLOCK_WORDS = ['最高', '絶対', 'おすすめ', 'オススメ', 'お勧め', 'No.1', 'ナンバーワン', '日本一', '地域一', '業界一', '間違いない', '最強', '完璧',
    '人気', '評判', '話題', '有名', '安い', '格安', '激安', '上手', 'うまい', '美味', 'おいしい', '丁寧', '親切', '満足', '感動', '名店', '優良', '口コミ', 'ランキング'];
export const MAX_KEYWORDS = 10;
const norm = (v) => String(v ?? '').normalize('NFKC').toLowerCase();

/** 地域名・業種として使えるか。使えないときは理由('too_long' | 'symbol' | 'promo')を返す */
export function placeWordProblem(value) {
    const v = String(value ?? '').trim();
    if (!v) return null;
    if (v.length > 20) return 'too_long';
    if (/[。.!!??\n\r「」『』<>#＃★☆]/.test(v)) return 'symbol';
    if (PLACE_BLOCK_WORDS.some(w => norm(v).includes(norm(w)))) return 'promo';
    return null;
}
export function placeWordMessage(value) {
    const p = placeWordProblem(value);
    if (p === 'too_long') return '20文字以内で入力してください。';
    if (p === 'symbol') return '記号や文は入れられません。短い言葉だけにしてください(例:渋谷/美容室)。';
    if (p === 'promo') return '「人気」「おすすめ」「安い」などの評価の言葉は入れられません。場所と業種の事実だけを入れてください。このままでは、文章に使われません。';
    return '';
}

/** キーワードとして使えるか。使えないときは、画面に出す文を返す */
export function keywordMessage(value, existing = []) {
    const t = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (t.length < 2) return 'キーワードは2文字以上で入力してください。';
    if (t.length > 30) return 'キーワードは30文字以内で入力してください。';
    if (/[\n\r「」『』<>]/.test(t)) return 'かぎかっこなどの記号は入れられません。';
    if (existing.some(k => norm(k) === norm(t))) return '同じキーワードが、すでに入っています。';
    if (existing.length >= MAX_KEYWORDS) return `キーワードは${MAX_KEYWORDS}個までです。`;
    return '';
}

/** 保存する形に整える(サーバー処理と同じ決まり。地域名・業種は、使えない内容でも入力のまま保存し、画面で注意を出す) */
export function buildAiSettings({ area, category, keywords }) {
    const seen = new Set(); const list = [];
    for (const k of Array.isArray(keywords) ? keywords : []) {
        const t = typeof k === 'string' ? k.replace(/\s+/g, ' ').trim() : '';
        if (t.length < 2 || t.length > 30 || /[\n\r「」『』<>]/.test(t) || seen.has(norm(t))) continue;
        seen.add(norm(t)); list.push(t);
        if (list.length >= MAX_KEYWORDS) break;
    }
    return { area: String(area ?? '').trim().slice(0, 20), category: String(category ?? '').trim().slice(0, 20), keywords: list };
}

/** そのキーワードを含む選択肢の一覧(「設問文:選択肢」の形)。1つも無ければ、選択肢を選んだだけでは文章に入らない */
export function keywordOptions(keyword, questions) {
    const k = norm(keyword); const hits = [];
    if (!k) return hits;
    for (const q of Array.isArray(questions) ? questions : []) {
        for (const o of q.options || []) {
            if (norm(o.label).includes(k)) hits.push(`${String(q.label || '').trim() || '設問'}:${String(o.label).trim()}`);
        }
    }
    return hits;
}
/** 自由記述の設問があるか(お客様が自分で書いた言葉に、キーワードが含まれることがある) */
export function hasFreeText(questions) {
    return (Array.isArray(questions) ? questions : []).some(q => q.type === 'short_text' || q.type === 'long_text');
}

// ------------------------------------------------------------
// キーワードの質問を作る(ひな型)
// 狙いたいキーワードを、お客様が「実際に利用したもの・当てはまるもの」として選べる質問にする。
//  ・事実を聞く形にする(「〜はいかがでしたか」のように、評価を誘導する聞き方はしない)
//  ・選択肢は、キーワードの言葉そのまま(評価の言葉は足さない)
//  ・「その他」「特になし」は入れない(押されると、AIの文章の材料にならないため)
//  ・その代わり、必須にしない(当てはまらないお客様は、選ばずに進める。事実と違う選択肢を押させない)
// ------------------------------------------------------------
export const KEYWORD_QUESTION_KINDS = [
    { value: 'menu', name: 'メニュー・サービス', label: 'ご利用になったメニューをお選びください(複数選べます)', example: 'ヘッドスパ / カット / カラー' },
    { value: 'reason', name: 'お店を選んだ理由', label: 'このお店を選んだ理由をお選びください(複数選べます)', example: '駅から近い / 個室がある / 夜遅くまで営業' },
    { value: 'scene', name: 'ご利用のシーン', label: '今回のご利用のシーンをお選びください(複数選べます)', example: 'デート / 記念日 / 女子会' },
    { value: 'facility', name: '設備・サービス', label: 'ご利用になった設備やサービスをお選びください(複数選べます)', example: '駐車場 / Wi-Fi / 個室' },
];

/** ひな型の質問を作る。kind:KEYWORD_QUESTION_KINDS の value / keywords:選択肢に入れるキーワード / makeId:IDを作る関数 */
export function keywordQuestion(kind, keywords, makeId) {
    const k = KEYWORD_QUESTION_KINDS.find(x => x.value === kind) || KEYWORD_QUESTION_KINDS[0];
    const seen = new Set(); const labels = [];
    for (const w of Array.isArray(keywords) ? keywords : []) {
        const t = String(w ?? '').replace(/\s+/g, ' ').trim();
        if (!t || seen.has(norm(t))) continue;
        seen.add(norm(t)); labels.push(t);
    }
    return { id: makeId('q'), type: 'multi', label: k.label, required: false, options: labels.map(label => ({ id: makeId('o'), label })) };
}

/** ひな型の質問を入れる位置:最後に続く自由記述の設問(ご感想など)の、すぐ上。自由記述がなければ一番下 */
export function keywordQuestionIndex(questions) {
    const list = Array.isArray(questions) ? questions : [];
    let i = list.length;
    while (i > 0 && (list[i - 1].type === 'short_text' || list[i - 1].type === 'long_text')) i--;
    return i;
}
