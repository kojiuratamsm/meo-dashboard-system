// survey-lib.js
// アンケート機能の共通部品(管理画面・公開ページ・店舗オーナー画面で共用)

export const QUESTION_TYPES = [
    { value: 'stars', label: '星5段階評価' },
    { value: 'single', label: '単一選択(ラジオ)' },
    { value: 'multi', label: '複数選択(チェック)' },
    { value: 'dropdown', label: 'プルダウン' },
    { value: 'short_text', label: '短文' },
    { value: 'long_text', label: '長文' },
];
export const CHOICE_TYPES = new Set(['single', 'multi', 'dropdown']);
export const TYPE_LABEL = Object.fromEntries(QUESTION_TYPES.map(t => [t.value, t.label]));

export const REVIEW_ACTION_LABEL = {
    copied_and_opened: 'コピーしてGoogleを開いた',
    copy_failed_opened: 'Googleを開いた(コピー失敗)',
    self_write: '自分で書く(Googleを開いた)',
    declined: '今回は投稿しない',
};

// 選択肢に入れると「宣伝文」になりやすい語(設計書 6-2)
export const PROMO_WORDS = ['一番', '最高', '絶対', 'おすすめ', 'オススメ', 'お勧め', 'No.1', 'NO.1', 'ナンバーワン', '日本一', '地域一', '業界一', '間違いない', '最強', '完璧', '神'];

export function findPromoWords(text) {
    const t = String(text || '');
    return PROMO_WORDS.filter(w => t.toLowerCase().includes(w.toLowerCase()));
}

// DB の制約と同じ条件(https で始まり、ドメインを含む)
const REVIEW_URL_RE = /^https:\/\/[^\s/?#]+\.[^\s]+$/;
export function checkReviewUrl(url) {
    const u = String(url || '').trim();
    if (!u) return { ok: false, message: 'GoogleクチコミURLを入力してください(公開の条件です)。' };
    if (!u.startsWith('https://')) return { ok: false, message: 'https:// で始まるURLを入力してください。' };
    try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.') || !REVIEW_URL_RE.test(u)) throw new Error();
    } catch {
        return { ok: false, message: 'URLの形式が正しくありません。貼り付けたURLをご確認ください。' };
    }
    return { ok: true, message: '正しい形式です。「リンクを確認」で、その店舗のクチコミ画面が開くか確かめてください。' };
}

export function newId(prefix) {
    const rand = (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
    return `${prefix}_${rand.slice(0, 10)}`;
}

export function newQuestion(type = 'single') {
    const q = { id: newId('q'), type, label: '', required: false };
    if (CHOICE_TYPES.has(type)) q.options = [{ id: newId('o'), label: '' }];
    return q;
}

function opts(labels) { return labels.map(label => ({ id: newId('o'), label })); }

// MapOn NEO で新しくアンケートを作ったときの初期内容(業種を問わない共通の形)
export const DEFAULT_INTRO = '本日はご来店ありがとうございました！\nよろしければ、簡単なアンケートにご協力ください(1分ほどで終わります)';
export function defaultQuestions() {
    return [
        { id: newId('q'), type: 'stars', label: '本日の満足度を教えてください', required: true },
        { id: newId('q'), type: 'multi', label: '良かった点', required: false, options: opts(['商品・サービスの内容', 'スタッフの対応', 'お店の雰囲気', '価格', '特になし']) },
        { id: newId('q'), type: 'multi', label: '気になった点', required: false, options: opts(['特になし', '待ち時間', '料金', 'その他']) },
        { id: newId('q'), type: 'long_text', label: 'ご感想(ご自由にお書きください)', required: false },
    ];
}

// 業種別のひな形(設計書 6-2 のルールに沿い、「気になった点」を必ず含める)
export const TEMPLATES = {
    restaurant: {
        name: '飲食店',
        intro: '本日はご来店ありがとうございました。\nよろしければ、簡単なアンケートにご協力ください(1分ほどで終わります)。',
        questions: () => [
            { id: newId('q'), type: 'stars', label: '本日の満足度を教えてください', required: true },
            { id: newId('q'), type: 'single', label: 'ご利用のシーン', required: true, options: opts(['ランチ', '夜ご飯', '飲み会・宴会', 'デート', 'お一人で', 'その他']) },
            { id: newId('q'), type: 'multi', label: '召し上がったもの', required: false, options: opts(['(メニュー名に書き換えてください)', 'その他']) },
            { id: newId('q'), type: 'multi', label: '良かった点', required: false, options: opts(['料理の味', '接客', 'お店の雰囲気', '価格', '提供の早さ', '特になし']) },
            { id: newId('q'), type: 'multi', label: '気になった点', required: false, options: opts(['特になし', '待ち時間', '料金', '席・雰囲気', '接客', 'その他']) },
            { id: newId('q'), type: 'long_text', label: 'ご感想(ご自由にお書きください)', required: false },
        ],
    },
    beauty: {
        name: '整体・美容',
        intro: '本日はご来店ありがとうございました。\nよろしければ、簡単なアンケートにご協力ください(1分ほどで終わります)。',
        questions: () => [
            { id: newId('q'), type: 'stars', label: '本日の満足度を教えてください', required: true },
            { id: newId('q'), type: 'multi', label: '受けられたメニュー', required: true, options: opts(['(メニュー名に書き換えてください)', 'その他']) },
            { id: newId('q'), type: 'single', label: 'ご来店のきっかけ', required: false, options: opts(['Googleマップ', 'インターネット検索', 'SNS', 'ご紹介', '通りがかり', 'その他']) },
            { id: newId('q'), type: 'multi', label: '良かった点', required: false, options: opts(['施術・技術', '説明のわかりやすさ', '接客', '清潔さ', '予約の取りやすさ', '特になし']) },
            { id: newId('q'), type: 'multi', label: '気になった点', required: false, options: opts(['特になし', '待ち時間', '料金', '予約の取りにくさ', 'その他']) },
            { id: newId('q'), type: 'long_text', label: 'ご感想(ご自由にお書きください)', required: false },
        ],
    },
    clinic: {
        name: 'クリニック',
        intro: '本日はご来院ありがとうございました。\nよろしければ、簡単なアンケートにご協力ください(1分ほどで終わります)。',
        questions: () => [
            { id: newId('q'), type: 'stars', label: '本日の満足度を教えてください', required: true },
            { id: newId('q'), type: 'single', label: 'ご来院の目的', required: false, options: opts(['(診療科目に書き換えてください)', 'その他']) },
            { id: newId('q'), type: 'multi', label: '良かった点', required: false, options: opts(['説明のわかりやすさ', 'スタッフの対応', '院内の清潔さ', '待ち時間の短さ', '特になし']) },
            { id: newId('q'), type: 'multi', label: '気になった点', required: false, options: opts(['特になし', '待ち時間', '予約の取りにくさ', '説明', 'その他']) },
            { id: newId('q'), type: 'long_text', label: 'ご感想(ご自由にお書きください)', required: false },
        ],
    },
    other: {
        name: 'その他',
        intro: '本日はご利用ありがとうございました。\nよろしければ、簡単なアンケートにご協力ください(1分ほどで終わります)。',
        questions: () => [
            { id: newId('q'), type: 'stars', label: '本日の満足度を教えてください', required: true },
            { id: newId('q'), type: 'multi', label: '良かった点', required: false, options: opts(['サービスの内容', 'スタッフの対応', '価格', '特になし']) },
            { id: newId('q'), type: 'multi', label: '気になった点', required: false, options: opts(['特になし', '待ち時間', '料金', 'その他']) },
            { id: newId('q'), type: 'long_text', label: 'ご感想(ご自由にお書きください)', required: false },
        ],
    },
};

export function surveyPublicUrl(slug, origin = location.origin) {
    return `${origin}/survey?s=${encodeURIComponent(slug)}`;
}

// 回答の値を、表示用の文字列にする(選択肢はIDから表記に戻す)
export function formatAnswer(question, value) {
    if (value === undefined || value === null || value === '') return '';
    if (question.type === 'stars') return '★'.repeat(Number(value)) + '☆'.repeat(5 - Number(value));
    if (CHOICE_TYPES.has(question.type)) {
        const byId = Object.fromEntries((question.options || []).map(o => [o.id, o.label]));
        const ids = Array.isArray(value) ? value : [value];
        return ids.map(id => byId[id] ?? '(削除された選択肢)').join('、');
    }
    return String(value);
}

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

/**
 * アンケートの入力フォームを描画する(公開ページとプレビューで共用)。
 * 文字はすべて textContent で入れる(HTMLとして解釈しない)。
 * @returns {{ form: HTMLFormElement, collect: () => ({answers, missing: string[]}) }}
 */
export function renderSurveyForm(container, questions, { onSubmit, submitLabel = '回答を送信する', disabled = false } = {}) {
    const form = el('form', { class: 'sv-form', novalidate: true });
    questions.forEach((q, index) => {
        const block = el('fieldset', { class: 'sv-q', 'data-qid': q.id });
        const legend = el('legend', { class: 'sv-q-label' }, q.label || `設問${index + 1}`,
            q.required ? el('span', { class: 'sv-req', text: '必須' }) : el('span', { class: 'sv-opt', text: '任意' }));
        block.append(legend);
        const name = `q_${q.id}`;
        if (q.type === 'stars') {
            const wrap = el('div', { class: 'sv-stars', role: 'radiogroup', 'aria-label': q.label });
            for (let n = 1; n <= 5; n++) {
                const id = `${name}_${n}`;
                wrap.append(
                    el('input', { type: 'radio', name, id, value: String(n), class: 'sv-star-input' }),
                    el('label', { for: id, class: 'sv-star', title: `${n}`, 'aria-label': `星${n}` }, '★')
                );
            }
            block.append(wrap);
        } else if (q.type === 'single' || q.type === 'multi') {
            const type = q.type === 'single' ? 'radio' : 'checkbox';
            const list = el('div', { class: 'sv-choices' });
            (q.options || []).forEach(o => {
                const id = `${name}_${o.id}`;
                list.append(el('label', { class: 'sv-choice', for: id },
                    el('input', { type, name, id, value: o.id }), el('span', { text: o.label })));
            });
            block.append(list);
        } else if (q.type === 'dropdown') {
            const select = el('select', { name, class: 'sv-input' }, el('option', { value: '', text: '選択してください' }));
            (q.options || []).forEach(o => select.append(el('option', { value: o.id, text: o.label })));
            block.append(select);
        } else if (q.type === 'short_text') {
            block.append(el('input', { type: 'text', name, class: 'sv-input', maxlength: '200' }));
        } else {
            block.append(el('textarea', { name, class: 'sv-input sv-textarea', maxlength: '2000', rows: '4' }));
        }
        block.append(el('p', { class: 'sv-error', text: 'この項目は必須です。' }));
        form.append(block);
    });

    const button = el('button', { type: 'submit', class: 'sv-submit', disabled }, submitLabel);
    form.append(button);

    const collect = () => {
        const answers = {};
        const missing = [];
        for (const q of questions) {
            const name = `q_${q.id}`;
            let value = null;
            if (q.type === 'stars') {
                const c = form.querySelector(`input[name="${name}"]:checked`);
                value = c ? Number(c.value) : null;
            } else if (q.type === 'single') {
                const c = form.querySelector(`input[name="${name}"]:checked`);
                value = c ? c.value : null;
            } else if (q.type === 'multi') {
                value = Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map(c => c.value);
                if (value.length === 0) value = null;
            } else {
                const input = form.querySelector(`[name="${name}"]`);
                value = input && input.value.trim() ? input.value.trim() : null;
            }
            if (value !== null) answers[q.id] = value;
            else if (q.required) missing.push(q.id);
        }
        return { answers, missing };
    };

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const result = collect();
        form.querySelectorAll('.sv-q').forEach(b => b.classList.toggle('sv-has-error', result.missing.includes(b.dataset.qid)));
        if (result.missing.length) {
            form.querySelector('.sv-has-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        onSubmit?.(result.answers, button);
    });

    container.replaceChildren(form);
    return { form, collect };
}

// 公開ページ・プレビュー共通の見た目
export const SURVEY_FORM_CSS = `
.sv-form { display: flex; flex-direction: column; gap: 14px; }
.sv-q { border: none; background: #fff; border-radius: 14px; padding: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
.sv-q-label { font-weight: 700; font-size: 15px; color: #2D3748; margin-bottom: 10px; line-height: 1.5; padding: 0; }
.sv-req, .sv-opt { font-size: 11px; border-radius: 4px; padding: 1px 6px; margin-left: 8px; vertical-align: middle; font-weight: 700; }
.sv-req { background: #FEECEB; color: #D93025; }
.sv-opt { background: #EDF2F7; color: #718096; }
.sv-stars { display: flex; gap: 6px; }
.sv-star-input { position: absolute; opacity: 0; pointer-events: none; }
.sv-star { font-size: 34px; color: #CBD5E0; cursor: pointer; line-height: 1; user-select: none; }
.sv-stars:has(.sv-star-input:checked) .sv-star { color: #F6B000; }
.sv-stars .sv-star-input:checked + .sv-star ~ .sv-star { color: #CBD5E0; }
.sv-star-input:focus-visible + .sv-star { outline: 2px solid #4285F4; border-radius: 4px; }
.sv-choices { display: flex; flex-direction: column; gap: 8px; }
.sv-choice { display: flex; align-items: center; gap: 10px; border: 1px solid #E2E8F0; border-radius: 10px; padding: 12px; font-size: 15px; cursor: pointer; }
.sv-choice input { width: 18px; height: 18px; accent-color: #4285F4; flex: none; }
.sv-choice:has(input:checked) { border-color: #4285F4; background: #EEF4FF; }
.sv-input { width: 100%; font-size: 16px; padding: 12px; border: 1px solid #E2E8F0; border-radius: 10px; font-family: inherit; background: #fff; }
.sv-textarea { resize: vertical; min-height: 96px; }
.sv-error { display: none; color: #D93025; font-size: 12px; margin-top: 8px; }
.sv-has-error { box-shadow: 0 0 0 2px #F28B82; }
.sv-has-error .sv-error { display: block; }
.sv-submit { background: #4285F4; color: #fff; border: none; border-radius: 12px; padding: 16px; font-size: 16px; font-weight: 700; cursor: pointer; }
.sv-submit:disabled { opacity: 0.6; cursor: default; }
`;
