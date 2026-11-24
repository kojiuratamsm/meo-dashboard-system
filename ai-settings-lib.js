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

// 業種ごとのひな型(2026/11/24)。最初に業種を選び、その業種に合った「質問の種類」から選ぶ。
// 「その他の業種」は、これまでの共通のひな型(KEYWORD_QUESTION_KINDS)。
const REASON = { value: 'reason', name: 'お店を選んだ理由', label: 'このお店を選んだ理由をお選びください(複数選べます)' };
export const KEYWORD_INDUSTRIES = [
    { value: 'beauty', name: '美容関係', hint: '美容室・ネイル・まつげ・エステなど', kinds: [
        { value: 'menu', name: '受けられたメニュー', label: '今回受けられたメニューをお選びください(複数選べます)', example: 'カット / カラー / ヘッドスパ' },
        { value: 'concern', name: 'ご相談の内容', label: '今回ご相談された内容をお選びください(複数選べます)', example: '髪のダメージ / 白髪 / くせ毛' },
        { ...REASON, example: '駅から近い / 個室がある / 夜遅くまで営業' },
        { value: 'facility', name: '設備・サービス', label: 'ご利用になった設備やサービスをお選びください(複数選べます)', example: '駐車場 / キッズスペース / 完全予約制' },
    ] },
    { value: 'food', name: '飲食', hint: 'カフェ・居酒屋・レストランなど', kinds: [
        { value: 'menu', name: '召し上がったもの', label: '今回召し上がったものをお選びください(複数選べます)', example: 'ランチセット / 自家製デザート / 地酒' },
        { value: 'scene', name: 'ご利用のシーン', label: '今回のご利用のシーンをお選びください(複数選べます)', example: 'デート / 記念日 / 女子会' },
        { ...REASON, example: '駅から近い / 個室がある / 夜遅くまで営業' },
        { value: 'facility', name: '設備・サービス', label: 'ご利用になった設備やサービスをお選びください(複数選べます)', example: '個室 / テラス席 / テイクアウト' },
    ] },
    { value: 'massage', name: 'マッサージ', hint: '整体・リラクゼーションなど', kinds: [
        { value: 'menu', name: '受けられたコース', label: '今回受けられたコースをお選びください(複数選べます)', example: '全身もみほぐし / 足つぼ / ヘッドマッサージ' },
        { value: 'concern', name: 'お悩みの部位', label: '今回ご相談された、お悩みの部位をお選びください(複数選べます)', example: '肩 / 腰 / 首' },
        { ...REASON, example: '駅から近い / 夜遅くまで営業 / 当日予約ができる' },
        { value: 'facility', name: '設備・サービス', label: 'ご利用になった設備やサービスをお選びください(複数選べます)', example: '個室 / 着替えの貸し出し / 駐車場' },
    ] },
    { value: 'car', name: '中古車販売', hint: '中古車の販売・買取など', kinds: [
        { value: 'service', name: 'ご利用の内容', label: '今回のご利用の内容をお選びください(複数選べます)', example: '車の購入 / 下取り / 車検' },
        { value: 'type', name: 'お車のタイプ', label: 'ご購入・ご検討されたお車のタイプをお選びください(複数選べます)', example: '軽自動車 / ミニバン / SUV' },
        { ...REASON, example: '在庫の多さ / 保証がある / 自宅から近い' },
        { value: 'support', name: '受けられたサービス', label: '今回受けられたサービスをお選びください(複数選べます)', example: '試乗 / ローンの相談 / 納車前の点検' },
    ] },
    { value: 'realestate', name: '不動産', hint: '賃貸・売買・管理など', kinds: [
        { value: 'service', name: 'ご相談の内容', label: '今回ご相談された内容をお選びください(複数選べます)', example: '賃貸のお部屋探し / 購入 / 売却の査定' },
        { value: 'type', name: '物件の種類', label: 'ご検討された物件の種類をお選びください(複数選べます)', example: '1LDK / ファミリー向け / 戸建て' },
        { ...REASON, example: '駅から近い / 土日も相談できる / オンラインで相談できる' },
        { value: 'support', name: '受けられたサービス', label: '今回受けられたサービスをお選びください(複数選べます)', example: '内見 / オンライン相談 / 契約の説明' },
    ] },
    { value: 'other', name: 'その他の業種', hint: '上にない業種', kinds: KEYWORD_QUESTION_KINDS },
];

/** 「業種」の欄の言葉から、ひな型の業種を推し量る(分からなければ '') */
export function guessKeywordIndustry(category) {
    const t = String(category ?? '');
    if (!t.trim()) return '';
    if (/マッサージ|整体|リラク|もみほぐし|整骨|接骨|カイロ|指圧|足つぼ|鍼灸/.test(t)) return 'massage';
    if (/美容|ヘア|理容|バーバー|床屋|ネイル|まつげ|まつ毛|アイラッシュ|エステ|脱毛|眉/.test(t)) return 'beauty';
    if (/中古車|自動車|車/.test(t)) return 'car';
    if (/不動産|賃貸|売買|住宅|マンション|物件/.test(t)) return 'realestate';
    if (/飲食|カフェ|喫茶|居酒屋|レストラン|食堂|ラーメン|焼肉|寿司|鮨|バル|ダイニング|ビストロ|ベーカリー|パン|スイーツ|ケーキ|そば|うどん|定食|焼き鳥|焼鳥|イタリアン|フレンチ|中華|和食|料理|バー/.test(t)) return 'food';
    return '';
}

/** 業種のひな型(見つからなければ「その他の業種」) */
export function keywordIndustry(industry) {
    return KEYWORD_INDUSTRIES.find(x => x.value === industry) || KEYWORD_INDUSTRIES[KEYWORD_INDUSTRIES.length - 1];
}

/** ひな型の質問を作る。kind:質問の種類の value / keywords:選択肢に入れるキーワード / makeId:IDを作る関数 / industry:業種(省略すると「その他の業種」) */
export function keywordQuestion(kind, keywords, makeId, industry = 'other') {
    const kinds = keywordIndustry(industry).kinds;
    const k = kinds.find(x => x.value === kind) || kinds[0];
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
