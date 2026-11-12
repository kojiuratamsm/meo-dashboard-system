// neo-dashboard.js
// MapOn NEO 管理画面の「ダッシュボード」
//   ・直近7日/30日/90日の数字(アンケート回答・AIの文章・会員・クーポン・スタンプ)
//   ・アンケートの回答数(日ごと)。日を選ぶと、その日の時間帯ごとの回答数に切り替わる
//   ・お客様の流れ(開いた → 回答 → AIの文章 → クーポン → 使った)
//   ・会員・リピート、やることリスト
// 数字はすべて、DB側の関数 neo_dashboard(追加SQL_12)が、日本時間で数えて返す。
// 画面では一覧を読み込んで数えない(1回に読み込める件数の上限に左右されないようにするため)。
// Googleに口コミが投稿されたかどうかは、このシステムからは分からないので、出していない。

import { supabase } from './supabase-config.js';
import { el } from './survey-lib.js';
import { rankColor } from './rank-lib.js';

export const DASHBOARD_CSS = `
.db-head { display: flex; gap: 12px; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; margin-bottom: 20px; }
.db-head .page-title { margin-bottom: 4px; }
.db-seg { display: inline-flex; gap: 6px; }
.db-seg button { min-height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--border-color); background: #fff; color: #2D3748; font-size: 14px; font-weight: 600; cursor: pointer; }
.db-seg button[aria-pressed="true"] { background: #1A56C4; border-color: #1A56C4; color: #fff; }
.db-body.loading { opacity: 0.5; pointer-events: none; }
.db-kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
.db-kpi { flex: 1 1 170px; min-width: 0; background: #fff; border-radius: 16px; padding: 16px 18px; box-shadow: 0 6px 18px rgba(0,0,0,0.04); }
.db-kpi .l { font-size: 13px; color: #4A5568; font-weight: 600; }
.db-kpi .n { font-size: 30px; font-weight: 800; line-height: 1.2; margin: 4px 0 2px; }
.db-kpi .n small { font-size: 14px; font-weight: 600; color: #4A5568; margin-left: 3px; }
.db-kpi .s { font-size: 12px; color: #4A5568; }
.db-cols { display: flex; gap: 20px; flex-wrap: wrap; align-items: stretch; }
.db-cols > .card { flex: 1 1 340px; min-width: 0; }
.db-cols > .card.wide { flex: 2 1 480px; }
.db-chart-head { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
.db-chart-head h2 { margin: 0; }
.db-chart-head .select { width: auto; min-height: 40px; }
.db-sub { font-size: 13px; font-weight: 700; margin-bottom: 6px; color: #2D3748; }
.db-plot { position: relative; }
.db-bars { display: flex; align-items: flex-end; gap: 2px; height: 130px; border-bottom: 1px solid var(--border-color); border-top: 1px dashed #EDF2F7; }
.db-bars.dense { gap: 1px; }
.db-bar { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end; padding: 0; border: none; background: transparent; cursor: pointer; }
.db-bar.static { cursor: default; }
.db-bar span { display: block; width: 100%; border-radius: 4px 4px 0 0; background: #4285F4; }
.db-bars.dense .db-bar span { border-radius: 2px 2px 0 0; }
.db-bar:hover span, .db-bar:focus-visible span { background: #1A56C4; }
.db-bar.on span { background: #123F94; }
.db-bar:focus-visible { outline: 2px solid #123F94; outline-offset: 1px; }
.db-bars.hours .db-bar span { background: #1A56C4; }
.db-axis { display: flex; justify-content: space-between; font-size: 12px; color: #4A5568; margin-top: 4px; }
.db-max { position: absolute; top: -16px; left: 0; font-size: 11px; color: #4A5568; }
.db-tip { position: absolute; top: -34px; transform: translateX(-50%); background: #1A202C; color: #fff; font-size: 12px; font-weight: 700; padding: 5px 9px; border-radius: 8px; white-space: nowrap; pointer-events: none; z-index: 2; }
.db-note { font-size: 13px; color: #4A5568; line-height: 1.7; margin-top: 10px; }
.db-table { margin-top: 12px; font-size: 12px; color: #4A5568; }
.db-table summary { cursor: pointer; font-weight: 700; min-height: 28px; }
.db-table .table td, .db-table .table th { padding: 6px 10px; font-size: 12px; }
.db-table .scroll { max-height: 240px; overflow: auto; margin-top: 6px; }
.db-step { margin-bottom: 12px; }
.db-step .t { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; margin-bottom: 4px; }
.db-step .t b { font-weight: 700; }
.db-step .t span.r { color: #4A5568; margin-left: 6px; font-weight: 400; }
.db-step .track { height: 10px; background: #EDF2FA; border-radius: 6px; }
.db-step .fill { height: 10px; border-radius: 6px; background: #1A56C4; }
.db-step.sub .fill { background: #8FB3F1; }
.db-nums { display: flex; gap: 16px; flex-wrap: wrap; }
.db-nums > div { flex: 1 1 120px; min-width: 0; }
.db-nums .l { font-size: 12px; color: #4A5568; }
.db-nums .n { font-size: 24px; font-weight: 800; }
.db-nums .n small { font-size: 13px; font-weight: 600; color: #4A5568; margin-left: 3px; }
.db-ranks { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
.db-ranks .chip { border-radius: 999px; padding: 4px 12px; font-size: 12px; font-weight: 700; }
.db-todo { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; border: 1px solid var(--border-color); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
.db-todo .tx { flex: 1 1 220px; min-width: 0; }
.db-todo .tt { font-size: 14px; font-weight: 700; color: #2D3748; }
.db-todo .tb { font-size: 12px; color: #4A5568; line-height: 1.7; margin-top: 2px; }
.db-todo .tag { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 999px; padding: 2px 8px; margin-right: 6px; vertical-align: 1px; }
.db-todo .tag.must { background: #FDEBDD; color: #7A2B0C; }
.db-todo .tag.opt { background: #EDF2F7; color: #4A5568; }
`;

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
/** 'YYYY-MM-DD' を「11/12(木)」の形にする */
export function dayLabel(ymd, withWeek = true) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    if (!y || !m || !d) return String(ymd || '');
    return `${m}/${d}` + (withWeek ? `(${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})` : '');
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const todayJst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const daysBetween = (fromYmd, toYmd) => Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);

/** 時間帯ごとの件数(0〜23時)。dayIndex が null なら、期間の合計 */
export function hoursOf(cells, dayIndex) {
    const out = new Array(24).fill(0);
    for (const c of cells || []) {
        const [d, h, n] = c;
        if (dayIndex !== null && dayIndex !== undefined && d !== dayIndex) continue;
        if (h >= 0 && h < 24) out[h] += Number(n) || 0;
    }
    return out;
}

/** 前の期間とくらべた文 */
export function compareText(n, prev, days) {
    if (!prev) return n ? `前の${days}日は0件` : `前の${days}日も0件`;
    const diff = Math.round(((n - prev) / prev) * 100);
    return `前の${days}日より ${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)}%(前は${prev}件)`;
}

/** やることリスト(設定の抜けなど)。大事なものから並べる */
export function buildTodos(d) {
    const t = d.todo || {}, card = d.card || {}, ai = d.ai || {};
    const list = [];
    const add = (must, title, body, action, href) => list.push({ must, title, body, action, href });
    if (!t.surveys) add(true, 'アンケートを作りましょう', 'アンケートを作って公開すると、お客様に読み取ってもらうQRコードが出ます。', 'アンケートを作る', '#/new');
    else if (!t.published) add(true, '公開中のアンケートがありません', 'アンケートを公開すると、お客様が回答できるようになります。', 'アンケートを開く', '#/');
    if (!t.review_url) add(true, 'Google口コミのURLが入っていません', 'URLがないと、お客様をGoogleの口コミ画面へご案内できません。', '設定する', '#/settings');
    if (Number(t.rewards_unavailable) > 0) add(true, `ショップカードの特典のうち、${t.rewards_unavailable}つが届かない状態です`,
        '特典のクーポンが、公開中でない・有効期限切れ・発行枚数の上限のどれかになっています。', 'クーポンを確認する', '#/coupons');
    if (card.enabled && t.qr_expires_on) {
        const left = daysBetween(todayJst(), t.qr_expires_on);
        if (left < 0) add(true, 'スタンプ用QRコードの読み取り期限が、切れています', 'いまは、お客様が読み取ってもスタンプが付きません。期限を変えるか、作り直してください。', '期限を直す', '#/members');
        else if (left <= 7) add(true, left === 0 ? 'スタンプ用QRコードの読み取り期限は、今日までです' : `スタンプ用QRコードの読み取り期限が、あと${left}日で切れます`,
            '期限を過ぎると、スタンプが付かなくなります。', '期限を変える', '#/members');
    }
    if (Number(ai.limit) > 0 && Number(ai.month) >= Number(ai.limit) * 0.8) add(true, `今月のAIの文章が、上限に近づいています(${ai.month} / ${ai.limit}回)`,
        '上限に達すると、今月はAIの文章を作れなくなります。担当者にご連絡ください。', '', '');
    for (const s of (t.no_ai || []).slice(0, 3)) add(false, `「${s.title}」に、AIの文章の設定がありません`,
        '地域名・業種・キーワードを入れると、お客様の文章が整いやすくなります。', '設定する', `#/edit/${s.id}`);
    if (card.enabled && Number(t.rewards) === 0) add(false, 'ショップカードに、特典がありません', 'スタンプが貯まったときに届くクーポンを決められます。', '特典を決める', '#/members');
    if (!card.enabled) add(false, 'ショップカードは、いま非公開です', '公開すると、お客様が会員登録して、スタンプを貯められます。', 'ショップカードを開く', '#/members');
    if (t.reward_mode === 'none') add(false, 'アンケートのお礼(クーポン)を出していません', '出す場合は「クーポン・抽選」で決められます。出さないお店は、そのままで問題ありません。', 'クーポン・抽選を開く', '#/coupons');
    return list;
}

function isNotReady(error) {
    const m = String(error?.message || '');
    return m.includes('Could not find') || m.includes('does not exist') || m.includes('schema cache');
}

/**
 * ダッシュボードを表示する。
 * @returns {Promise<boolean>} データベースの設定(追加SQL_12)がまだのときは false(何も表示しない)
 */
export async function renderDashboard({ app, client }) {
    const clientId = String(client.id);
    let days = 30, sel = null, data = null;
    const load = async (n) => {
        try { return await supabase.rpc('neo_dashboard', { p_client_id: clientId, p_days: n }); } catch (e) { return { data: null, error: e }; }
    };
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    const first = await load(days);
    if (!first.data && (!first.error || isNotReady(first.error))) return false;
    if (first.error || !first.data) {
        app.replaceChildren(el('div', { class: 'page-title' }, 'ダッシュボード'),
            el('div', { class: 'card' }, el('p', { style: { lineHeight: '1.8' }, text: String(first.error?.message || '').includes('not_allowed')
                ? 'この店舗のダッシュボードを見る権限がありません。' : '読み込めませんでした。時間をおいて、もう一度お試しください。' })));
        return true;
    }
    data = first.data;

    const body = el('div', { class: 'db-body', id: 'dbBody' });
    const periodText = el('p', { class: 'muted', id: 'dbPeriod' });
    const seg = el('div', { class: 'db-seg', role: 'group', 'aria-label': '期間' },
        ...[7, 30, 90].map(n => el('button', { type: 'button', 'data-days': String(n), 'aria-pressed': String(n === days), onclick: () => changeDays(n) }, `${n}日`)));
    async function changeDays(n) {
        if (n === days) return;
        body.classList.add('loading');   // 読み込み中も、前の表示を残す(がたつかないように)
        const res = await load(n);
        body.classList.remove('loading');
        if (res.error || !res.data) return;
        days = n; sel = null; data = res.data;
        seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days)));
        draw();
    }

    const kpi = (id, label, value, unit, sub) => el('div', { class: 'db-kpi', id },
        el('div', { class: 'l', text: label }), el('div', { class: 'n' }, String(value), el('small', { text: unit })), el('div', { class: 's', text: sub }));

    // 棒グラフ(1本ずつ、マウス・キーボードで値が出る)
    function bars({ values, labels, onPick, picked, dense, cls = '' }) {
        const max = Math.max(1, ...values);
        const tip = el('div', { class: 'db-tip', hidden: true });
        const plot = el('div', { class: 'db-plot' });
        const row = el('div', { class: `db-bars ${dense ? 'dense' : ''} ${cls}` });
        const show = (i, node) => { tip.textContent = labels[i]; tip.hidden = false; tip.style.left = `${node.offsetLeft + node.offsetWidth / 2}px`; };
        const hide = () => { tip.hidden = true; };
        values.forEach((v, i) => {
            const mark = el('span', { style: { height: v ? `${Math.max(3, Math.round((v / max) * 100))}%` : '0' } });
            const node = onPick
                ? el('button', { type: 'button', class: 'db-bar' + (picked === i ? ' on' : ''), 'aria-label': labels[i], 'aria-pressed': String(picked === i), onclick: () => onPick(i) }, mark)
                : el('div', { class: 'db-bar static', tabindex: '0', role: 'img', 'aria-label': labels[i] }, mark);
            node.addEventListener('pointerenter', () => show(i, node)); node.addEventListener('pointerleave', hide);
            node.addEventListener('focus', () => show(i, node)); node.addEventListener('blur', hide);
            row.append(node);
        });
        plot.append(el('div', { class: 'db-max', 'aria-hidden': 'true', text: `${max}件` }), row, tip);
        return plot;
    }

    function chartCard() {
        const daily = data.daily || [];
        const counts = daily.map(x => Number(x.n) || 0);
        const dayText = (i) => dayLabel(daily[i].d);
        const hours = hoursOf(data.cells, sel);
        const hourTotal = hours.reduce((a, b) => a + b, 0);
        let peak = 0; hours.forEach((c, h) => { if (c > hours[peak]) peak = h; });
        const pick = (i) => { sel = sel === i ? null : i; draw(); document.querySelectorAll('#dbChart .db-bars.days .db-bar')[i]?.focus(); };

        const select = el('select', { class: 'select', id: 'dbDay', 'aria-label': '日を選ぶ' },
            el('option', { value: 'all', text: `${days}日の合計`, selected: sel === null }),
            ...daily.map((x, i) => el('option', { value: String(i), text: `${dayText(i)} ${counts[i]}件`, selected: sel === i })).reverse());
        select.addEventListener('change', () => { sel = select.value === 'all' ? null : Number(select.value); draw(); document.getElementById('dbDay')?.focus(); });

        const mid = Math.floor((daily.length - 1) / 2);
        const hourTitle = sel === null ? `時間帯ごと(${days}日の合計)` : `${dayText(sel)} の時間帯ごと(${counts[sel]}件)`;
        const hourNote = hourTotal === 0
            ? (sel === null ? 'この期間の回答は、まだありません。' : `${dayText(sel)} の回答は、ありません。`)
            : `${sel === null ? `${days}日の合計では` : `${dayText(sel)} は`}、${peak}時台がいちばん多く、${hours[peak]}件です。` + (sel === null ? '日を選ぶと、その日の時間帯が見られます。' : '');

        return el('div', { class: 'card wide', id: 'dbChart' },
            el('div', { class: 'db-chart-head' }, el('h2', { text: 'アンケートの回答数' }),
                el('div', { class: 'row' }, el('label', { for: 'dbDay', style: { fontSize: '13px', color: '#4A5568' }, text: '日を選ぶ' }), select,
                    sel === null ? null : el('button', { class: 'btn sub small', type: 'button', id: 'dbDayReset', onclick: () => { sel = null; draw(); } }, `${days}日の合計に戻す`))),
            el('div', { class: 'db-sub', style: { marginBottom: '22px' }, text: '日ごと(棒を押しても、日を選べます)' }),
            bars({ values: counts, labels: daily.map((x, i) => `${dayText(i)} ${counts[i]}件`), onPick: pick, picked: sel, dense: daily.length > 45, cls: 'days' }),
            el('div', { class: 'db-axis', 'aria-hidden': 'true' }, el('span', { text: daily.length ? dayLabel(daily[0].d, false) : '' }),
                el('span', { text: daily.length > 2 ? dayLabel(daily[mid].d, false) : '' }), el('span', { text: daily.length ? dayLabel(daily[daily.length - 1].d, false) : '' })),
            el('div', { class: 'db-sub', id: 'dbHourTitle', style: { marginTop: '18px', marginBottom: '22px' }, text: hourTitle }),
            bars({ values: hours, labels: hours.map((c, h) => `${h}時台 ${c}件`), cls: 'hours' }),
            el('div', { class: 'db-axis', 'aria-hidden': 'true' }, ...['0時', '6時', '12時', '18時', '23時'].map(t => el('span', { text: t }))),
            el('p', { class: 'db-note', id: 'dbHourNote', text: hourNote }),
            el('details', { class: 'db-table' }, el('summary', { text: '数字を表で見る' }),
                el('div', { class: 'scroll' }, el('table', { class: 'table' },
                    el('thead', {}, el('tr', {}, el('th', { text: sel === null ? '日' : `${dayText(sel)} の時間帯` }), el('th', { text: '回答' }))),
                    el('tbody', {}, ...(sel === null
                        ? daily.map((x, i) => el('tr', {}, el('td', { text: dayText(i) }), el('td', { text: `${counts[i]}件` }))).reverse()
                        : hours.map((c, h) => el('tr', {}, el('td', { text: `${h}時台` }), el('td', { text: `${c}件` }))))))),
            el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' }, text: '日付と時間は、日本時間です。' })));
    }

    function funnelCard() {
        const f = data.funnel || {}, ai = data.ai || {};
        const resp = Number(f.responses) || 0, views = Number(f.views) || 0;
        // 「開いた回数」は、記録を始めた日が期間の初日より前のときだけ、棒にする(途中からの数字を、割合の元にしない)
        const viewsFull = !!f.views_from && f.views_from <= data.from;
        const base = Math.max(resp, viewsFull ? views : 0, 1);
        const step = (label, n, unit, rate, sub = false) => el('div', { class: 'db-step' + (sub ? ' sub' : '') },
            el('div', { class: 't' }, el('span', { text: label }), el('b', {}, `${n}${unit}`, rate === null ? null : el('span', { class: 'r', text: rate }))),
            el('div', { class: 'track' }, el('div', { class: 'fill', style: { width: `${Math.round((n / base) * 100)}%` } })));
        return el('div', { class: 'card', id: 'dbFunnel' }, el('h2', { text: 'お客様の流れ' }),
            viewsFull ? step('アンケートを開いた', views, '回', null, true) : null,
            step('アンケートに回答した', resp, '人', viewsFull && views > 0 ? `開いた回数の${pct(resp, views)}%` : null),
            step('AIの文章を作った', Number(f.drafted) || 0, '人', `回答の${pct(f.drafted, resp)}%`),
            step('クーポンを受け取った', Number(f.coupons) || 0, '人', `回答の${pct(f.coupons, resp)}%`),
            step('クーポンを使った', Number(f.used) || 0, '人', `回答の${pct(f.used, resp)}%`),
            viewsFull ? null : el('p', { class: 'db-note', id: 'dbViewsNote', text: f.views_from
                ? `アンケートを開いた回数:${views}回(${dayLabel(f.views_from, false)}から記録しています)`
                : '「アンケートを開いた回数」は、これから記録が始まります。' }),
            el('p', { class: 'db-note', id: 'dbAiNote', text: `今月のAIの文章:${ai.month ?? 0}回(上限 ${ai.limit ?? 300}回。作り直しも1回と数えます)` }),
            el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '8px', lineHeight: '1.7' },
                text: 'この期間に回答した人が、その後どこまで進んだかを数えています。Googleに口コミが投稿されたかどうかは、お客様がGoogleの画面で行うため、ここには出せません。' }));
    }

    function membersCard() {
        const m = data.members || {}, card = data.card || {};
        const total = Number(m.total) || 0;
        const num = (label, n, unit, id) => el('div', { id }, el('div', { class: 'l', text: label }), el('div', { class: 'n' }, String(n), el('small', { text: unit })));
        const ranks = Array.isArray(card.ranks) ? card.ranks : [];
        return el('div', { class: 'card', id: 'dbMembers' }, el('h2', { text: '会員・リピート' }),
            el('div', { class: 'db-nums' },
                num('会員の合計', total, '人', 'dbMemberTotal'), num(`この${days}日の新規`, Number(m.new) || 0, '人', 'dbMemberNew'),
                num('もう一度来店した会員', pct(m.repeat, total), '%', 'dbMemberRepeat'), num('特典に届いた会員', Number(m.reward) || 0, '人', 'dbMemberReward')),
            ranks.length ? el('div', { class: 'db-ranks', id: 'dbRanks' }, el('span', { class: 'muted', text: 'ランクごとの会員:' }),
                ...ranks.map(r => { const c = rankColor(r.color); return el('span', { class: 'chip', style: { background: c.bg, color: c.fg }, text: `${r.name} ${r.n}人` }); })) : null,
            el('p', { class: 'db-note', text: `「もう一度来店した会員」は、スタンプが付いた日が2日以上ある会員の割合です(${Number(m.repeat) || 0}人 / ${total}人)。「特典に届いた会員」は、この${days}日に特典のクーポンが届いた人数です。` }),
            card.enabled ? null : el('p', { class: 'warnbox', style: { marginTop: '10px', marginBottom: 0 }, text: 'ショップカードは、いま非公開です。公開すると、お客様が会員登録して、スタンプを貯められます。' }));
    }

    function todoCard() {
        const todos = buildTodos(data);
        return el('div', { class: 'card', id: 'dbTodo' }, el('h2', { text: 'やることリスト' }),
            ...(todos.length ? todos.map(t => el('div', { class: 'db-todo' },
                el('div', { class: 'tx' }, el('div', { class: 'tt' }, el('span', { class: 'tag ' + (t.must ? 'must' : 'opt'), text: t.must ? '要対応' : 'おすすめ' }), t.title),
                    el('div', { class: 'tb', text: t.body })),
                t.href ? el('a', { class: 'btn sub small', href: t.href }, t.action) : null))
                : [el('p', { class: 'muted', id: 'dbTodoNone', style: { lineHeight: '1.8' }, text: 'いま、対応が必要なことはありません。' })]));
    }

    function draw() {
        const r = data.responses || {}, f = data.funnel || {}, m = data.members || {}, c = data.coupons || {};
        periodText.textContent = `直近${days}日(${dayLabel(data.from, false)} 〜 ${dayLabel(data.to, false)})`;
        body.replaceChildren(
            el('div', { class: 'db-kpis' },
                kpi('dbKpiResponses', 'アンケート回答', Number(r.n) || 0, '件', compareText(Number(r.n) || 0, Number(r.prev) || 0, days)),
                kpi('dbKpiDrafts', 'AIの文章を作った人', Number(f.drafted) || 0, '人', `回答の${pct(f.drafted, f.responses)}%`),
                kpi('dbKpiMembers', '新しい会員', Number(m.new) || 0, '人', `会員は全部で${Number(m.total) || 0}人`),
                kpi('dbKpiCoupons', 'クーポンの使用率', Number(c.issued) ? pct(c.used, c.issued) : '-', Number(c.issued) ? '%' : '', `${Number(c.issued) || 0}枚発行 / ${Number(c.used) || 0}枚使用`),
                kpi('dbKpiStamps', 'スタンプを押した数', Number(data.stamps) || 0, '回', `特典に届いた会員 ${Number(m.reward) || 0}人`)),
            el('div', { class: 'db-cols' }, chartCard(), funnelCard()),
            el('div', { class: 'db-cols' }, membersCard(), todoCard()));
    }

    app.replaceChildren(
        el('div', { class: 'db-head' }, el('div', {}, el('div', { class: 'page-title' }, 'ダッシュボード'), periodText), seg),
        body);
    draw();
    return true;
}
