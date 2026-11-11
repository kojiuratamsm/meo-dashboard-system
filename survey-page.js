// survey-page.js
// お客様がスマートフォンで開くアンケートの画面(survey.html)。
//   ① アンケート →(回答を保存)→ ② AIが作った文章 → ③ 回答のお礼(クーポン取得のボタン)→ クーポン画面(coupon.html)
//   店舗が「ルーレットで抽選する」を選んでいるときは、③ のあとにルーレットを回してからクーポン画面へ進む。
//   お店のQRコードをもう一度読み取ったときは、この端末が持っているクーポン(と会員証への入口)を上に出す。
// ・クーポンは「アンケート回答へのお礼」。口コミを投稿したかどうかに関係なく、回答した人全員に同じボタンを出す。
// ・②は、お店にGoogle口コミURLが設定されているときだけ表示する(未設定なら ①→③)。
// ・星の数や回答の内容によって、②の表示を変えない(全員に同じ画面を出す)。
// ・「文章を送信する」は、文章をコピーしてGoogleの口コミ画面を開くだけ。貼り付けと投稿は、お客様自身が行う。

import { supabase } from './supabase-config.js';
import { renderSurveyForm, SURVEY_FORM_CSS } from './survey-lib.js';
import { walletApi, renderCouponList, cardUrl, WALLET_CSS } from './wallet-lib.js';

document.head.append(Object.assign(document.createElement('style'), { textContent: SURVEY_FORM_CSS + WALLET_CSS }));

const $ = (id) => document.getElementById(id);
const steps = ['step-loading', 'step-closed', 'step-form', 'step-draft', 'step-done', 'step-lottery'];
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

// ---- お持ちのクーポン・会員証 ----
// お店のQRコード(このアンケートのURL)をもう一度読み取ると、この端末が持っているクーポンを上に出す。
// だれの端末かは、サーバーが発行した「端末の印」(Cookie)で決まる。持っていなければ、何も出さない。
// 表示は、回答の内容や口コミを投稿したかどうかに関係なく、全員同じ。
async function loadWallet() {
    const view = await walletApi({ action: 'view', slug });
    if (!view || view.ok !== true) return;
    const coupons = view.coupons || [], card = view.card || {}, isMember = !!view.member;
    const showCardLink = isMember && !!card.key;
    $('walletTitle').textContent = coupons.length ? `お持ちのクーポン ${coupons.length}枚` : '会員証・ショップカード';
    renderCouponList($('walletList'), coupons);
    $('walletList').hidden = coupons.length === 0;
    $('walletNote').hidden = coupons.length === 0;
    $('walletCard').hidden = !showCardLink;
    if (showCardLink) $('walletCard').href = cardUrl(card.key);
    $('walletBox').hidden = coupons.length === 0 && !showCardLink;
    // ③の画面の案内(ショップカードを公開しているお店だけ)
    const invite = $('cardInvite');
    invite.hidden = !(card.enabled && card.key);
    if (card.enabled && card.key) {
        $('cardInviteTitle').textContent = card.name || 'ショップカード';
        $('cardInviteNote').textContent = isMember ? '会員証とスタンプは、こちらから確認できます。' : 'ご来店ごとにスタンプがたまります。登録はお名前と電話番号だけです。';
        $('cardInviteLink').textContent = isMember ? '会員証・ショップカードを見る' : 'ショップカードを作る';
        $('cardInviteLink').href = cardUrl(card.key);
    }
}
// 受け取ったクーポンを、この端末に記録する(次にお店のQRコードを読み取ったときに出る)。
// 記録を待ちすぎて画面の移動が遅れないよう、最大2.5秒で先に進む(クーポン画面でも、もう一度記録する)。
function rememberCoupon(issueToken) {
    return Promise.race([walletApi({ action: 'attach', issue_token: issueToken }), new Promise(r => setTimeout(r, 2500))]).catch(() => {});
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
    loadReward();
}

// ---- アンケート回答のお礼(クーポン・ルーレット) ----
let reward = { mode: 'none' };
const couponUrl = (token) => `/coupon?t=${encodeURIComponent(token)}`;
// 同じ端末での受け取り回数を数えるための印(この端末のブラウザに保存する、でたらめな文字)
function deviceId() {
    try {
        let v = localStorage.getItem('neo_device_id');
        if (!v) {
            v = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
            localStorage.setItem('neo_device_id', v);
        }
        return v;
    } catch { return null; }
}
const REWARD_ERRORS = [
    ['limit_reached', 'このスマートフォンでは、すでにクーポンを受け取っています。'],
    ['reward_not_available', '申し訳ありません。ただいまクーポンをお渡しできません。'],
    ['response_not_found', '回答から時間がたったため、クーポンを受け取れませんでした。'],
];
function rewardErrorText(error) {
    const m = String(error?.message || '');
    return (REWARD_ERRORS.find(([code]) => m.includes(code)) || [null, '通信できませんでした。電波の良い場所で、もう一度お試しください。'])[1];
}

// お礼があるかどうかを確かめて、③にボタンを出す(口コミを投稿したかどうかでは変えない)
async function loadReward() {
    const box = $('rewardBox');
    box.hidden = true;
    if (!response?.response_id) return;
    let data = null;
    try {
        ({ data } = await supabase.rpc('neo_get_reward_info', { p_response_id: response.response_id, p_token: response.action_token }));
    } catch { data = null; }
    reward = data && data.mode ? data : { mode: 'none' };
    if (reward.mode === 'none') return;
    const claimed = reward.mode === 'claimed';
    $('rewardTitle').textContent = claimed ? 'クーポンを受け取り済みです' : reward.mode === 'lottery' ? 'ルーレットでクーポンが当たります' : 'クーポンをお受け取りください';
    $('rewardNote').textContent = claimed ? 'お会計のときに、クーポンの画面をスタッフにお見せください。' : '次回のご来店で使えるクーポンです。会員登録は不要です。';
    $('btnReward').textContent = claimed ? 'クーポンを見る' : 'アンケート回答によるクーポン取得';
    $('rewardMsg').textContent = '';
    box.hidden = false;
}

async function claimReward() {
    try {
        return await supabase.rpc('neo_claim_reward', { p_response_id: response.response_id, p_token: response.action_token, p_device: deviceId() });
    } catch (e) {
        return { data: null, error: e };
    }
}

// ルーレットの見た目を作る(景品の名前だけ。当たりはサーバーが決める)
function buildWheel(prizes) {
    const n = prizes.length, seg = 360 / n;
    const palette = [['#1F5FD1', '#FFFFFF'], ['#FFD98A', '#3D2600'], ['#0B3A8F', '#FFFFFF'], ['#FFF1CC', '#3D2600']];
    const color = (i) => (n % 2 === 1 && i === n - 1) ? palette[2] : palette[i % 2];   // 隣どうしが同じ色にならないようにする
    const wheel = $('wheel');
    wheel.style.background = `conic-gradient(${prizes.map((_, i) => `${color(i)[0]} ${i * seg}deg ${(i + 1) * seg}deg`).join(', ')})`;
    wheel.replaceChildren(...prizes.map((p, i) => {
        const label = document.createElement('div');
        label.className = 'wheel-label';
        const text = String(p.label || '').replace(/クーポン$/, '') || String(p.label || '');   // 輪の中は短く(例:「50%OFFクーポン」→「50%OFF」)
        label.textContent = text.length > 8 ? text.slice(0, 7) + '…' : text;
        label.style.color = color(i)[1];
        label.style.transform = `rotate(${i * seg + seg / 2}deg) translateY(-92px)`;
        return label;
    }));
    wheel.setAttribute('aria-label', 'ルーレット。景品は ' + prizes.map(p => p.label).join('、'));
}

function bindRewardStep() {
    $('btnReward').addEventListener('click', async () => {
        const btn = $('btnReward');
        if (reward.mode === 'claimed') { location.href = couponUrl(reward.issue_token); return; }
        if (reward.mode === 'lottery') {
            buildWheel(reward.prizes || []);
            $('lotteryResult').textContent = '';
            $('btnSpin').hidden = false; $('btnShowCoupon').hidden = true;
            show('step-lottery');
            return;
        }
        // 決まったクーポン:その場で発行して、クーポン画面へ進む
        btn.disabled = true; $('rewardMsg').textContent = '';
        const { data, error } = await claimReward();
        if (error || !data?.issue_token) { btn.disabled = false; $('rewardMsg').textContent = rewardErrorText(error); return; }
        await rememberCoupon(data.issue_token);
        btn.disabled = false;
        location.href = couponUrl(data.issue_token);
    });

    // ルーレット:先にサーバーで抽選し、決まった景品のところで止まるように回す
    $('btnSpin').addEventListener('click', async () => {
        const btn = $('btnSpin');
        btn.disabled = true; btn.textContent = '抽選中…'; $('lotteryMsg').textContent = '';
        const { data, error } = await claimReward();
        if (error || !data?.issue_token) {
            btn.disabled = false; btn.textContent = 'ルーレットを回す';
            $('lotteryMsg').textContent = rewardErrorText(error);
            return;
        }
        rememberCoupon(data.issue_token);   // ルーレットが回っている間に記録する
        const prizes = reward.prizes || [];
        const index = Math.max(0, prizes.findIndex(p => p.id === data.prize_id));
        const seg = 360 / (prizes.length || 1);
        const wobble = (Math.random() - 0.5) * seg * 0.5;                 // 止まる位置を少しだけずらす(見た目だけ)
        const angle = 360 * 6 - (index * seg + seg / 2) + wobble;         // 上の矢印の位置に、当たった景品が来る角度
        $('wheel').style.transform = `rotate(${angle}deg)`;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        await new Promise(r => setTimeout(r, reduced ? 700 : 4400));
        $('lotteryResult').textContent = `「${data.coupon?.name || prizes[index]?.label || 'クーポン'}」が当たりました`;
        btn.hidden = true;
        $('btnShowCoupon').href = couponUrl(data.issue_token);
        $('btnShowCoupon').hidden = false;
        $('lotteryMsg').textContent = 'クーポンは、次の画面で保存できます。';
        reward = { mode: 'claimed', issue_token: data.issue_token };
    });
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
    bindRewardStep();
    loadWallet();   // 待たずに進める(持っているクーポンがあれば、あとから上に出る)

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
