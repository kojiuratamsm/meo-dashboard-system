// master-surveys.js
// マスター管理画面「MapOn」:契約者(申し込みフォームから登録した人)の一覧
// 「管理画面に入る」で、その契約者の MapOn 管理画面(neo.html)をマスターとして開く。

import { supabase } from './supabase-config.js';
import { requireStaff, staffLogout, authHeaders } from './staff-guard.js';
import { el } from './survey-lib.js';

const NEO_PLAN = 'D';
const app = document.getElementById('app');
document.getElementById('logoutLink').addEventListener('click', (e) => { e.preventDefault(); staffLogout(); });

function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso); const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())}`;
}

// ------------------------------------------------------------
// 全店舗の状況(稼働中/設定の途中/止まっている、声かけが必要な店舗、店舗ごとの数字)
// 数字は、DB側の関数 neo_master_overview(追加SQL_12)が数えて返す。
// ------------------------------------------------------------
const OVERVIEW_CSS = `
.ov-kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.ov-kpi { flex: 1 1 150px; min-width: 0; border: 1px solid var(--border-color); border-radius: 14px; padding: 14px 16px; }
.ov-kpi .l { font-size: 13px; color: #4A5568; font-weight: 600; }
.ov-kpi .n { font-size: 28px; font-weight: 800; line-height: 1.2; margin: 2px 0; }
.ov-kpi .n small { font-size: 13px; font-weight: 600; color: #4A5568; margin-left: 3px; }
.ov-kpi .s { font-size: 12px; color: #4A5568; }
.ov-att { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; border: 1px solid var(--border-color); border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; }
.ov-att .tx { flex: 1 1 260px; min-width: 0; }
.ov-att .tt { font-size: 14px; font-weight: 700; color: #2D3748; }
.ov-att .tb { font-size: 12px; color: #4A5568; line-height: 1.7; }
.ov-seg { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.ov-seg button { min-height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--border-color); background: #fff; color: #2D3748; font-size: 13px; font-weight: 600; cursor: pointer; }
.ov-seg button[aria-pressed="true"] { background: #1A56C4; border-color: #1A56C4; color: #fff; }
.ov-steps { display: inline-flex; gap: 3px; vertical-align: middle; margin-right: 8px; }
.ov-steps i { display: inline-block; width: 14px; height: 8px; border-radius: 3px; background: #D5DCE8; }
.ov-steps i.on { background: #1A56C4; }
.ov-st { display: inline-block; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
.ov-st.active { color: #1E6B3A; background: #E3F3E8; }
.ov-st.setup { color: #8A4B00; background: #FFF0CC; }
.ov-st.stopped { color: #9B1C1C; background: #FBE4E2; }
.ov-h3 { font-size: 15px; margin: 6px 0 10px; }
#overviewCard .table td { white-space: nowrap; position: relative; }   /* 読み上げ用の隠れた文字が、スマホで画面の横にはみ出さないように */
#overviewCard .table td:first-child { white-space: normal; min-width: 170px; }
`;
const STATUS_LABEL = { active: '稼働中', setup: '設定の途中', stopped: '止まっている' };
const STEP_NAMES = ['店舗名', '口コミURL', 'アンケート公開', 'お礼のクーポン', 'ショップカード'];
const jstDate = (iso) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(iso));   // YYYY-MM-DD
const dayGap = (fromYmd, toYmd) => Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);
const md = (ymd) => { const [, m, d] = String(ymd).split('-').map(Number); return `${m}/${d}`; };

/** 1店舗の状態を決める。回答がまだ無い=設定の途中/直近7日に回答あり=稼働中/8日以上なし=止まっている */
function storeStatus(store, today) {
    const steps = [store.name_set, store.review_url, store.published, store.coupon, store.card].map(Boolean);
    const lastDay = store.last_response_at ? jstDate(store.last_response_at) : null;
    const gap = lastDay ? dayGap(lastDay, today) : null;
    const appliedDay = store.created_at ? jstDate(store.created_at) : null;
    return { steps, done: steps.filter(Boolean).length, lastDay, gap, appliedDay,
        sinceApplied: appliedDay ? dayGap(appliedDay, today) : null,
        status: gap === null ? 'setup' : gap <= 7 ? 'active' : 'stopped' };
}

async function overviewCard() {
    let res;
    try { res = await supabase.rpc('neo_master_overview'); } catch (e) { res = { data: null, error: e }; }
    const m = String(res.error?.message || '');
    if (res.error || !res.data) {
        return el('div', { class: 'card', id: 'overviewCard' }, el('h2', { text: '全店舗の状況' }),
            el('p', { class: 'muted', style: { lineHeight: '1.8' }, text: (!res.error || m.includes('Could not find') || m.includes('does not exist') || m.includes('schema cache'))
                ? 'この欄を使うには、Supabase で「追加SQL_12_ランクとダッシュボード.sql」を実行してください。' : '読み込めませんでした。時間をおいて、もう一度お試しください。' }));
    }
    const today = res.data.today || jstDate(new Date().toISOString());
    const stores = (res.data.stores || []).map(s => ({ ...s, ...storeStatus(s, today) }));
    const count = (k) => stores.filter(s => s.status === k).length;
    const sum = (k) => stores.reduce((a, s) => a + (Number(s[k]) || 0), 0);
    const nameOf = (s) => (s.name_set ? s.name : '(店舗名が未入力)') + (s.owner_name ? ` / ${s.owner_name} 様` : '');
    const enter = (s) => el('a', { href: `/neo?client=${encodeURIComponent(s.id)}`, class: 'btn small sub' }, '管理画面に入る');
    const kpi = (id, label, n, unit, sub) => el('div', { class: 'ov-kpi', id }, el('div', { class: 'l', text: label }),
        el('div', { class: 'n' }, String(n), el('small', { text: unit })), el('div', { class: 's', text: sub }));

    // 声かけが必要な店舗:止まっている/申し込みから3日以上たっても回答がない/今月のAIが上限に近い
    const attention = [];
    for (const s of stores) {
        if (s.status === 'stopped') attention.push({ s, text: `最後の回答は ${md(s.lastDay)}。${s.gap}日間、回答がありません。` });
        else if (s.status === 'setup' && (s.sinceApplied ?? 0) >= 3) {
            const missing = STEP_NAMES.filter((_, i) => !s.steps[i]);
            attention.push({ s, text: `申し込み(${md(s.appliedDay)})から${s.sinceApplied}日。回答がまだありません。` + (missing.length ? `まだの設定:${missing.join('・')}` : '設定は済んでいます。') });
        }
        if (Number(s.ai_limit) > 0 && Number(s.ai_month) >= Number(s.ai_limit) * 0.8) attention.push({ s, text: `今月のAIの文章が、上限に近づいています(${s.ai_month} / ${s.ai_limit}回)。上限に達すると、今月は文章を作れなくなります。` });
    }
    const ATT_MAX = 10;

    let filter = 'all', keyword = '';
    const tbody = el('tbody', { id: 'overviewRows' });
    const seg = el('div', { class: 'ov-seg', role: 'group', 'aria-label': '状態でしぼる' },
        ...[['all', 'すべて'], ['active', '稼働中'], ['setup', '設定の途中'], ['stopped', '止まっている']].map(([k, t]) =>
            el('button', { type: 'button', 'data-filter': k, 'aria-pressed': String(k === filter), onclick: () => { filter = k; drawRows(); } }, t)));
    const search = el('input', { class: 'input', id: 'overviewSearch', placeholder: '店舗名・氏名で探す', 'aria-label': '店舗名・氏名で探す', style: { maxWidth: '240px' } });
    search.addEventListener('input', () => { keyword = search.value; drawRows(); });
    function drawRows() {
        seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
        const k = keyword.trim().toLowerCase();
        const list = stores.filter(s => (filter === 'all' || s.status === filter) && (!k || `${s.name || ''} ${s.owner_name || ''}`.toLowerCase().includes(k)));
        tbody.replaceChildren(...(list.length ? list.map(s => el('tr', { 'data-store': s.id },
            el('td', { style: { fontWeight: '700' }, text: nameOf(s) }),
            el('td', { class: 'muted', text: s.appliedDay ? s.appliedDay.replaceAll('-', '/') : '-' }),
            el('td', { title: STEP_NAMES.map((n, i) => `${n}:${s.steps[i] ? '済み' : 'まだ'}`).join(' / ') },
                el('span', { class: 'ov-steps', 'aria-hidden': 'true' }, ...s.steps.map(on => el('i', { class: on ? 'on' : '' }))), `${s.done}/5`,
                el('span', { style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)' }, text: `(${STEP_NAMES.filter((_, i) => !s.steps[i]).join('・') || 'すべて済み'}${s.done < 5 ? 'がまだ' : ''})` })),
            el('td', { text: `${Number(s.responses_30d) || 0}件` }),
            el('td', { text: `${Number(s.members) || 0}人` }),
            el('td', { class: 'muted', text: s.lastDay ? md(s.lastDay) : '-' }),
            el('td', { text: `${Number(s.ai_month) || 0}回` }),
            el('td', {}, el('span', { class: `ov-st ${s.status}`, text: STATUS_LABEL[s.status] })),
            el('td', {}, enter(s))))
            : [el('tr', {}, el('td', { colspan: '9', class: 'muted', style: { textAlign: 'center', padding: '24px' }, text: stores.length ? '当てはまる店舗がありません。' : 'まだ契約者がいません。' }))]));
    }
    drawRows();

    return el('div', { class: 'card', id: 'overviewCard' },
        el('h2', { text: '全店舗の状況' }),
        el('div', { class: 'ov-kpis' },
            kpi('ovTotal', '契約店舗', stores.length, '店', `この7日の申し込み ${stores.filter(s => (s.sinceApplied ?? 99) < 7).length}店`),
            kpi('ovActive', '稼働中', count('active'), '店', '直近7日に回答がある'),
            kpi('ovSetup', '設定の途中', count('setup'), '店', '回答がまだない'),
            kpi('ovStopped', '止まっている', count('stopped'), '店', '8日以上、回答がない'),
            kpi('ovResponses', '30日の回答(全店舗)', sum('responses_30d'), '件', `会員は全部で ${sum('members')}人 / 今月のAIの文章 ${sum('ai_month')}回`)),
        el('h3', { class: 'ov-h3', text: `声かけが必要な店舗(${attention.length}件)` }),
        el('div', { id: 'overviewAttention' }, ...(attention.length ? attention.slice(0, ATT_MAX).map(a => el('div', { class: 'ov-att' },
            el('div', { class: 'tx' }, el('div', { class: 'tt', text: nameOf(a.s) }), el('div', { class: 'tb', text: a.text })), enter(a.s)))
            : [el('p', { class: 'muted', style: { marginBottom: '8px' }, text: 'いま、声かけが必要な店舗はありません。' })]),
            attention.length > ATT_MAX ? el('p', { class: 'muted', text: `ほか ${attention.length - ATT_MAX}件あります。下の一覧で「止まっている」「設定の途中」を選ぶと、すべて見られます。` }) : null),
        el('h3', { class: 'ov-h3', style: { marginTop: '18px' }, text: '店舗の一覧' }),
        el('div', { class: 'row', style: { marginBottom: '12px', justifyContent: 'space-between' } }, seg, search),
        el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
            el('thead', {}, el('tr', {}, ...['店舗', '申し込み日', '設定の進み', '30日の回答', '会員', '最後の回答', '今月のAI', '状態', ''].map(h => el('th', { text: h })))), tbody)),
        el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px', lineHeight: '1.7' },
            text: `設定の進みは、5つの印で表します(${STEP_NAMES.join(' → ')})。濃い印が、済んでいる項目です。状態は、回答がまだない=設定の途中/直近7日に回答がある=稼働中/8日以上ない=止まっている、で決めています。基準日は ${today.replaceAll('-', '/')}(日本時間)です。` }));
}

// 契約者に送るURL(マスター画面の上部に常に表示する)
function urlRow(label, path, note) {
    const url = `${location.origin}${path}`;
    const input = el('input', { class: 'input grow', value: url, readonly: true });
    const copyBtn = el('button', { class: 'btn small', type: 'button' }, 'コピー');
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(url);
            copyBtn.textContent = 'コピーしました';
            setTimeout(() => { copyBtn.textContent = 'コピー'; }, 2000);
        } catch {
            input.select();
            alert('自動でコピーできませんでした。選択された文字をコピーしてください。');
        }
    });
    return el('div', { class: 'field', style: { marginBottom: '12px' } },
        el('label', { text: label }),
        el('div', { class: 'row' }, input, copyBtn,
            el('a', { href: url, target: '_blank', rel: 'noopener', class: 'btn small sub' }, '開く')),
        el('p', { class: 'muted', style: { marginTop: '4px', fontSize: '12px' }, text: note }));
}

function urlCard(onIssued) {
    const issueBtn = el('button', { class: 'btn', type: 'button', id: 'issueInviteBtn', onclick: () => openIssueDialog(onIssued) },
        el('i', { class: 'fa-solid fa-link' }), 'リンクを発行');
    return el('div', { class: 'card', id: 'invite' },
        el('h2', { text: '契約者に送るURL' }),
        el('div', { class: 'field', style: { marginBottom: '12px' } },
            el('label', { text: 'MapOn(運用代行の方に、1回だけ使えるリンク)' }),
            el('div', { class: 'row' }, el('div', { class: 'inv-placeholder grow', text: 'リンクは、発行するたびに、新しく作られます' }), issueBtn),
            el('p', { class: 'muted', style: { marginTop: '4px', fontSize: '12px', lineHeight: '1.7' },
                text: '運用代行のプランに入った店舗に、1件ずつ発行して、メールかLINEで送ってください。申し込みが完了すると、そのリンクは使えなくなります(開いただけでは、使用済みになりません)。登録したメールアドレスには、ログインURLの案内メールが自動で届きます。' })),
        urlRow('MapOn Light(誰でも使える公開のURL)', '/signup-light', 'AIの文章は月25回、アンケートとクーポンは1つまで、会員証は使えません。悪用対策(ボット判定)ができて、受付を開くまでは、このURLで申し込んでもアカウントは作られません。'),
        urlRow('ログインページ', '/login', '申し込み後は、このページから登録したメールアドレスとパスワードでログインすると、店舗管理画面が開きます。(店舗名がない登録だけ、初回に店舗名の入力があります)'));
}

// ------------------------------------------------------------
// ワンタイムリンク(追加SQL_21):発行・一覧・取り消し(MSMスタッフ)
// リンクが使えるかの判断と「使用済み」にする処理は、DB側(申し込みの処理)が行う。
// ------------------------------------------------------------
const INVITE_CSS = `
.inv-placeholder { padding: 10px 12px; border: 1px dashed #A5B4FC; border-radius: 10px; background: #EEF2FF; color: #3730A3; font-size: 13px; }
.inv-st { display: inline-block; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.inv-st.ok { color: #3730A3; background: #E0E7FF; }
.inv-st.used { color: #1E6B3A; background: #E3F3E8; }
.inv-st.expired { color: #8A4B00; background: #FFF0CC; }
.inv-st.revoked { color: #4A5568; background: #EDF2F7; }
.inv-used { display: block; font-size: 12px; color: #4A5568; margin-top: 4px; line-height: 1.6; word-break: break-all; }
.inv-exp { display: flex; flex-direction: column; gap: 8px; }
.inv-exp label { display: flex; gap: 8px; align-items: center; font-size: 14px; color: #2D3748; flex-wrap: wrap; }
.inv-exp input[type=number] { width: 90px; }
.inv-exp input[type=date] { width: 170px; }
.inv-done { background: #E6F4EA; color: #1E7E34; border-radius: 10px; padding: 12px 14px; font-size: 14px; font-weight: 700; margin-bottom: 10px; }
#inviteCard .table td { vertical-align: top; }
`;
const INVITE_STATE = { ok: '未使用', used: '使用済み', expired: '期限切れ', revoked: '取り消し済み' };
const inviteUrl = (token) => `${location.origin}/signup-neo?t=${token}`;
function fmtDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso); const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
function inviteErrorText(error) {
    const m = String(error?.message || '');
    if (m.includes('Could not find') || m.includes('does not exist') || m.includes('schema cache')) return 'この機能を使うには、Supabase で「追加SQL_21_ワンタイムリンクとMapOn_Light.sql」を実行してください。';
    if (m.includes('not_allowed')) return 'リンクの発行・取り消しは、MSMスタッフだけが行えます。';
    if (m.includes('bad_expiry')) return '有効期限は、1〜365日、または今日から1年以内の日付で指定してください。';
    if (m.includes('memo_too_long')) return '宛先のメモは、100文字以内で入力してください。';
    if (m.includes('already_used')) return 'このリンクは、すでに使われているため、取り消せません。';
    if (m.includes('not_found')) return 'このリンクは見つかりませんでした。画面を読み込み直してください。';
    return 'うまくいきませんでした。時間をおいて、もう一度お試しください。' + (m ? '(詳細:' + m + ')' : '');
}
async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
function jstToday() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()); }

/** [リンクを発行] で開く、発行の画面 */
function openIssueDialog(onIssued) {
    const bg = el('div', { class: 'modal-bg', id: 'issueModal' });
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const memo = el('input', { class: 'input', id: 'invMemo', maxlength: '100', placeholder: '例:サンプル店A 山田さん(運用代行)', autocomplete: 'off' });
    const radio = (value, checked) => el('input', { type: 'radio', name: 'invExp', value, checked });
    const rNone = radio('none', true), rDays = radio('days', false), rDate = radio('date', false);
    const days = el('input', { class: 'input', id: 'invDays', type: 'number', min: '1', max: '365', value: '14', inputmode: 'numeric', 'aria-label': '日数' });
    const date = el('input', { class: 'input', id: 'invDate', type: 'date', min: jstToday(), 'aria-label': '日付' });
    const msg = el('p', { class: 'msg ng', id: 'invMsg', role: 'alert' });
    const issueBtn = el('button', { class: 'btn', type: 'button', id: 'invIssue' }, '発行してコピー');
    const cancelBtn = el('button', { class: 'btn sub', type: 'button', id: 'invCancel', onclick: close }, 'やめる');
    const body = el('div', {},
        el('div', { class: 'field' }, el('label', { for: 'invMemo', text: '宛先のメモ(任意)' }), memo,
            el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' }, text: 'どのリンクを誰に送ったか分かるように、店舗名やお名前を書いておけます。お客様には表示されません。' })),
        el('div', { class: 'field' }, el('label', { text: '有効期限(任意)' }),
            el('div', { class: 'inv-exp' },
                el('label', {}, rNone, el('b', { text: '期限なし' }), '(申し込みが完了するまで使える)'),
                el('label', {}, rDays, '日数を指定:発行から', days, '日間'),
                el('label', {}, rDate, '日付を指定:', date, 'まで'))),
        el('p', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.7' }, text: '何も入れずに「発行してコピー」を押すと、メモなし・期限なしのリンクができます。' }),
        msg,
        el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '10px' } }, cancelBtn, issueBtn));
    const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'invTitle' }, el('h3', { id: 'invTitle', text: 'リンクの発行' }), body);
    bg.append(dialog);
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(bg);
    days.addEventListener('focus', () => { rDays.checked = true; });
    date.addEventListener('focus', () => { rDate.checked = true; });
    memo.focus();

    issueBtn.addEventListener('click', async () => {
        msg.textContent = '';
        const args = { p_memo: memo.value.trim() || null, p_days: null, p_until: null };
        if (rDays.checked) {
            const n = Number(days.value);
            if (!Number.isInteger(n) || n < 1 || n > 365) { msg.textContent = '日数は、1〜365の数字で入力してください。'; days.focus(); return; }
            args.p_days = n;
        } else if (rDate.checked) {
            if (!date.value) { msg.textContent = '日付を選んでください。'; date.focus(); return; }
            if (date.value < jstToday()) { msg.textContent = '今日より前の日付は選べません。'; date.focus(); return; }
            args.p_until = date.value;
        }
        issueBtn.disabled = true; cancelBtn.disabled = true;
        let res;
        try { res = await supabase.rpc('neo_invite_issue', args); } catch (e) { res = { data: null, error: e }; }
        issueBtn.disabled = false; cancelBtn.disabled = false;
        if (res.error || !res.data?.token) { msg.textContent = inviteErrorText(res.error); return; }
        const url = inviteUrl(res.data.token);
        const copied = await copyToClipboard(url);
        const urlInput = el('input', { class: 'input', id: 'invUrl', value: url, readonly: true, style: { fontSize: '12px', fontFamily: 'monospace' } });
        body.replaceChildren(
            el('p', { class: 'inv-done', id: 'invDone', text: copied ? 'リンクをコピーしました!' : 'リンクを発行しました。下のURLをコピーしてください。' }),
            urlInput,
            el('div', { class: 'warnbox', style: { marginTop: '12px' } },
                el('div', { text: '・このURLを、メールかLINEで、運用代行の店舗に送ってください。' }),
                el('div', { text: `・${res.data.expires_at ? `有効期限は ${fmtDateTime(res.data.expires_at)} までです。` : '有効期限はありません。'}申し込みが完了すると、使えなくなります。` }),
                el('div', { text: '・URLを知っている人は、1回だけ申し込めます。送る相手を間違えたときは、一覧から取り消してください。' })),
            el('div', { class: 'row', style: { justifyContent: 'flex-end' } },
                el('button', { class: 'btn sub', type: 'button', id: 'invCopyAgain', onclick: async (e) => { if (await copyToClipboard(url)) e.target.textContent = 'コピーしました'; else urlInput.select(); } }, 'もう一度コピー'),
                el('button', { class: 'btn', type: 'button', id: 'invClose', onclick: close }, '閉じる')));
        if (!copied) urlInput.select();
        onIssued?.();
    });
}

/** 発行したリンクの一覧 */
function inviteCard() {
    const card = el('div', { class: 'card', id: 'inviteCard' });
    const load = async () => {
        let res;
        try { res = await supabase.rpc('neo_invite_list'); } catch (e) { res = { data: null, error: e }; }
        const head = el('h2', { text: '発行したリンクの一覧' });
        if (res.error || !Array.isArray(res.data)) { card.replaceChildren(head, el('p', { class: 'muted', style: { lineHeight: '1.8' }, text: inviteErrorText(res.error) })); return; }
        const list = res.data;
        const rows = list.map(v => el('tr', { 'data-invite': v.id, 'data-state': v.state },
            el('td', { style: { fontWeight: '700' }, text: v.memo || '(メモなし)' }),
            el('td', { class: 'muted', text: fmtDateTime(v.created_at) }),
            el('td', { class: 'muted', text: v.expires_at ? fmtDateTime(v.expires_at) : 'なし' }),
            el('td', {}, el('span', { class: `inv-st ${v.state}`, text: INVITE_STATE[v.state] || v.state }),
                v.state === 'used' ? el('span', { class: 'inv-used', text: `${v.used_store || '-'}・${v.used_email || '-'}\n${fmtDateTime(v.used_at)}` }) : null),
            el('td', {}, v.state === 'ok' ? el('div', { class: 'row', style: { flexWrap: 'nowrap' } },
                el('button', { class: 'btn small', type: 'button', 'data-copy': v.id, onclick: async (e) => {
                    const b = e.currentTarget; const url = inviteUrl(v.token);
                    if (await copyToClipboard(url)) { b.textContent = 'コピーしました'; setTimeout(() => { b.textContent = 'URLをコピー'; }, 2000); }
                    else prompt('自動でコピーできませんでした。このURLをコピーしてください。', url);
                } }, 'URLをコピー'),
                el('button', { class: 'btn small danger', type: 'button', 'data-revoke': v.id, onclick: async () => {
                    if (!confirm(`${v.memo ? `「${v.memo}」の` : ''}リンクを取り消しますか?\n取り消すと、お客様はこのURLで申し込めなくなります(元に戻せません)。`)) return;
                    let r; try { r = await supabase.rpc('neo_invite_revoke', { p_id: v.id }); } catch (e) { r = { error: e }; }
                    if (r.error) { alert(inviteErrorText(r.error)); return; }
                    load();
                } }, '取り消し')) : el('span', { class: 'muted', text: '-' }))));
        card.replaceChildren(head,
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['宛先のメモ', '発行日', '期限', '状態', '操作'].map(h => el('th', { text: h })))),
                el('tbody', { id: 'inviteRows' }, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '5', class: 'muted', style: { textAlign: 'center', padding: '24px' }, text: 'まだリンクを発行していません。上の「リンクを発行」から作れます。' }))])))),
            el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '8px', lineHeight: '1.7' }, text: '新しい順に200件まで表示します。使われたリンクには、使った店舗名・メールアドレス・日時が出ます。想定外の人なら、契約者一覧で確かめてください。' }));
    };
    card.append(el('h2', { text: '発行したリンクの一覧' }), el('p', { class: 'muted', text: '読み込み中...' }));
    load();
    return { card, reload: load };
}

/** 解約したLightのメールアドレス(追加SQL_22):同じメールアドレスでのLightの再申し込みを止めている。担当者が許可できる */
function signupBlockCard() {
    const card = el('div', { class: 'card', id: 'blockCard' });
    const head = () => el('h2', { text: '解約したLightのメールアドレス(再申し込みの停止)' });
    const load = async () => {
        let res;
        try { res = await supabase.rpc('neo_admin_signup_blocks'); } catch (e) { res = { data: null, error: e }; }
        if (res.error || !Array.isArray(res.data)) {
            const m = String(res.error?.message || '');
            card.replaceChildren(head(), el('p', { class: 'muted', style: { lineHeight: '1.8' },
                text: (m.includes('Could not find') || m.includes('does not exist')) ? 'この欄を使うには、Supabase で「追加SQL_22_LINE名と利用規約と解約.sql」を実行してください。' : '読み込めませんでした。画面を読み込み直してください。' }));
            return;
        }
        const rows = res.data.map(b => el('tr', { 'data-block': String(b.id), 'data-released': b.released_at ? '1' : '0' },
            el('td', { style: { fontWeight: '700' }, text: b.email || '-' }),
            el('td', { text: b.store_name || '-' }),
            el('td', { text: b.line_name || '-' }),
            el('td', { class: 'muted', text: fmtDateTime(b.created_at) }),
            el('td', {}, b.released_at
                ? el('span', { class: 'muted', text: `許可済み(${fmtDateTime(b.released_at)})` })
                : el('div', { class: 'row', style: { flexWrap: 'nowrap' } },
                    el('span', { class: 'inv-st expired', text: '停止中' }),
                    el('button', { class: 'btn small sub', type: 'button', 'data-release': String(b.id), onclick: async () => {
                        if (!confirm(`${b.email} で、もう一度 Light に申し込めるようにしますか?`)) return;
                        let r; try { r = await supabase.rpc('neo_admin_signup_block_release', { p_id: b.id }); } catch (e) { r = { error: e }; }
                        if (r.error) { alert('許可できませんでした。画面を読み込み直してください。'); return; }
                        load();
                    } }, '再申し込みを許可')))));
        card.replaceChildren(head(),
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['メールアドレス', '店舗名', 'LINE名', '解約日', '状態'].map(h => el('th', { text: h })))),
                el('tbody', { id: 'blockRows' }, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '5', class: 'muted', style: { textAlign: 'center', padding: '24px' }, text: '解約したLightの店舗は、まだありません。' }))])))),
            el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '8px', lineHeight: '1.7' }, text: 'Lightの店舗が設定画面から解約すると、ここに載り、同じメールアドレスでは、Lightに申し込めなくなります(有料のリンクからは申し込めます)。新しい順に200件まで表示します。' }));
    };
    card.append(head(), el('p', { class: 'muted', text: '読み込み中...' }));
    load();
    return card;
}

// ------------------------------------------------------------
// プランの切り替え(追加SQL_21):有料にする=MSMスタッフ/Lightにする=MSMの管理者だけ(データを削除する)
// ------------------------------------------------------------
function tierErrorText(error) {
    const m = String(error?.message || '');
    if (m.includes('Could not find') || m.includes('does not exist') || m.includes('schema cache')) return 'この機能を使うには、Supabase で「追加SQL_21_ワンタイムリンクとMapOn_Light.sql」を実行してください。';
    if (m.includes('not_allowed')) return 'Lightにする(データを削除する)のは、MSMの管理者だけが行えます。';
    if (m.includes('name_mismatch')) return '入力した店舗名(またはメールアドレス)が一致しません。';
    if (m.includes('not_found')) return 'この店舗は見つかりませんでした。画面を読み込み直してください。';
    if (m.includes('not_neo')) return 'MapOn の店舗ではないため、プランを変えられません。';
    return '切り替えられませんでした。何も変更していません。' + (m ? '(詳細:' + m + ')' : '');
}
function openTierDialog(c, toTier, onChanged) {
    const name = String(c.company_name || '').trim();
    const named = name && name !== NAME_PENDING;
    const shown = named ? name : (c.email || '(店舗名が未入力)');
    const bg = el('div', { class: 'modal-bg', id: 'tierModal' });
    const body = el('div', {}, el('p', { class: 'muted', text: '確認しています…' }));
    let busy = false, done = false;
    const close = () => { if (busy) return; bg.remove(); document.removeEventListener('keydown', onKey); if (done) onChanged?.(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bg.append(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tierTitle' },
        el('h3', { id: 'tierTitle', text: toTier === 'standard' ? '有料(MapOn)に切り替え' : 'Light(無料)に切り替え' }), body));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(bg);
    const closeBtn = (label = '閉じる') => el('button', { class: 'btn sub', type: 'button', id: 'tierClose', onclick: close }, label);
    const finish = (text) => {
        done = true;
        body.replaceChildren(el('p', { class: 'msg ok', id: 'tierDone', style: { fontSize: '15px', fontWeight: '700' }, text }),
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn()));
    };
    const run = async (button, msg, confirmName) => {
        busy = true; button.disabled = true; msg.className = 'msg'; msg.textContent = '切り替えています…';
        let r;
        try { r = await supabase.rpc('neo_admin_set_tier', { p_client_id: String(c.id), p_tier: toTier, p_confirm_name: confirmName ?? null }); } catch (e) { r = { error: e }; }
        busy = false;
        if (r.error || !r.data?.ok) { msg.className = 'msg ng'; msg.textContent = tierErrorText(r.error); button.disabled = false; return false; }
        return true;
    };

    if (toTier === 'standard') {
        const msg = el('p', { class: 'msg', id: 'tierMsg', role: 'alert' });
        const go = el('button', { class: 'btn', type: 'button', id: 'tierGo' }, '切り替える');
        go.addEventListener('click', async () => { if (await run(go, msg)) finish(`「${shown}」を、有料(MapOn)に切り替えました。店舗が画面を開き直すと、全機能が使えます。`); });
        body.replaceChildren(
            el('p', { style: { lineHeight: '1.8', fontSize: '14px' } }, '「', el('b', { text: shown }), '」様を、有料(MapOn)に切り替えますか?'),
            el('p', { class: 'muted', style: { lineHeight: '1.8', marginTop: '6px' }, text: 'AIの文章の上限は、月300回になります。会員証・クーポン・アンケートの制限もなくなります。' }),
            msg, el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn('やめる'), go));
        go.focus();
        return;
    }

    (async () => {
        let res;
        try { res = await supabase.rpc('neo_admin_tier_preview', { p_client_id: String(c.id) }); } catch (e) { res = { data: null, error: e }; }
        if (res.error || !res.data) {
            body.replaceChildren(el('p', { class: 'msg ng', id: 'tierMsg', style: { fontSize: '14px', lineHeight: '1.7' }, text: tierErrorText(res.error) }),
                el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn()));
            return;
        }
        const L = res.data.light || {};
        const n = (k) => Number(L[k]) || 0;
        const expect = named ? name : String(res.data.email || c.email || '').trim();
        const matches = (v) => named ? v.trim() === expect : v.trim().toLowerCase() === expect.toLowerCase();
        const input = el('input', { class: 'input', id: 'tierConfirm', autocomplete: 'off', spellcheck: 'false' });
        const msg = el('p', { class: 'msg', id: 'tierMsg', role: 'alert' });
        const go = el('button', { class: 'btn danger-solid', type: 'button', id: 'tierGo', disabled: true }, 'Lightにする');
        input.addEventListener('input', () => { go.disabled = !matches(input.value); msg.textContent = ''; });
        input.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (!go.disabled) go.click(); });
        go.addEventListener('click', async () => {
            if (!matches(input.value) || busy) return;
            input.disabled = true;
            if (await run(go, msg, input.value.trim())) finish(`「${shown}」を、Light(無料)に切り替えました。データを削除し、記録を残しました。`);
            else input.disabled = false;
        });
        const couponText = n('coupons_delete') === 0 ? `${n('coupons_total')}つ(削除なし)`
            : `${n('coupons_total')}つのうち、最初に作った1つ${L.keep_coupon_name ? `(「${L.keep_coupon_name}」)` : ''}を残して、${n('coupons_delete')}つを削除${n('coupon_issues_delete') ? `(お客様に渡した記録 ${n('coupon_issues_delete')}件も削除)` : ''}`;
        const surveyText = n('surveys_delete') === 0 ? `${n('surveys_total')}つ(削除なし)`
            : `${n('surveys_total')}つのうち、最初に作った1つ${L.keep_survey_title ? `(「${L.keep_survey_title}」)` : ''}を残して、${n('surveys_delete')}つを削除${n('responses_delete') ? `(消えるアンケートの回答 ${n('responses_delete')}件も削除)` : ''}`;
        body.replaceChildren(
            el('p', { style: { lineHeight: '1.8', fontSize: '14px' } }, '「', el('b', { text: shown }), '」様を、Light(無料)に切り替えます。次のデータが', el('b', { text: '削除されます' }), ':'),
            el('dl', { class: 'del-list', id: 'tierCounts', style: { marginTop: '10px' } },
                el('dt', { text: '会員・ショップカード' }), el('dd', { 'data-count': 'members', text: `すべて(会員 ${n('members')}人・スタンプの記録 ${n('stamp_events')}件を含む)` }),
                el('dt', { text: 'クーポン' }), el('dd', { 'data-count': 'coupons', text: couponText }),
                el('dt', { text: 'アンケート' }), el('dd', { 'data-count': 'surveys', text: surveyText })),
            el('div', { class: 'del-dangerbox' },
                el('div', { text: '・削除すると、元に戻せません(SupabaseのFreeプランは、バックアップがありません)。' }),
                el('div', { text: '・AIの文章の上限は、月25回になります。誰が・いつ・何を消したかは、記録に残ります。' })),
            el('div', { class: 'field' },
                el('label', { for: 'tierConfirm', text: named ? '確認のため、店舗名を入力してください' : '確認のため、登録のメールアドレスを入力してください' }),
                el('p', { class: 'muted', style: { margin: '0 0 6px', fontSize: '12px' } }, '入力するもの:', el('b', { text: expect })),
                input),
            msg,
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '10px' } }, closeBtn('やめる'), go));
        input.focus();
    })();
}

// AIの文章生成(口コミ文章の下書き)が動くかを、マスター画面から確かめる
function aiCheckCard() {
    const msg = el('p', { class: 'msg', id: 'aiCheckMsg', role: 'status' });
    const btn = el('button', { class: 'btn small', type: 'button', id: 'aiCheckBtn' }, '接続テストをする');
    btn.addEventListener('click', async () => {
        btn.disabled = true; msg.className = 'msg'; msg.textContent = '確認中です…';
        try {
            const res = await fetch('/api/admin/ai-check', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: '{}' });
            const data = await res.json().catch(() => null);
            msg.className = 'msg ' + (data?.ok ? 'ok' : 'ng');
            msg.textContent = data?.message || 'テストできませんでした。MEO_UPLOAD のアップロードが済んでいるか確認してください。';
        } catch {
            msg.className = 'msg ng'; msg.textContent = '通信できませんでした。時間をおいて、もう一度お試しください。';
        } finally { btn.disabled = false; }
    });
    return el('div', { class: 'card' },
        el('h2', { text: 'AIの文章生成(接続テスト)' }),
        el('div', { class: 'row' }, btn), msg,
        el('p', { class: 'muted', style: { marginTop: '6px', fontSize: '12px', lineHeight: '1.7' },
            text: 'お客様のアンケート回答から口コミ文章を作るAIが、正しく設定されているかを確かめます。APIキーを登録・変更したあとに押してください。1回のテストで使う利用料は、ごくわずかです。' }));
}

// 契約者の管理画面「設問」欄の【確認する】ボタンのリンク先
function guideUrlCard(current) {
    const input = el('input', { class: 'input grow', value: current || '', placeholder: 'https://', inputmode: 'url' });
    const msg = el('p', { class: 'msg' });
    const saveBtn = el('button', { class: 'btn small', type: 'button' }, '保存');
    const openBtn = el('a', { class: 'btn small sub', target: '_blank', rel: 'noopener', href: current || '#' }, '開く');
    const syncOpen = () => { const v = input.value.trim(); openBtn.href = v || '#'; openBtn.style.visibility = v ? 'visible' : 'hidden'; };
    syncOpen();
    input.addEventListener('input', () => { msg.textContent = ''; syncOpen(); });
    saveBtn.addEventListener('click', async () => {
        const v = input.value.trim();
        if (v && !/^https:\/\/[^\s/?#]+\.\S+$/.test(v)) {
            msg.className = 'msg ng'; msg.textContent = 'https:// で始まるURLを貼り付けてください。'; return;
        }
        saveBtn.disabled = true;
        const { error } = await supabase.from('neo_settings')
            .upsert({ key: 'question_guide_url', value: v || null, updated_at: new Date().toISOString() });
        saveBtn.disabled = false;
        if (error) { msg.className = 'msg ng'; msg.textContent = '保存できませんでした: ' + error.message; return; }
        msg.className = 'msg ok';
        msg.textContent = v ? '保存しました。契約者の管理画面に【確認する】ボタンが表示されます。' : '空欄で保存しました。【確認する】ボタンは表示されません。';
    });
    return el('div', { class: 'card' },
        el('h2', { text: '設問の書き方ガイドのURL' }),
        el('div', { class: 'row' }, input, saveBtn, openBtn), msg,
        el('p', { class: 'muted', style: { marginTop: '6px', fontSize: '12px', lineHeight: '1.7' },
            text: '契約者の管理画面(アンケート作成の「設問」欄)にある【確認する】ボタンのリンク先です。空欄のときは、ボタンは表示されません。' }));
}

// パスワードを忘れた契約者に送る「パスワード再設定URL」を発行して表示する
async function issueResetUrl(c) {
    if (!confirm(`「${c.company_name}」様のパスワード再設定URLを発行しますか?\n(URLを知っている人はパスワードを変更できます。必ずご本人にだけ送ってください)`)) return;
    const { data, error } = await supabase.rpc('neo_issue_password_reset', { p_client_id: String(c.id) });
    if (error || !data?.token) {
        const m = String(error?.message || '');
        alert('URLを発行できませんでした: ' + (m.includes('no_login_account') ? 'この契約者にはログイン用のアカウントがありません。'
            : m.includes('is_staff') ? 'MSMスタッフ・管理者のアカウントにつながっているため、発行できません。ご本人がログイン画面の「パスワードをお忘れの方」から再設定してください。'
            : (m.includes('Could not find') || m.includes('does not exist')) ? 'データベースの設定(追加SQL_6)が必要です。' : (m || '不明なエラー')));
        return;
    }
    const url = `${location.origin}/reset-password?t=${data.token}`;
    const input = el('input', { class: 'input', value: url, readonly: true, style: { fontSize: '12px', fontFamily: 'monospace' } });
    const copyBtn = el('button', { class: 'btn', type: 'button' }, 'コピー');
    const bg = el('div', { class: 'modal-bg' });
    const close = () => bg.remove();
    copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); copyBtn.textContent = 'コピーしました'; }
        catch { input.select(); alert('自動でコピーできませんでした。選択された文字をコピーしてください。'); }
    });
    bg.append(el('div', { class: 'modal' },
        el('h3', { text: 'パスワード再設定URL' }),
        el('p', { class: 'muted', style: { marginBottom: '10px' }, text: `${data.company_name || ''} 様(${data.email || '-'})` }),
        input,
        el('div', { class: 'warnbox', style: { marginTop: '12px' } },
            el('div', { text: '・このURLを、LINEやメールでご本人に送ってください。開くと、新しいパスワードを決められます。' }),
            el('div', { text: '・1回だけ使えます。有効期限は発行から24時間です。もう一度発行すると、前のURLは使えなくなります。' }),
            el('div', { text: '・URLを知っている人は誰でもパスワードを変更できます。本人以外に送らないでください。' })),
        el('div', { class: 'row', style: { justifyContent: 'flex-end' } },
            el('button', { class: 'btn sub', type: 'button', onclick: close }, '閉じる'), copyBtn)));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.body.append(bg);
}

// ------------------------------------------------------------
// 店舗アカウントの削除(MSMの管理者だけ。追加SQL_14)
// 確認の画面で、消えるデータの件数を見せ、店舗名(またはメールアドレス)を入力したときだけ削除できる。
// 削除の可否・範囲は、DB側の関数(neo_admin_store_preview / neo_admin_store_delete)が決める。画面の表示は案内だけ。
// ------------------------------------------------------------
const DELETE_CSS = `
.del-list { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 14px; margin-bottom: 14px; }
.del-list dt { color: #4A5568; font-weight: 600; }
.del-list dd { color: #2D3748; word-break: break-all; }
.del-counts { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 14px; padding: 0; list-style: none; }
.del-counts li { font-size: 13px; background: #F8FAFC; border: 1px solid var(--border-color); border-radius: 8px; padding: 4px 10px; }
.del-counts li b { color: #2D3748; }
.del-dangerbox { background: #FEECEB; color: #9B1C1C; border-radius: 10px; padding: 12px 14px; font-size: 13px; line-height: 1.7; margin-bottom: 14px; }
.btn.danger-solid { background: var(--danger); color: #fff; }
`;
const COUNT_LABELS = [['surveys', 'アンケート', '件'], ['responses', '回答', '件'], ['ai_drafts', 'AIの口コミ文章', '件'], ['coupons', 'クーポン', '件'],
    ['coupon_issues', 'お客様に渡したクーポン', '枚'], ['members', '会員', '人'], ['stamp_events', 'スタンプの記録', '件']];
const NAME_PENDING = '(店舗名未入力)';

/** DBから返ったエラーを、画面に出す文に直す */
function deleteErrorText(error) {
    const m = String(error?.message || '');
    if (m.includes('Could not find') || m.includes('does not exist') || m.includes('schema cache')) return 'この機能を使うには、Supabase で「追加SQL_14_店舗アカウントの削除.sql」を実行してください。';
    if (m.includes('not_allowed')) return '店舗の削除は、MSMの管理者だけが行えます。';
    if (m.includes('not_found')) return 'この店舗は見つかりませんでした。すでに削除されている可能性があります。画面を読み込み直してください。';
    if (m.includes('not_neo')) return '提供を終了した旧プランの顧客は、ここからは削除できません。';
    if (m.includes('is_staff')) return 'MSMスタッフのアカウントにつながっている店舗は、削除できません。';
    if (m.includes('name_mismatch')) return '入力した店舗名(またはメールアドレス)が一致しません。';
    if (m.includes('foreign key') || m.includes('violates')) return 'ほかの機能のデータがこの店舗を使っているため、削除できませんでした。何も削除していません。(詳細:' + m + ')';
    if (m.includes('permission denied')) return 'データベースの権限が足りず、削除できませんでした。何も削除していません。(詳細:' + m + ')';
    return '削除できませんでした。何も削除していません。' + (m ? '(詳細:' + m + ')' : '');
}

async function openDeleteDialog(c, onDeleted) {
    const body = el('div', {}, el('p', { class: 'muted', text: '確認しています…' }));
    const titleId = 'delTitle';
    const bg = el('div', { class: 'modal-bg', id: 'deleteModal' });
    const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        el('h3', { id: titleId, text: '店舗アカウントの削除' }), body);
    let busy = false, done = false;
    const close = () => { if (busy) return; bg.remove(); document.removeEventListener('keydown', onKey); if (done) onDeleted?.(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    bg.append(dialog);
    document.body.append(bg);
    const closeBtn = (label = '閉じる') => el('button', { class: 'btn sub', type: 'button', id: 'delCloseBtn', onclick: close }, label);

    let res;
    try { res = await supabase.rpc('neo_admin_store_preview', { p_client_id: String(c.id) }); } catch (e) { res = { data: null, error: e }; }
    if (res.error || !res.data) {
        body.replaceChildren(el('p', { class: 'msg ng', id: 'delMsg', style: { fontSize: '14px', lineHeight: '1.7' }, text: deleteErrorText(res.error) }),
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn()));
        return;
    }
    const p = res.data;
    const name = String(p.company_name || '').trim();
    const named = name && name !== NAME_PENDING;
    const shown = named ? name : '(店舗名が未入力)';
    const loginText = !p.has_login ? 'なし(すでに削除されています)' : p.login_shared ? 'ほかの顧客と共有のため、残します' : 'あり(一緒に削除します)';
    const info = el('dl', { class: 'del-list' },
        el('dt', { text: '店舗名' }), el('dd', { id: 'delName', text: shown }),
        el('dt', { text: '氏名' }), el('dd', { text: p.owner_name || '-' }),
        el('dt', { text: 'メールアドレス' }), el('dd', { id: 'delEmail', text: p.email || '-' }),
        el('dt', { text: '登録日' }), el('dd', { text: fmtDate(p.created_at) }),
        el('dt', { text: 'ログイン用アカウント' }), el('dd', { id: 'delLogin', text: loginText }));
    if (!p.deletable) {
        body.replaceChildren(info,
            el('p', { class: 'msg ng', id: 'delMsg', style: { fontSize: '14px', lineHeight: '1.7' }, text: deleteErrorText({ message: p.reason }) }),
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn()));
        return;
    }
    const counts = p.counts || {};
    const total = COUNT_LABELS.reduce((a, [k]) => a + (Number(counts[k]) || 0), 0);
    // 確認の入力:店舗名があれば店舗名、未入力ならメールアドレス(DB側はどちらでも受け付ける)
    const expect = named ? name : String(p.email || '').trim();
    const matches = (v) => named ? v.trim() === expect : v.trim().toLowerCase() === expect.toLowerCase();
    const input = el('input', { class: 'input', id: 'delConfirm', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'delConfirmHelp' });
    const msg = el('p', { class: 'msg', id: 'delMsg', role: 'alert' });
    const delBtn = el('button', { class: 'btn danger-solid', type: 'button', id: 'delBtn', disabled: true }, el('i', { class: 'fa-solid fa-trash' }), '削除する');
    const cancelBtn = closeBtn('やめる');
    input.addEventListener('input', () => { delBtn.disabled = !matches(input.value); msg.textContent = ''; });
    // Enterキーでも削除できる。キーの既定の動きは止める(完了画面の「閉じる」ボタンまで押されて、すぐ閉じないように)
    input.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; e.preventDefault(); if (!delBtn.disabled) delBtn.click(); });
    delBtn.addEventListener('click', async () => {
        if (!matches(input.value) || busy) return;
        busy = true; delBtn.disabled = true; cancelBtn.disabled = true; input.disabled = true;
        msg.className = 'msg'; msg.textContent = '削除しています…';
        let r;
        try { r = await supabase.rpc('neo_admin_store_delete', { p_client_id: String(c.id), p_confirm_name: input.value.trim() }); } catch (e) { r = { data: null, error: e }; }
        busy = false;
        if (r.error || !r.data?.ok) {
            msg.className = 'msg ng'; msg.textContent = deleteErrorText(r.error);
            cancelBtn.disabled = false; input.disabled = false; delBtn.disabled = !matches(input.value);
            return;
        }
        done = true;
        body.replaceChildren(
            el('p', { class: 'msg ok', id: 'delDone', style: { fontSize: '15px', fontWeight: '700' }, text: `「${shown}」を削除しました。` }),
            el('p', { class: 'muted', style: { lineHeight: '1.8', marginTop: '6px' }, text: r.data.auth_deleted
                ? 'ログイン用アカウントも削除しました。このメールアドレスで、もう一度申し込むこともできます。'
                : 'ログイン用アカウントは、削除していません(すでにないか、ほかの顧客と共有のため)。' }),
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, closeBtn()));
        dialog.querySelector('#delCloseBtn')?.focus();
    });
    body.replaceChildren(info,
        el('div', { class: 'muted', style: { fontWeight: '700', color: '#2D3748' }, text: total ? '一緒に削除されるデータ' : '一緒に削除されるデータ(まだありません)' }),
        el('ul', { class: 'del-counts', id: 'delCounts' }, ...COUNT_LABELS.map(([k, label, unit]) =>
            el('li', { 'data-count': k }, `${label} `, el('b', { text: String(Number(counts[k]) || 0) }), unit))),
        el('div', { class: 'del-dangerbox' },
            el('div', { text: '・削除すると、元に戻せません。店舗の管理画面に入れなくなり、お客様のアンケート・会員証・クーポンも使えなくなります。' }),
            el('div', { text: '・実際に使っていた店舗の場合は、必要なデータ(回答のCSVなど)を先に保存してください。' })),
        el('div', { class: 'field' },
            el('label', { for: 'delConfirm', text: named ? '確認のため、店舗名を入力してください' : '確認のため、登録のメールアドレスを入力してください' }),
            el('p', { class: 'muted', id: 'delConfirmHelp', style: { margin: '0 0 6px', fontSize: '12px' } }, '入力するもの:', el('b', { text: expect })),
            input),
        msg,
        el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '10px' } }, cancelBtn, delBtn));
    input.focus();
}

async function render() {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    // 氏名(owner_name)の列は「追加SQL_7」で追加される。まだ実行されていない場合は、氏名なしで一覧を表示する。
    const loadClients = async () => {
        const base = 'id, company_name, email, created_at, auth_id';
        // LINE名(line_name)の列は「追加SQL_22」で追加される。まだのときは、LINE名なしで表示する。
        const withLine = await supabase.from('clients').select(base + ', owner_name, tier, line_name').eq('plan', NEO_PLAN).order('created_at', { ascending: false });
        if (!withLine.error) return { ...withLine, hasOwnerName: true, hasTier: true };
        // プラン(tier)の列は「追加SQL_21」で追加される。まだのときは、プランなしで表示する。
        const withTier = await supabase.from('clients').select(base + ', owner_name, tier').eq('plan', NEO_PLAN).order('created_at', { ascending: false });
        if (!withTier.error) return { ...withTier, hasOwnerName: true, hasTier: true };
        const withOwner = await supabase.from('clients').select(base + ', owner_name').eq('plan', NEO_PLAN).order('created_at', { ascending: false });
        if (!withOwner.error) return { ...withOwner, hasOwnerName: true };
        const plain = await supabase.from('clients').select(base).eq('plan', NEO_PLAN).order('created_at', { ascending: false });
        return { ...plain, hasOwnerName: false };
    };
    // 削除ボタンは、MSMの管理者にだけ出す(確かめられないときは出さない。実際の可否はDB側の関数が決める)
    const loadIsAdmin = async () => {
        try { const r = await supabase.rpc('is_msm_admin'); return !r.error && r.data === true; } catch { return false; }
    };
    const [overview, clientsRes, surveysRes, statsRes, settingRes, isAdmin] = await Promise.all([
        overviewCard(),
        loadClients(),
        supabase.from('neo_surveys').select('id, client_id').is('deleted_at', null),
        supabase.from('neo_survey_stats').select('survey_id, response_count'),
        supabase.from('neo_settings').select('value').eq('key', 'question_guide_url').maybeSingle(),
        loadIsAdmin(),
    ]);
    const error = clientsRes.error || surveysRes.error || statsRes.error;
    if (error) {
        app.replaceChildren(el('div', { class: 'card' }, el('p', { style: { color: 'var(--danger)' }, text: '読み込みに失敗しました: ' + error.message })));
        return;
    }
    const responsesBySurvey = Object.fromEntries((statsRes.data || []).map(s => [s.survey_id, s.response_count]));
    const perClient = {};
    for (const s of surveysRes.data || []) {
        const key = String(s.client_id);
        perClient[key] ??= { surveys: 0, responses: 0 };
        perClient[key].surveys += 1;
        perClient[key].responses += responsesBySurvey[s.id] || 0;
    }
    const clients = clientsRes.data || [];
    const hasTier = !!clientsRes.hasTier;

    // 申し込みから7日以内は「新しい申し込み」と表示する
    const NEW_DAYS = 7;
    const isNew = (c) => c.created_at && (Date.now() - new Date(c.created_at).getTime()) < NEW_DAYS * 86400000;
    const namePending = (c) => !c.company_name || c.company_name === '(店舗名未入力)';
    const search = el('input', { class: 'input', placeholder: '店舗名・氏名・メール・LINE名で検索', style: { maxWidth: '320px' } });
    const tbody = el('tbody');
    const draw = () => {
        const q = search.value.trim().toLowerCase();
        const list = clients.filter(c => !q || `${c.company_name} ${c.owner_name || ''} ${c.email} ${c.line_name || ''}`.toLowerCase().includes(q));
        if (!list.length) {
            tbody.replaceChildren(el('tr', {}, el('td', { colspan: hasTier ? '8' : '7', class: 'muted', style: { textAlign: 'center', padding: '30px', lineHeight: '1.8' },
                text: clients.length ? '該当する契約者がいません。' : 'まだ登録した契約者がいません。上の「リンクを発行」で、申し込みのURLを作って送ってください。' })));
            return;
        }
        tbody.replaceChildren(...list.map(c => {
            const stat = perClient[String(c.id)] || { surveys: 0, responses: 0 };
            return el('tr', {},
                el('td', { style: { fontWeight: '700' } },
                    namePending(c) ? el('span', { class: 'muted', text: '未設定(初回ログインで入力)' }) : c.company_name,
                    isNew(c) ? el('span', { class: 'badge on', style: { marginLeft: '8px' }, text: '新しい申し込み' }) : null),
                el('td', { text: c.owner_name || '-' }),
                el('td', { text: c.email || '-' }),
                hasTier ? el('td', {}, el('span', { class: 'badge', 'data-tier': c.tier, style: c.tier === 'light' ? { background: '#CCFBF1', color: '#115E59' } : { background: '#E0E7FF', color: '#3730A3' },
                    text: c.tier === 'light' ? 'MapOn Light' : 'MapOn' }),
                    c.tier === 'light' && c.line_name ? el('div', { class: 'muted', 'data-line-name': '', style: { fontSize: '12px', marginTop: '4px' }, text: `LINE名:${c.line_name}` }) : null) : null,
                el('td', { class: 'muted', text: fmtDate(c.created_at) }),
                el('td', { text: `${stat.surveys}件` }),
                el('td', { text: `${stat.responses}件` }),
                el('td', {}, el('div', { class: 'row', style: { flexWrap: 'nowrap' } },
                    el('a', { href: `/neo?client=${encodeURIComponent(c.id)}`, class: 'btn small' },
                        el('i', { class: 'fa-solid fa-right-to-bracket' }), '管理画面に入る'),
                    c.auth_id ? el('button', { class: 'btn small sub', type: 'button', title: 'パスワードを忘れた方に送るURLを発行します', onclick: () => issueResetUrl(c) },
                        el('i', { class: 'fa-solid fa-key' }), 'PW再設定URL') : null,
                    hasTier && c.tier === 'light' ? el('button', { class: 'btn small', type: 'button', 'data-tier-up': String(c.id), title: '有料(MapOn)に切り替えます', onclick: () => openTierDialog(c, 'standard', render) }, '有料にする') : null,
                    hasTier && c.tier !== 'light' && isAdmin ? el('button', { class: 'btn small sub', type: 'button', 'data-tier-down': String(c.id), title: 'Light(無料)に切り替えます。データを削除します(管理者だけ)', onclick: () => openTierDialog(c, 'light', render) }, 'Lightにする') : null,
                    isAdmin ? el('button', { class: 'btn small danger', type: 'button', 'data-delete': String(c.id), title: 'この店舗アカウントを削除します(管理者だけ)',
                        'aria-label': `${namePending(c) ? (c.email || '店舗') : c.company_name}を削除`, onclick: () => openDeleteDialog(c, render) },
                        el('i', { class: 'fa-solid fa-trash' }), '削除') : null)));
        }));
    };
    search.addEventListener('input', draw);
    const invites = inviteCard();

    app.replaceChildren(
        el('div', { class: 'page-title' }, 'MapOn 契約者一覧'),
        overview,
        urlCard(() => invites.reload()),
        invites.card,
        signupBlockCard(),
        aiCheckCard(),
        settingRes.error
            ? el('div', { class: 'card' }, el('h2', { text: '設問の書き方ガイドのURL' }),
                el('p', { class: 'muted', text: 'この欄を使うには、Supabase で「追加SQL_3_設問ガイドURL.sql」を実行してください。' }))
            : guideUrlCard(settingRes.data?.value),
        el('div', { class: 'card' },
            el('h2', { text: `契約者一覧(${clients.length}件)` }),
            el('div', { class: 'row', style: { marginBottom: '14px' } }, search),
            clientsRes.hasOwnerName ? null : el('p', { class: 'muted', style: { marginBottom: '10px', fontSize: '12px' },
                text: '氏名の列を表示するには、Supabase で「追加SQL_7_申し込みフォームの氏名.sql」を実行してください。' }),
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['店舗名', '氏名', 'メールアドレス', ...(hasTier ? ['プラン'] : []), '登録日', 'アンケート', '回答', ''].map(h => el('th', { text: h })))),
                tbody))));
    draw();
    // サイドバーの「MapOn」(申し込みフォームURL取得)から来たときは、「契約者に送るURL」を見せる
    if (location.hash === '#invite') document.getElementById('invite')?.scrollIntoView({ block: 'start' });
}

(async () => {
    const session = await requireStaff();
    if (!session) return;
    document.head.append(el('style', { text: OVERVIEW_CSS + DELETE_CSS + INVITE_CSS }));
    render();
})();
