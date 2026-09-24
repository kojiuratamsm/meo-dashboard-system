// master-surveys.js
// マスター管理画面「MapOn NEO」(口コミ獲得アンケート。MSMスタッフ専用)
//   #/                 アンケート一覧
//   #/new              新規作成
//   #/edit/<id>        作成・編集
//   #/responses/<id>   回答一覧・集計

import { supabase } from './supabase-config.js';
import { requireStaff, staffLogout } from './staff-guard.js';
import {
    QUESTION_TYPES, CHOICE_TYPES, TEMPLATES, SURVEY_FORM_CSS,
    checkReviewUrl, findPromoWords, newId, newQuestion, surveyPublicUrl, el, renderSurveyForm,
} from './survey-lib.js';
import { RESULTS_CSS, renderResults, makeQrCanvas, downloadQrPng } from './survey-results.js';

document.head.append(el('style', { text: SURVEY_FORM_CSS + RESULTS_CSS }));
const app = document.getElementById('app');
document.getElementById('logoutLink').addEventListener('click', (e) => { e.preventDefault(); staffLogout(); });

let clientsCache = null;
let dirty = false;            // 編集中で未保存の変更があるか
let revertingHash = false;    // 「移動しない」を選んだときにURLを戻している最中か

window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

async function loadClients() {
    if (clientsCache) return clientsCache;
    const { data, error } = await supabase.from('clients').select('id, company_name, plan').order('company_name');
    if (error) throw error;
    clientsCache = data || [];
    return clientsCache;
}
const clientName = (id) => (clientsCache || []).find(c => String(c.id) === String(id))?.company_name || '(不明な店舗)';

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
    try {
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
    await loadClients();
    const [{ data: surveys, error }, { data: stats }] = await Promise.all([
        supabase.from('neo_surveys').select('id, client_id, title, is_published, public_slug, google_review_url, updated_at, questions')
            .is('deleted_at', null).order('updated_at', { ascending: false }),
        supabase.from('neo_survey_stats').select('*'),
    ]);
    if (error) throw error;
    const statBy = Object.fromEntries((stats || []).map(s => [s.survey_id, s]));

    const filter = el('select', { class: 'select', style: { maxWidth: '320px' } },
        el('option', { value: '', text: 'すべての店舗' }),
        ...clientsCache.map(c => el('option', { value: String(c.id), text: c.company_name })));
    filter.value = sessionStorage.getItem('mapon_survey_filter') || '';
    const tbody = el('tbody');

    const draw = () => {
        sessionStorage.setItem('mapon_survey_filter', filter.value);
        const list = (surveys || []).filter(s => !filter.value || String(s.client_id) === filter.value);
        if (!list.length) {
            tbody.replaceChildren(el('tr', {}, el('td', { colspan: '7', class: 'muted', style: { textAlign: 'center', padding: '30px' }, text: 'アンケートはまだありません。「新規作成」から作成してください。' })));
            return;
        }
        tbody.replaceChildren(...list.map(s => {
            const st = statBy[s.id];
            return el('tr', {},
                el('td', { text: clientName(s.client_id) }),
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
    filter.addEventListener('change', draw);

    app.replaceChildren(
        el('div', { class: 'page-title' }, 'MapOn NEO', el('span', { class: 'muted', text: '口コミ獲得アンケート' }), el('a', { href: '#/new', class: 'btn' }, el('i', { class: 'fa-solid fa-plus' }), '新規作成')),
        el('div', { class: 'card' },
            el('div', { class: 'row', style: { marginBottom: '14px' } }, filter),
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['店舗', 'タイトル', '状態', '回答', '星の平均', '更新日時', '操作'].map(h => el('th', { text: h })))),
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
async function renderEditor(id) {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    await loadClients();

    let survey;
    let responseCount = 0;
    if (id) {
        const { data, error } = await supabase.from('neo_surveys').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
        if (error) throw error;
        if (!data) return showError('アンケートが見つかりません(削除された可能性があります)。');
        survey = data;
        const { count } = await supabase.from('neo_survey_responses').select('id', { count: 'exact', head: true }).eq('survey_id', id);
        responseCount = count || 0;
    } else {
        const filter = sessionStorage.getItem('mapon_survey_filter') || '';
        survey = {
            client_id: filter || '', title: '来店アンケート', intro_text: TEMPLATES.restaurant.intro,
            google_review_url: '', questions: TEMPLATES.restaurant.questions(), is_published: false,
        };
    }
    survey.questions = Array.isArray(survey.questions) ? survey.questions : [];
    dirty = false;
    const markDirty = () => { dirty = true; };

    // --- 基本 ---
    const storeSelect = el('select', { class: 'select' }, el('option', { value: '', text: '店舗を選択してください' }),
        ...clientsCache.map(c => el('option', { value: String(c.id), text: c.company_name })));
    storeSelect.value = survey.client_id ? String(survey.client_id) : '';
    storeSelect.addEventListener('change', () => { survey.client_id = storeSelect.value; markDirty(); });

    const titleInput = el('input', { class: 'input', value: survey.title, maxlength: '100' });
    titleInput.addEventListener('input', () => { survey.title = titleInput.value; markDirty(); });
    const introInput = el('textarea', { class: 'textarea', maxlength: '500' });
    introInput.value = survey.intro_text || '';
    introInput.addEventListener('input', () => { survey.intro_text = introInput.value; markDirty(); });

    const templateSelect = el('select', { class: 'select', style: { maxWidth: '240px' } },
        ...Object.entries(TEMPLATES).map(([k, t]) => el('option', { value: k, text: t.name })));
    const templateRow = id ? null : el('div', { class: 'field' },
        el('label', { text: 'ひな形(業種)' }),
        el('div', { class: 'row' }, templateSelect, el('button', { class: 'btn sub small', type: 'button', onclick: () => {
            if (!confirm('設問をひな形の内容に置き換えますか?')) return;
            const t = TEMPLATES[templateSelect.value];
            survey.questions = t.questions(); survey.intro_text = t.intro; introInput.value = t.intro;
            markDirty(); drawQuestions();
        } }, 'このひな形にする')),
        el('p', { class: 'muted', style: { marginTop: '6px' }, text: 'ひな形には「気になった点」の設問が入っています。良い点だけを聞くアンケートにならないよう、残しておくことをおすすめします。' }));

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
        if (!survey.client_id) problems.push('店舗を選択してください。');
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
            el('div', { class: 'field' }, el('label', { text: '店舗' }), storeSelect),
            templateRow,
            el('div', { class: 'field' }, el('label', { text: 'タイトル(管理用。お客様には表示されません)' }), titleInput),
            el('div', { class: 'field' }, el('label', { text: '冒頭のあいさつ(お客様に表示されます)' }), introInput)),
        el('div', { class: 'card' }, el('h2', { text: 'GoogleクチコミURL(公開の条件)' }),
            el('div', { class: 'row' }, urlInput, urlOpenBtn), urlMsg,
            el('p', { class: 'muted', style: { marginTop: '8px' }, text: '入力例:https://g.page/r/CAbCdEfGhIjKlMnOp/review' }),
            el('details', { class: 'howto' }, el('summary', { text: 'URLの取得手順' }),
                el('ol', { style: { paddingLeft: '18px', marginTop: '6px' } },
                    el('li', { text: '店舗のGoogleビジネスプロフィールに、管理者としてログインします(Googleで店舗名を検索すると管理画面が表示されます)。' }),
                    el('li', { text: '「クチコミを依頼」(「クチコミを増やす」と表示される場合もあります)を開きます。' }),
                    el('li', { text: '表示されたリンクをコピーして、上の欄に貼り付けます。' }),
                    el('li', { text: '「リンクを確認」を押し、その店舗のクチコミ画面が開くことを確かめます。' })),
                el('p', { text: '※Google側の画面の表記は変わることがあります。' }))),
        el('div', { class: 'card' }, el('h2', { text: '設問' }),
            el('p', { class: 'muted', style: { marginBottom: '12px' }, text: '選択肢は「夜ご飯」「焼き鳥盛り合わせ」のように、体験をそのまま表す短い言葉にしてください。「気になった点」のように不満も選べる設問を入れてください。≡ をドラッグ、または矢印で並べ替えできます。' }),
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
            el('div', { style: { fontWeight: '700', fontSize: '18px' }, text: clientName(survey.client_id) }),
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
            el('button', { class: 'btn', onclick: () => downloadQrPng(survey, clientName(survey.client_id)) }, el('i', { class: 'fa-solid fa-download' }), 'QRコード(PNG・1200px)をダウンロード'),
            el('button', { class: 'btn sub', onclick: () => close() }, '閉じる'))));
    const canvas = await makeQrCanvas(url, 480);
    img.src = canvas.toDataURL('image/png');
}

// ------------------------------------------------------------
// 回答一覧
// ------------------------------------------------------------
async function renderResponsesPage(id) {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    await loadClients();
    const { data: survey, error } = await supabase.from('neo_surveys').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!survey) return showError('アンケートが見つかりません。');
    const area = el('div');
    app.replaceChildren(
        el('div', { class: 'page-title' },
            el('a', { href: '#/', class: 'btn sub small' }, '← 一覧'),
            `回答一覧:${clientName(survey.client_id)}/${survey.title}`,
            el('a', { href: `#/edit/${id}`, class: 'btn small' }, '編集')),
        el('div', { class: 'card' }, area));
    await renderResults(area, { supabase, survey });
}

// ------------------------------------------------------------
(async () => {
    const session = await requireStaff();
    if (!session) return;
    route();
})();
