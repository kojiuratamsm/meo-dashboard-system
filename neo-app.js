// neo-app.js
// MapOn NEO の管理画面(アンケートの作成・編集・公開・QR・回答一覧)
// 1つの店舗(契約者)の中だけで動く。契約者本人も、マスター(MSMスタッフ)も同じ画面を使う。
//   #/                 アンケート一覧
//   #/new              新規作成
//   #/edit/<id>        作成・編集
//   #/responses/<id>   回答一覧・集計

import { supabase } from './supabase-config.js';
import {
    QUESTION_TYPES, CHOICE_TYPES, DEFAULT_INTRO, defaultQuestions, SURVEY_FORM_CSS,
    checkReviewUrl, findPromoWords, newId, newQuestion, surveyPublicUrl, el, renderSurveyForm,
} from './survey-lib.js';
import { reviewUrlGuide, GUIDE_CSS } from './neo-guide.js';
import { RESULTS_CSS, renderResults, makeQrCanvas, downloadQrPng } from './survey-results.js';

let app = null;               // 描画先
let client = null;            // 対象の店舗(契約者)の clients 行
let isMasterView = false;     // マスター(MSMスタッフ)が契約者の画面を見ているか
let onStoreNameChange = () => {};
let dirty = false;            // 編集中で未保存の変更があるか
let revertingHash = false;    // 「移動しない」を選んだときにURLを戻している最中か

window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

const clientName = () => client?.company_name || '';

function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso); const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

function showError(message) {
    app.replaceChildren(el('div', { class: 'card' }, el('p', { style: { color: 'var(--danger)' }, text: message }),
        el('a', { href: '#/', class: 'btn sub', style: { marginTop: '12px' } }, '一覧に戻る')));
}

function openModal(content, { wide = false } = {}) {
    const bg = el('div', { class: 'modal-bg' });
    const box = el('div', { class: 'modal' + (wide ? ' wide' : '') }, content);
    bg.append(box);
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
    document.body.append(bg);
    return { close: () => bg.remove(), box };
}

// ------------------------------------------------------------
// ルーティング
// ------------------------------------------------------------
async function route() {
    const hash = location.hash || '#/';
    const [, view, id] = hash.split('/');
    document.querySelectorAll('.nav-item[data-view]').forEach(a =>
        a.classList.toggle('active', a.dataset.view === (view === 'settings' ? 'settings' : 'surveys')));
    try {
        if (view === 'settings') return renderSettings();
        if (view === 'new') return await renderEditor(null);
        if (view === 'edit' && id) return await renderEditor(id);
        if (view === 'responses' && id) return await renderResponsesPage(id);
        return await renderList();
    } catch (e) {
        console.error(e);
        showError('読み込みに失敗しました: ' + (e.message || e));
    }
}

let lastHash = location.hash;
window.addEventListener('hashchange', () => {
    if (revertingHash) { revertingHash = false; return; }
    if (dirty && !confirm('保存していない変更があります。移動すると変更は失われます。移動しますか?')) {
        revertingHash = true;
        location.hash = lastHash;
        return;
    }
    dirty = false;
    lastHash = location.hash;
    route();
});
function go(hash) { dirty = false; location.hash = hash; }

// ------------------------------------------------------------
// 一覧
// ------------------------------------------------------------
async function renderList() {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    const [{ data: surveys, error }, { data: stats }] = await Promise.all([
        supabase.from('neo_surveys').select('id, client_id, title, is_published, public_slug, google_review_url, updated_at, questions')
            .eq('client_id', client.id).is('deleted_at', null).order('updated_at', { ascending: false }),
        supabase.from('neo_survey_stats').select('*'),
    ]);
    if (error) throw error;
    const statBy = Object.fromEntries((stats || []).map(s => [s.survey_id, s]));

    const tbody = el('tbody');

    const draw = () => {
        const list = surveys || [];
        if (!list.length) {
            tbody.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'muted', style: { textAlign: 'center', padding: '30px' }, text: 'アンケートはまだありません。「新規作成」から作成してください。' })));
            return;
        }
        tbody.replaceChildren(...list.map(s => {
            const st = statBy[s.id];
            return el('tr', {},
                el('td', {}, el('a', { href: `#/edit/${s.id}`, style: { color: 'var(--primary-blue)', fontWeight: '700', textDecoration: 'none' }, text: s.title })),
                el('td', {}, el('span', { class: 'badge ' + (s.is_published ? 'on' : 'off'), text: s.is_published ? '公開中' : '非公開' })),
                el('td', { text: st ? `${st.response_count}件` : '0件' }),
                el('td', { text: st?.avg_star ? Number(st.avg_star).toFixed(2) : '-' }),
                el('td', { class: 'muted', text: fmtDate(s.updated_at) }),
                el('td', {}, el('div', { class: 'row', style: { flexWrap: 'nowrap' } },
                    el('a', { href: `#/edit/${s.id}`, class: 'btn small' }, '編集'),
                    el('a', { href: `#/responses/${s.id}`, class: 'btn small dark' }, '回答'),
                    el('button', { class: 'btn small sub', onclick: () => openQrModal(s) }, 'QR'),
                    el('button', { class: 'btn small sub', onclick: () => duplicate(s) }, '複製'),
                    el('button', { class: 'btn small sub', onclick: () => togglePublish(s) }, s.is_published ? '非公開にする' : '公開する'),
                    el('button', { class: 'btn small danger', onclick: () => remove(s) }, '削除'))));
        }));
    };

    app.replaceChildren(
        el('div', { class: 'page-title' }, 'アンケート', el('a', { href: '#/new', class: 'btn' }, el('i', { class: 'fa-solid fa-plus' }), '新規作成')),
        el('div', { class: 'card' },
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['タイトル', '状態', '回答', '星の平均', '更新日時', '操作'].map(h => el('th', { text: h })))),
                tbody))));
    draw();

    async function duplicate(s) {
        const { data, error } = await supabase.rpc('neo_duplicate_survey', { p_survey_id: s.id });
        if (error) return alert('複製できませんでした: ' + error.message);
        go(`#/edit/${data}`);
    }
    async function togglePublish(s) {
        if (!s.is_published) {
            const check = checkReviewUrl(s.google_review_url);
            if (!check.ok) return alert('公開できません。' + check.message + '\n編集画面でGoogleクチコミURLを設定してください。');
        }
        const { error } = await supabase.from('neo_surveys').update({ is_published: !s.is_published }).eq('id', s.id);
        if (error) return alert('変更できませんでした: ' + error.message);
        renderList();
    }
    async function remove(s) {
        if (!confirm(`「${s.title}」を削除しますか?\n公開ページは表示されなくなります。これまでの回答データは残ります。`)) return;
        const { error } = await supabase.from('neo_surveys').update({ deleted_at: new Date().toISOString(), is_published: false }).eq('id', s.id);
        if (error) return alert('削除できませんでした: ' + error.message);
        renderList();
    }
}

// ------------------------------------------------------------
// 作成・編集
// ------------------------------------------------------------
// 設問の書き方ガイドのURL(マスター画面で設定)。未設定・読み込み失敗のときは空
async function loadQuestionGuideUrl() {
    try {
        const { data, error } = await supabase.from('neo_settings').select('value').eq('key', 'question_guide_url').maybeSingle();
        if (error) return '';
        const url = String(data?.value || '').trim();
        return /^https:\/\/\S+$/.test(url) ? url : '';
    } catch { return ''; }
}

function questionHint(guideUrl) {
    const p = (children) => el('p', { class: 'muted', style: { marginBottom: '6px', lineHeight: '1.8' } }, ...children);
    return el('div', { style: { marginBottom: '12px' } },
        p(['選択肢は、体験をそのまま表す短い言葉にしてください。口コミに入れて欲しいキーワードが選択肢にあるとより効果的です。']),
        guideUrl ? p(['詳しくはこちらをご確認ください。',
            el('a', { href: guideUrl, target: '_blank', rel: 'noopener', class: 'btn small', style: { marginLeft: '8px' } },
                el('i', { class: 'fa-solid fa-arrow-up-right-from-square' }), '確認する')]) : null,
        p(['≡ をドラッグ、または矢印で並べ替えできます。']));
}

async function renderEditor(id) {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));

    let survey;
    let responseCount = 0;
    const guideUrl = await loadQuestionGuideUrl();
    if (id) {
        const { data, error } = await supabase.from('neo_surveys').select('*').eq('id', id).eq('client_id', client.id).is('deleted_at', null).maybeSingle();
        if (error) throw error;
        if (!data) return showError('アンケートが見つかりません(削除された可能性があります)。');
        survey = data;
        const { count } = await supabase.from('neo_survey_responses').select('id', { count: 'exact', head: true }).eq('survey_id', id);
        responseCount = count || 0;
    } else {
        survey = {
            client_id: client.id, title: '来店アンケート', intro_text: DEFAULT_INTRO,
            google_review_url: '', questions: defaultQuestions(), is_published: false,
        };
    }
    survey.questions = Array.isArray(survey.questions) ? survey.questions : [];
    dirty = false;
    const markDirty = () => { dirty = true; };

    // --- 基本 ---
    const titleInput = el('input', { class: 'input', value: survey.title, maxlength: '100' });
    titleInput.addEventListener('input', () => { survey.title = titleInput.value; markDirty(); });
    const introInput = el('textarea', { class: 'textarea', maxlength: '500' });
    introInput.value = survey.intro_text || '';
    introInput.addEventListener('input', () => { survey.intro_text = introInput.value; markDirty(); });

    // --- GoogleクチコミURL ---
    const urlInput = el('input', { class: 'input grow', value: survey.google_review_url || '', placeholder: 'https://g.page/r/XXXXXXXX/review', inputmode: 'url' });
    const urlMsg = el('p', { class: 'msg' });
    const checkUrl = () => {
        const r = checkReviewUrl(urlInput.value);
        urlMsg.className = 'msg ' + (r.ok ? 'ok' : 'ng');
        urlMsg.textContent = r.message;
        return r.ok;
    };
    urlInput.addEventListener('input', () => { survey.google_review_url = urlInput.value.trim(); markDirty(); checkUrl(); });
    const urlOpenBtn = el('button', { class: 'btn sub', type: 'button', onclick: () => {
        if (!checkUrl()) return;
        window.open(urlInput.value.trim(), '_blank', 'noopener,noreferrer');
    } }, el('i', { class: 'fa-solid fa-arrow-up-right-from-square' }), 'リンクを確認');
    if (survey.google_review_url) checkUrl();

    // --- 設問 ---
    const qArea = el('div');
    let dragIndex = null;

    function drawQuestions() {
        qArea.replaceChildren(...survey.questions.map((q, i) => questionCard(q, i)));
    }

    function questionCard(q, index) {
        const card = el('div', { class: 'q-card', 'data-index': String(index) });
        const handle = el('span', { class: 'q-handle', title: 'ドラッグして並べ替え', draggable: 'true' }, '≡');
        handle.addEventListener('dragstart', (e) => { dragIndex = index; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.setDragImage(card, 20, 20); });
        handle.addEventListener('dragend', () => { dragIndex = null; card.classList.remove('dragging'); qArea.querySelectorAll('.drop-before').forEach(c => c.classList.remove('drop-before')); });
        card.addEventListener('dragover', (e) => { if (dragIndex === null) return; e.preventDefault(); qArea.querySelectorAll('.drop-before').forEach(c => c.classList.remove('drop-before')); card.classList.add('drop-before'); });
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            if (dragIndex === null || dragIndex === index) return;
            const [moved] = survey.questions.splice(dragIndex, 1);
            survey.questions.splice(dragIndex < index ? index - 1 : index, 0, moved);
            dragIndex = null; markDirty(); drawQuestions();
        });

        const typeSelect = el('select', { class: 'select', style: { width: 'auto' } }, ...QUESTION_TYPES.map(t => el('option', { value: t.value, text: t.label })));
        typeSelect.value = q.type;
        typeSelect.addEventListener('change', () => {
            q.type = typeSelect.value;
            if (CHOICE_TYPES.has(q.type)) { if (!q.options?.length) q.options = [{ id: newId('o'), label: '' }]; }
            else delete q.options;
            markDirty(); drawQuestions();
        });
        const label = el('input', { class: 'input grow', value: q.label, placeholder: '設問文(例:ご利用のシーン)', maxlength: '200' });
        label.addEventListener('input', () => { q.label = label.value; markDirty(); });
        const req = el('input', { type: 'checkbox' }); req.checked = !!q.required;
        req.addEventListener('change', () => { q.required = req.checked; markDirty(); });

        const moveBtn = (dir, icon, title) => el('button', { class: 'icon-btn', type: 'button', title, disabled: (dir < 0 && index === 0) || (dir > 0 && index === survey.questions.length - 1),
            onclick: () => { const t = index + dir; [survey.questions[index], survey.questions[t]] = [survey.questions[t], survey.questions[index]]; markDirty(); drawQuestions(); } }, el('i', { class: `fa-solid ${icon}` }));

        card.append(el('div', { class: 'q-head' },
            handle, el('span', { class: 'q-num', text: `${index + 1}.` }), label, typeSelect,
            el('label', { class: 'muted', style: { display: 'flex', gap: '4px', alignItems: 'center' } }, req, '必須'),
            moveBtn(-1, 'fa-arrow-up', '上へ'), moveBtn(1, 'fa-arrow-down', '下へ'),
            el('button', { class: 'icon-btn', type: 'button', title: '複製', onclick: () => {
                const copy = JSON.parse(JSON.stringify(q)); copy.id = newId('q');
                if (copy.options) copy.options = copy.options.map(o => ({ ...o, id: newId('o') }));
                survey.questions.splice(index + 1, 0, copy); markDirty(); drawQuestions();
            } }, el('i', { class: 'fa-regular fa-copy' })),
            el('button', { class: 'icon-btn', type: 'button', title: '削除', onclick: () => {
                if (responseCount && !confirm('この設問を削除すると、これまでの回答でもこの設問は表示されなくなります。削除しますか?')) return;
                survey.questions.splice(index, 1); markDirty(); drawQuestions();
            } }, el('i', { class: 'fa-regular fa-trash-can' }))));

        if (CHOICE_TYPES.has(q.type)) {
            const list = el('div', { class: 'q-options' });
            const warn = el('p', { class: 'q-warn' });
            const updateWarn = () => {
                const words = [...new Set((q.options || []).flatMap(o => findPromoWords(o.label)))];
                warn.textContent = words.length ? `⚠ 宣伝的な表現が含まれています(${words.join('・')})。選択肢は体験をそのまま表す短い言葉にしてください。` : '';
                warn.hidden = !words.length;
            };
            (q.options || []).forEach((o, oi) => {
                const input = el('input', { class: 'input', value: o.label, placeholder: `選択肢${oi + 1}`, maxlength: '100' });
                input.addEventListener('input', () => { o.label = input.value; markDirty(); updateWarn(); });
                list.append(el('div', { class: 'q-option' },
                    el('span', { class: 'muted', text: q.type === 'multi' ? '□' : '○' }), input,
                    el('button', { class: 'icon-btn', type: 'button', title: '選択肢を削除', disabled: q.options.length <= 1, onclick: () => {
                        q.options.splice(oi, 1); markDirty(); drawQuestions();
                    } }, el('i', { class: 'fa-solid fa-xmark' }))));
            });
            list.append(el('div', {}, el('button', { class: 'btn sub small', type: 'button', onclick: () => {
                q.options.push({ id: newId('o'), label: '' }); markDirty(); drawQuestions();
                qArea.querySelectorAll('.q-card')[index]?.querySelector('.q-option:last-of-type input')?.focus();
            } }, '+ 選択肢を追加')));
            card.append(list, warn);
            updateWarn();
        }
        return card;
    }
    drawQuestions();

    const addQ = el('div', { class: 'row' },
        ...QUESTION_TYPES.map(t => el('button', { class: 'btn sub small', type: 'button', onclick: () => {
            survey.questions.push(newQuestion(t.value)); markDirty(); drawQuestions();
            qArea.lastElementChild?.querySelector('.q-head .input')?.focus();
        } }, `+ ${t.label}`)));

    // --- 保存・公開 ---
    function validate({ forPublish }) {
        const problems = [];
        if (!String(survey.title || '').trim()) problems.push('タイトルを入力してください。');
        if (!survey.questions.length) problems.push('設問を1つ以上追加してください。');
        survey.questions.forEach((q, i) => {
            if (!String(q.label || '').trim()) problems.push(`設問${i + 1}:設問文を入力してください。`);
            if (CHOICE_TYPES.has(q.type)) {
                if (!q.options?.length) problems.push(`設問${i + 1}:選択肢を1つ以上入れてください。`);
                if (q.options?.some(o => !String(o.label || '').trim())) problems.push(`設問${i + 1}:空欄の選択肢があります。`);
                if (forPublish && q.options?.some(o => String(o.label || '').includes('書き換えてください')))
                    problems.push(`設問${i + 1}:ひな形の「(〜に書き換えてください)」が残っています。お店のメニュー名などに書き換えてください。`);
            }
        });
        if (forPublish) {
            const r = checkReviewUrl(survey.google_review_url);
            if (!r.ok) problems.push('GoogleクチコミURL:' + r.message);
        }
        return problems;
    }

    async function save({ publish } = {}) {
        const willPublish = publish === undefined ? !!survey.is_published : publish;
        const problems = validate({ forPublish: willPublish });
        if (problems.length) { alert('保存できません。\n\n' + problems.join('\n')); return false; }
        const payload = {
            client_id: survey.client_id,
            title: survey.title.trim(),
            intro_text: survey.intro_text || '',
            google_review_url: (survey.google_review_url || '').trim() || null,
            questions: survey.questions.map(q => ({
                id: q.id, type: q.type, label: q.label.trim(), required: !!q.required,
                ...(CHOICE_TYPES.has(q.type) ? { options: q.options.map(o => ({ id: o.id, label: o.label.trim() })) } : {}),
            })),
            is_published: willPublish,
        };
        const res = survey.id
            ? await supabase.from('neo_surveys').update(payload).eq('id', survey.id).select().single()
            : await supabase.from('neo_surveys').insert(payload).select().single();
        if (res.error) { alert('保存できませんでした: ' + res.error.message); return false; }
        Object.assign(survey, res.data);
        dirty = false;
        return true;
    }

    const statusBadge = el('span', { class: 'badge ' + (survey.is_published ? 'on' : 'off'), text: survey.is_published ? '公開中' : '非公開' });
    const publishBtn = el('button', { class: 'btn green', type: 'button' }, survey.is_published ? '非公開にする' : '公開する');
    publishBtn.addEventListener('click', async () => {
        const target = !survey.is_published;
        if (await save({ publish: target })) { alert(target ? '公開しました。' : '非公開にしました。'); afterSave(); }
    });
    const saveBtn = el('button', { class: 'btn', type: 'button', onclick: async () => { if (await save()) { alert('保存しました。'); afterSave(); } } }, el('i', { class: 'fa-regular fa-floppy-disk' }), '保存');
    const previewBtn = el('button', { class: 'btn sub', type: 'button', onclick: () => openPreview(survey) }, el('i', { class: 'fa-regular fa-eye' }), 'プレビュー');
    const qrBtn = el('button', { class: 'btn dark', type: 'button', onclick: async () => {
        if (dirty || !survey.id) { if (!confirm('保存してからURL・QRコードを発行します。よろしいですか?')) return; if (!(await save())) return; afterSave(); }
        openQrModal(survey);
    } }, el('i', { class: 'fa-solid fa-qrcode' }), 'URL・QRコード発行');

    function afterSave() {
        const h = `#/edit/${survey.id}`;
        if (location.hash !== h) location.hash = h;   // 保存済み(dirty=false)なので、そのまま画面が切り替わる
        else renderEditor(survey.id);
    }

    app.replaceChildren(...[
        el('div', { class: 'page-title' },
            el('a', { href: '#/', class: 'btn sub small' }, '← 一覧'),
            id ? 'アンケートの編集' : 'アンケートの新規作成', statusBadge,
            id ? el('a', { href: `#/responses/${id}`, class: 'btn small dark' }, `回答を見る(${responseCount}件)`) : null),
        responseCount ? el('div', { class: 'warnbox', text: `このアンケートには回答が${responseCount}件あります。設問や選択肢を削除すると、過去の回答の表示・集計に影響します。大きく変える場合は「複製」して新しいアンケートを作ることをおすすめします。` }) : null,
        el('div', { class: 'card' }, el('h2', { text: '基本' }),
            el('div', { class: 'field' }, el('label', { text: 'タイトル(管理用。お客様には表示されません)' }), titleInput),
            el('div', { class: 'field' }, el('label', { text: '冒頭のあいさつ(お客様に表示されます)' }), introInput)),
        el('div', { class: 'card' }, el('h2', { text: 'GoogleクチコミURL(公開の条件)' }),
            el('div', { class: 'row' }, urlInput, urlOpenBtn), urlMsg,
            el('p', { class: 'muted', style: { marginTop: '8px' }, text: '入力例:https://g.page/r/CAbCdEfGhIjKlMnOp/review' }),
            reviewUrlGuide()),
        el('div', { class: 'card' }, el('h2', { text: '設問' }),
            questionHint(guideUrl),
            qArea, el('p', { class: 'muted', style: { margin: '10px 0 6px' }, text: '設問を追加:' }), addQ),
        el('div', { class: 'sticky-actions' }, previewBtn, qrBtn, publishBtn, saveBtn),
    ].filter(Boolean));
}

function openPreview(survey) {
    const area = el('div');
    const { close } = openModal(el('div', {},
        el('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '12px' } },
            el('h3', { text: 'プレビュー(お客様の画面)', style: { margin: 0 } }),
            el('button', { class: 'btn sub small', onclick: () => close() }, '閉じる')),
        el('div', { style: { background: '#fff', borderRadius: '14px', padding: '16px', textAlign: 'center', marginBottom: '12px' } },
            el('div', { style: { fontWeight: '700', fontSize: '18px' }, text: clientName() }),
            el('p', { style: { fontSize: '13px', color: '#4A5568', whiteSpace: 'pre-wrap', marginTop: '8px' }, text: survey.intro_text || '' })),
        area), { wide: true });
    renderSurveyForm(area, survey.questions, { onSubmit: () => alert('プレビューのため、送信はされません。'), submitLabel: '回答を送信する(プレビュー)' });
}

async function openQrModal(survey) {
    const url = surveyPublicUrl(survey.public_slug);
    const img = el('img', { class: 'qr-img', alt: 'QRコード' });
    const { close } = openModal(el('div', {},
        el('h3', { text: 'URL・QRコード' }),
        survey.is_published ? null : el('div', { class: 'warnbox', text: 'このアンケートは非公開です。公開するまで、お客様がQRを読み取っても「受け付けていません」と表示されます。' }),
        el('div', { class: 'field' }, el('label', { text: '公開アンケートのURL' }),
            el('div', { class: 'row' }, el('input', { class: 'input grow', value: url, readonly: true }),
                el('button', { class: 'btn sub', onclick: async (e) => {
                    try { await navigator.clipboard.writeText(url); e.target.textContent = 'コピーしました'; }
                    catch { prompt('コピーしてください', url); }
                } }, 'コピー'))),
        img,
        el('div', { class: 'row', style: { justifyContent: 'center' } },
            el('button', { class: 'btn', onclick: () => downloadQrPng(survey, clientName()) }, el('i', { class: 'fa-solid fa-download' }), 'QRコード(PNG・1200px)をダウンロード'),
            el('button', { class: 'btn sub', onclick: () => close() }, '閉じる'))));
    const canvas = await makeQrCanvas(url, 480);
    img.src = canvas.toDataURL('image/png');
}

// ------------------------------------------------------------
// 回答一覧
// ------------------------------------------------------------
async function renderResponsesPage(id) {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    const { data: survey, error } = await supabase.from('neo_surveys').select('*').eq('id', id).eq('client_id', client.id).maybeSingle();
    if (error) throw error;
    if (!survey) return showError('アンケートが見つかりません。');
    const area = el('div');
    app.replaceChildren(
        el('div', { class: 'page-title' },
            el('a', { href: '#/', class: 'btn sub small' }, '← 一覧'),
            `回答一覧:${survey.title}`,
            el('a', { href: `#/edit/${id}`, class: 'btn small' }, '編集')),
        el('div', { class: 'card' }, area));
    await renderResults(area, { supabase, survey });
}

// ------------------------------------------------------------
// 設定(店舗名・パスワード)
// ------------------------------------------------------------
const PASSWORD_ERRORS = [
    [/should be different|same_password/i, '今のパスワードと同じです。別のパスワードを入力してください。'],
    [/weak|at least|characters|weak_password/i, 'パスワードが簡単すぎます。8文字以上で、英字と数字を組み合わせてください。'],
    [/reauthenticat|recent login|session/i, '安全のため、一度ログアウトして、もう一度ログインしてから変更してください。'],
];

function renderSettings() {
    const msg = () => el('p', { class: 'msg' });
    const setMsg = (node, ok, text) => { node.className = 'msg ' + (ok ? 'ok' : 'ng'); node.textContent = text; };

    // 店舗名
    const nameInput = el('input', { class: 'input grow', value: client.company_name || '', maxlength: '100' });
    const nameMsg = msg();
    const nameBtn = el('button', { class: 'btn', type: 'button' }, '保存');
    nameBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) return setMsg(nameMsg, false, '店舗名を入力してください。');
        if (name === client.company_name) return setMsg(nameMsg, true, '変更はありません。');
        nameBtn.disabled = true;
        const { data, error } = await supabase.rpc('neo_update_store_name', { p_client_id: String(client.id), p_name: name });
        nameBtn.disabled = false;
        if (error) {
            const m = String(error.message || '');
            return setMsg(nameMsg, false, m.includes('Could not find') || m.includes('does not exist')
                ? '保存できませんでした(データベースの設定が必要です)。担当者にご連絡ください。'
                : '保存できませんでした。時間をおいて、もう一度お試しください。');
        }
        client.company_name = data || name;
        nameInput.value = client.company_name;
        onStoreNameChange(client.company_name);
        setMsg(nameMsg, true, '店舗名を変更しました。');
    });
    const nameCard = el('div', { class: 'card' },
        el('h2', { text: '店舗名' }),
        el('div', { class: 'row' }, nameInput, nameBtn), nameMsg,
        el('p', { class: 'muted', style: { marginTop: '8px' }, text: 'アンケートの画面で、お客様にも表示される名前です。' }));

    // パスワード(ログインしている本人のパスワードを変える。マスター表示では変えない)
    let passCard;
    if (isMasterView) {
        passCard = el('div', { class: 'card' },
            el('h2', { text: 'パスワードの変更' }),
            el('p', { class: 'muted', style: { lineHeight: '1.8' }, text: 'パスワードは、契約者ご本人がログインした画面でのみ変更できます(マスターとして表示している今の画面で変更すると、マスターのパスワードが変わってしまうため)。' }));
    } else {
        const pass1 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: '8文字以上' });
        const pass2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'もう一度入力' });
        const show = el('input', { type: 'checkbox' });
        show.addEventListener('change', () => { pass1.type = pass2.type = show.checked ? 'text' : 'password'; });
        const passMsg = msg();
        const passBtn = el('button', { class: 'btn', type: 'button' }, 'パスワードを変更する');
        passBtn.addEventListener('click', async () => {
            const p1 = pass1.value, p2 = pass2.value;
            if (!p1 || !p2) return setMsg(passMsg, false, '新しいパスワードを2回入力してください。');
            if (p1.length < 8) return setMsg(passMsg, false, 'パスワードは8文字以上にしてください。');
            if (p1 !== p2) return setMsg(passMsg, false, '1回目と2回目のパスワードが一致しません。もう一度入力してください。');
            passBtn.disabled = true;
            const { error } = await supabase.auth.updateUser({ password: p1 });
            passBtn.disabled = false;
            if (error) {
                const m = `${error.code || ''} ${error.message || ''}`;
                const hit = PASSWORD_ERRORS.find(([re]) => re.test(m));
                return setMsg(passMsg, false, hit ? hit[1] : '変更できませんでした。時間をおいて、もう一度お試しください。');
            }
            pass1.value = ''; pass2.value = ''; show.checked = false; pass1.type = pass2.type = 'password';
            setMsg(passMsg, true, 'パスワードを変更しました。次回から新しいパスワードでログインしてください。');
        });
        passCard = el('div', { class: 'card' },
            el('h2', { text: 'パスワードの変更' }),
            el('div', { class: 'field', style: { maxWidth: '420px' } }, el('label', { text: '新しいパスワード' }), pass1),
            el('div', { class: 'field', style: { maxWidth: '420px' } }, el('label', { text: '新しいパスワード(確認のため、もう一度)' }), pass2),
            el('label', { class: 'muted', style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '14px', cursor: 'pointer' } }, show, 'パスワードを表示する'),
            passBtn, passMsg);
    }

    app.replaceChildren(
        el('div', { class: 'page-title' }, '設定'),
        nameCard,
        el('div', { class: 'card' },
            el('h2', { text: 'ログイン用メールアドレス' }),
            el('p', { text: client.email || '-', style: { fontWeight: '700' } }),
            el('p', { class: 'muted', style: { marginTop: '6px' }, text: 'メールアドレスを変更したい場合は、担当者にご連絡ください。' })),
        passCard);
}

// ------------------------------------------------------------
/**
 * MapOn NEO の管理画面を起動する
 * @param {{ root: HTMLElement, client: {id, company_name} }} options
 */
export function startNeoApp({ root, client: targetClient, isMasterView: master = false, onStoreNameChange: onName }) {
    app = root;
    client = targetClient;
    isMasterView = master;
    if (onName) onStoreNameChange = onName;
    document.head.append(el('style', { text: SURVEY_FORM_CSS + RESULTS_CSS + GUIDE_CSS }));
    lastHash = location.hash;
    route();
}
