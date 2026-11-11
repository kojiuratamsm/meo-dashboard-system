// survey-page.js
// お客様がスマートフォンで開くアンケートの画面(survey.html)。
//   ① アンケート →(回答を保存)→ ② AIが作った文章 → ③ 回答のお礼
// ・②は、お店にGoogle口コミURLが設定されているときだけ表示する(未設定なら ①→③)。
// ・星の数や回答の内容によって、②の表示を変えない(全員に同じ画面を出す)。
// ・「文章を送信する」は、文章をコピーしてGoogleの口コミ画面を開くだけ。貼り付けと投稿は、お客様自身が行う。

import { supabase } from './supabase-config.js';
import { renderSurveyForm, SURVEY_FORM_CSS } from './survey-lib.js';

document.head.append(Object.assign(document.createElement('style'), { textContent: SURVEY_FORM_CSS }));

const $ = (id) => document.getElementById(id);
const steps = ['step-loading', 'step-closed', 'step-form', 'step-draft', 'step-done'];
const show = (id) => { steps.forEach(s => { $(s).hidden = s !== id; }); window.scrollTo(0, 0); };

const slug = new URLSearchParams(location.search).get('s') || '';
const DRAFT_API = '/api/public/draft';
const DRAFT_TIMEOUT_MS = 25000;

let response = null;   // { response_id, action_token, google_review_url }
const draft = { available: false, original: '', remaining: 0, length: 'short', busy: false };

// ---- この端末での進み具合(再読み込みや「戻る」で、同じ回答を二重に送らないため) ----
const STORE_KEY = `neo_survey_${slug}`;
function saveState(extra = {}) {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ ...response, ...extra })); } catch { /* 保存できなくても続ける */ }
}
function loadState() {
    try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}

async function recordAction(action, edited = null) {
    if (!response) return;
    // 記録を待ちすぎて画面の移動が遅れないよう、最大1.5秒で先に進む
    await Promise.race([
        supabase.rpc('neo_record_review_action', { p_response_id: response.response_id, p_token: response.action_token, p_action: action, p_edited: edited }),
        new Promise(r => setTimeout(r, 1500)),
    ]).catch(() => {});
}

// ---- ③ 回答のお礼 ----
function showDone({ sent = false, text = '', copied = false } = {}) {
    const url = response?.google_review_url || '';
    const box = $('doneCopy');
    if (sent && url) {
        box.hidden = false;
        $('doneText').textContent = '回答はお店に届きました。';
        $('doneCopyTitle').textContent = text
            ? (copied ? '文章はコピーされています' : '文章を自動でコピーできませんでした。下のボタンでコピーしてください')
            : 'Googleの口コミ画面を開きました';
        $('doneDraft').hidden = !text;
        $('doneDraft').value = text;
        $('btnCopyAgain').hidden = !text;
        $('reopenLink').href = url;
    } else {
        box.hidden = true;
        $('doneText').textContent = 'またのご来店をお待ちしております。';
    }
    show('step-done');
}

// 文章をコピーする。タップの処理の中で、すぐに実行する必要がある(後回しにするとiPhoneでは拒否される)。
// 戻り値:コピーできたかどうか(true/false)を返す Promise
function copyText(text, field) {
    let ok = false;
    try {   // 以前からある方法(タップの中なら、その場で結果が分かる)
        field.focus(); field.select(); field.setSelectionRange(0, field.value.length);
        ok = document.execCommand('copy');
        field.blur();
    } catch { ok = false; }
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => ok);
    }
    return Promise.resolve(ok);
}

// ---- ② AIが作った文章 ----
function renderDraft(message = '') {
    const ok = draft.available;
    $('draftTitle').textContent = ok ? '文章ができました' : '口コミの文章';
    $('draftNote').textContent = ok
        ? 'アンケートの回答をもとにAIが作った文章です。ご自身の体験と合っているか、確認してください。'
        : '文章を自動で作れませんでした。お手数ですが、ご自身の言葉でお書きください。空欄のまま進むこともできます。';
    $('lengthSeg').hidden = !ok;
    $('btnRegen').hidden = !ok;
    const canRegen = ok && draft.remaining > 0 && !draft.busy;
    $('lengthSeg').querySelectorAll('button').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.length === draft.length));
        b.disabled = !canRegen && b.dataset.length !== draft.length;
    });
    $('btnRegen').disabled = !canRegen;
    $('btnRegen').textContent = draft.busy ? '文章を作っています…'
        : draft.remaining > 0 ? `別の文章にする(あと${draft.remaining}回)` : '作り直しは上限に達しました';
    $('draftText').disabled = draft.busy;
    $('btnSend').disabled = draft.busy;
    $('draftMsg').textContent = message;
}

// サーバーに文章の生成を頼む。成功したら true
async function requestDraft(length) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);
    try {
        const res = await fetch(DRAFT_API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ response_id: response.response_id, action_token: response.action_token, length }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok || !data.text) {
            if (data && typeof data.remaining === 'number') draft.remaining = data.remaining;
            if (data?.reason === 'response_limit') draft.remaining = 0;
            return false;
        }
        draft.available = true;
        draft.original = data.text;
        draft.length = length;
        draft.remaining = Number(data.remaining) || 0;
        $('draftText').value = data.text;
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function regenerate(length) {
    if (draft.busy || draft.remaining <= 0) return;
    const current = $('draftText').value;
    if (current !== draft.original && !confirm('書き直した内容は消えて、新しい文章に置き換わります。よろしいですか?')) return;
    draft.busy = true; renderDraft();
    const ok = await requestDraft(length);
    draft.busy = false;
    renderDraft(ok ? '' : '新しい文章を作れませんでした。今の文章をそのままお使いください。');
}

function bindDraftStep() {
    $('lengthSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.length !== draft.length) regenerate(b.dataset.length);
    }));
    $('btnRegen').addEventListener('click', () => regenerate(draft.length));

    // 「文章を送信する」:コピーして、Googleの口コミ画面を開く(貼り付けと投稿は、お客様自身が行う)
    $('btnSend').addEventListener('click', async () => {
        const url = response?.google_review_url;
        if (!url) { showDone(); return; }
        const field = $('draftText');
        const text = field.value.trim();
        const copying = text ? copyText(text, field) : Promise.resolve(false);
        // タップの処理の中で開く(後回しにすると、ポップアップとして止められる)
        let opened = null;
        try { opened = window.open(url, '_blank'); if (opened) opened.opener = null; } catch { opened = null; }
        const copied = await copying;
        const action = !text ? 'self_write' : copied ? 'copied_and_opened' : 'copy_failed_opened';
        const edited = draft.available ? text !== draft.original.trim() : null;
        saveState({ stage: 'done', sent: true, text, copied });
        showDone({ sent: true, text, copied });
        await recordAction(action, edited);
        // 新しいタブを開けなかった場合(アプリ内のブラウザなど)は、この画面のままGoogleへ移動する。
        // 「戻る」で戻ると、③の画面が表示される。
        if (!opened) location.href = url;
    });

    $('btnSkip').addEventListener('click', async () => {
        saveState({ stage: 'done', sent: false });
        showDone();
        await recordAction('declined');
    });

    $('btnCopyAgain').addEventListener('click', async () => {
        const ok = await copyText($('doneDraft').value, $('doneDraft'));
        $('doneCopyTitle').textContent = ok ? '文章をコピーしました' : 'コピーできませんでした。文章を長押しして、コピーしてください';
    });
}

// ---- ① アンケート ----
function bindProgress(form, collect, total) {
    const update = () => {
        const done = Object.keys(collect().answers).length;
        $('progressFill').style.width = total ? `${Math.round(done / total * 100)}%` : '0';
        $('progressText').textContent = `${total}問中${done}問`;
    };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();
}

async function init() {
    if (!slug) { show('step-closed'); return; }
    const { data: survey, error } = await supabase.rpc('neo_get_public_survey', { p_slug: slug });
    if (error || !survey) { show('step-closed'); return; }

    document.title = `${survey.store_name} アンケート`;
    $('storeName').textContent = survey.store_name;
    $('intro').textContent = survey.intro_text || '';
    bindDraftStep();

    // すでに回答を送っている場合(再読み込み・Googleから「戻る」)は、③を表示する
    const saved = loadState();
    if (saved?.response_id) {
        response = saved;
        $('intro').textContent = '';
        showDone({ sent: !!saved.sent, text: saved.text || '', copied: !!saved.copied });
        return;
    }

    // 追加SQL_8 の実行前は review_enabled が返らない。その場合は、回答後に返るURLで判断する。
    const reviewEnabled = survey.review_enabled !== false;
    const submitLabel = reviewEnabled ? '文章を生成する' : '回答を送信する';
    const questions = survey.questions || [];

    const { form, collect } = renderSurveyForm($('formArea'), questions, {
        submitLabel,
        onSubmit: async (answers, button) => {
            const box = $('formError');
            box.style.display = 'none';
            button.disabled = true;
            button.textContent = reviewEnabled ? '文章を作っています…' : '送信中...';
            const restore = () => { button.disabled = false; button.textContent = submitLabel; };

            // 回答は1回だけ保存する(文章の生成に失敗して、もう一度押された場合に二重に保存しない)
            if (!response) {
                const { data, error } = await supabase.rpc('neo_submit_survey_response', { p_slug: slug, p_answers: answers });
                if (error) {
                    restore();
                    const msg = String(error.message || '');
                    if (msg.includes('survey_not_available')) { show('step-closed'); return; }
                    box.textContent = msg.includes('rate_limited')
                        ? '短い時間に何度も送信されています。しばらく時間をおいてからお試しください。'
                        : msg.includes('required_missing')
                            ? '必須の項目が入力されていません。'
                            : '送信できませんでした。電波の良い場所で、もう一度お試しください。';
                    box.style.display = 'block';
                    window.scrollTo(0, 0);
                    return;
                }
                response = data;
                saveState({ stage: 'draft' });
            }

            $('intro').textContent = '';
            if (!response.google_review_url) { saveState({ stage: 'done', sent: false }); showDone(); return; }

            // AIに文章を作ってもらう。作れなかった場合は、自分で書く画面にする。
            await requestDraft('short');
            renderDraft();
            show('step-draft');
        },
    });
    bindProgress(form, collect, questions.length);
    show('step-form');
}

init();
