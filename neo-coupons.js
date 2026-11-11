// neo-coupons.js
// MapOn NEO 管理画面の「クーポン・抽選」
//   ・アンケート回答のお礼の設定(決まったクーポン/ルーレット/出さない)
//   ・クーポンの作成・編集
//   ・ルーレットの景品と当選確率(合計100%)、景品表示法の目安
// 見られる・書けるデータの範囲は、DB側の権限(RLS)と関数(neo_save_reward_settings)で制限している。

import { supabase } from './supabase-config.js';
import { el, newId } from './survey-lib.js';
import { couponSummary, couponValidity, lotteryEstimate } from './coupon-lib.js';

export const COUPON_CSS = `
.cp-radio { border: 1px solid var(--border-color); border-radius: 12px; padding: 12px 14px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 8px; cursor: pointer; }
.cp-radio:has(input:checked) { border-color: var(--primary-blue); background: #EEF4FF; }
.cp-radio input[type="radio"] { width: 18px; height: 18px; accent-color: var(--primary-blue); }
.cp-radio b { font-size: 14px; }
.cp-prize td { padding: 8px 6px; }
.cp-prize .input, .cp-prize .select { padding: 8px 10px; }
.cp-total { font-weight: 700; display: flex; align-items: center; gap: 8px; }
.cp-legal { background: #FFF7E6; border: 1px solid #E9B949; border-radius: 12px; padding: 14px; font-size: 13px; line-height: 1.8; color: #3D2600; margin-top: 14px; }
.cp-legal h3 { font-size: 14px; margin-bottom: 6px; color: #7A4B00; }
.cp-form .field { margin-bottom: 12px; }
.cp-form .row > .field { flex: 1; min-width: 150px; margin-bottom: 0; }
.cp-form [hidden] { display: none !important; }
`;

const SAVE_ERRORS = [
    ['coupon_required', '「決まったクーポンを出す」を選んだときは、公開中のクーポンを1つ選んでください。'],
    ['percent_total_not_100', 'ルーレットの当選確率の合計を、100%にしてください。'],
    ['fallback_required', 'ルーレットの景品のうち1つを「参加賞」に選んでください(上限に達した景品の代わりに出します)。'],
    ['fallback_needs_no_limit', '「参加賞」には、発行枚数の上限がないクーポンを選んでください。'],
    ['too_few_prizes', 'ルーレットの景品は、2つ以上にしてください。'],
    ['too_many_prizes', 'ルーレットの景品は、12個までにしてください。'],
    ['prize_coupon_invalid', 'ルーレットの景品に、公開中でないクーポン(下書き・削除済み)が含まれています。'],
    ['prize_percent_invalid', '当選確率は、0.1〜100 の数字で入力してください。'],
    ['not_allowed', 'この店舗の設定を変更する権限がありません。'],
];
function saveErrorText(error) {
    const m = String(error?.message || '');
    const hit = SAVE_ERRORS.find(([code]) => m.includes(code));
    if (hit) return hit[1];
    if (m.includes('Could not find') || m.includes('does not exist')) return 'データベースの設定が必要です(Supabase で「追加SQL_9」を実行してください)。';
    return '保存できませんでした。時間をおいて、もう一度お試しください。';
}
const num = (v) => { const n = Number(String(v ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : NaN; };
const intOrNull = (v) => { const s = String(v ?? '').trim(); if (!s) return null; const n = num(s); return Number.isInteger(n) ? n : NaN; };

/** クーポンの入力内容を確認して、保存する形にする。問題があれば { error } を返す */
export function buildCouponPayload(f) {
    const name = String(f.name || '').trim();
    if (!name) return { error: 'クーポン名を入力してください。' };
    if (name.length > 60) return { error: 'クーポン名は60文字以内にしてください。' };
    const p = { name, description: String(f.description || '').trim(), kind: f.kind, amount: null, percent: null, cap_amount: null, benefit: null };
    if (f.kind === 'amount') {
        p.amount = intOrNull(f.amount);
        if (!(p.amount >= 1 && p.amount <= 1000000)) return { error: '割引金額は、1〜1,000,000 の整数で入力してください。' };
    } else if (f.kind === 'percent') {
        p.percent = intOrNull(f.percent);
        if (!(p.percent >= 1 && p.percent <= 100)) return { error: '割引率は、1〜100 の整数で入力してください。' };
        p.cap_amount = intOrNull(f.cap_amount);
        if (Number.isNaN(p.cap_amount) || (p.cap_amount !== null && !(p.cap_amount >= 1 && p.cap_amount <= 1000000))) return { error: '割引の上限額は、1〜1,000,000 の整数で入力してください(空欄=上限なし)。' };
    } else if (f.kind === 'gift') {
        p.benefit = String(f.benefit || '').trim();
        if (!p.benefit) return { error: '特典の内容を入力してください(例:ドリンク1杯無料)。' };
        if (p.benefit.length > 100) return { error: '特典の内容は100文字以内にしてください。' };
    } else return { error: '割引の種類を選んでください。' };
    p.min_spend = intOrNull(f.min_spend);
    if (Number.isNaN(p.min_spend) || (p.min_spend !== null && p.min_spend < 0)) return { error: '最低利用金額は、0以上の整数で入力してください(空欄=条件なし)。' };
    p.conditions = String(f.conditions || '').trim();
    if (p.conditions.length > 300 || p.description.length > 300) return { error: '説明と利用条件は、それぞれ300文字以内にしてください。' };
    p.valid_days = null; p.valid_until = null;
    if (f.valid_type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.valid_until || ''))) return { error: '有効期限の日付を選んでください。' };
        p.valid_until = f.valid_until;
    } else {
        p.valid_days = intOrNull(f.valid_days);
        if (!(p.valid_days >= 1 && p.valid_days <= 730)) return { error: '有効期限は、発行から 1〜730 日の範囲で入力してください。' };
    }
    p.issue_limit = intOrNull(f.issue_limit);
    if (Number.isNaN(p.issue_limit) || (p.issue_limit !== null && p.issue_limit < 1)) return { error: '発行枚数の上限は、1以上の整数で入力してください(空欄=上限なし)。' };
    p.is_active = !!f.is_active;
    return { payload: p };
}

export async function renderCoupons({ app, client, openModal }) {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    const clientId = String(client.id);
    const [couponsRes, statsRes, settingsRes] = await Promise.all([
        supabase.from('neo_coupons').select('*').eq('client_id', clientId).is('deleted_at', null).order('created_at', { ascending: true }),
        supabase.from('neo_coupon_stats').select('*'),
        supabase.from('neo_reward_settings').select('*').eq('client_id', clientId).maybeSingle(),
    ]);
    if (couponsRes.error) {
        const m = String(couponsRes.error.message || '');
        app.replaceChildren(el('div', { class: 'page-title' }, 'クーポン・抽選'), el('div', { class: 'card' }, el('p', { style: { lineHeight: '1.8' },
            text: (m.includes('does not exist') || m.includes('Could not find') || m.includes('schema cache'))
                ? 'この画面を使うには、データベースの設定が必要です。Supabase で「追加SQL_9_クーポンとルーレット.sql」を実行してください。'
                : '読み込みに失敗しました: ' + m })));
        return;
    }
    let coupons = couponsRes.data || [];
    const stats = Object.fromEntries((statsRes.data || []).map(s => [s.coupon_id, s]));
    const saved = settingsRes.data || {};
    const state = {
        mode: saved.mode || 'none',
        coupon_id: saved.coupon_id || '',
        claim_limit: saved.claim_limit || 'once',
        avg_spend: saved.avg_spend || '',
        prizes: (saved.lottery?.prizes || []).map(p => ({ id: p.id || newId('p'), coupon_id: p.coupon_id || '', percent: String(p.percent ?? ''), fallback: !!p.fallback })),
    };
    const activeCoupons = () => coupons.filter(c => c.is_active);
    const couponById = (id) => coupons.find(c => c.id === id);
    const couponOptions = (selected, placeholder) => [
        el('option', { value: '', text: placeholder }),
        ...activeCoupons().map(c => el('option', { value: c.id, text: c.name, selected: c.id === selected })),
    ];

    // ---------- 保存(お礼の設定とルーレットを、まとめて保存する) ----------
    const saveMsgs = [];
    async function saveSettings(msgNode, button) {
        const total = state.prizes.reduce((s, p) => s + Math.round((num(p.percent) || 0) * 10), 0);
        const show = (ok, text) => { saveMsgs.forEach(n => { n.textContent = ''; }); msgNode.className = 'msg ' + (ok ? 'ok' : 'ng'); msgNode.textContent = text; };
        if (state.mode === 'coupon' && !state.coupon_id) return show(false, '「決まったクーポンを出す」を選んだときは、出すクーポンを選んでください。');
        if (state.prizes.some(p => !p.coupon_id)) return show(false, 'ルーレットの景品に、クーポンが選ばれていない行があります。選ぶか、行を削除してください。');
        if (state.mode === 'lottery' && total !== 1000) return show(false, `ルーレットの当選確率の合計が ${total / 10}% です。100% にしてください。`);
        button.disabled = true;
        const { data, error } = await supabase.rpc('neo_save_reward_settings', { p_client_id: clientId, p_settings: {
            mode: state.mode, coupon_id: state.mode === 'coupon' ? state.coupon_id : (state.coupon_id || null), claim_limit: state.claim_limit,
            avg_spend: String(state.avg_spend || '').trim() ? num(state.avg_spend) : null,
            prizes: state.prizes.map(p => ({ id: p.id, coupon_id: p.coupon_id, percent: num(p.percent), fallback: p.fallback })),
        } });
        button.disabled = false;
        if (error) return show(false, saveErrorText(error));
        show(true, data?.mode === 'none' ? '保存しました。お客様の画面に、クーポンのボタンは出ません。'
            : data?.mode === 'coupon' ? '保存しました。次に回答したお客様から、選んだクーポンが出ます。'
            : '保存しました。次に回答したお客様から、ルーレットが出ます。');
    }

    // ---------- お礼の設定 ----------
    const rewardCard = el('div', { class: 'card', id: 'rewardCard' });
    function drawReward() {
        const radio = (value, title, extra) => {
            const input = el('input', { type: 'radio', name: 'rewardMode', value, checked: state.mode === value });
            input.addEventListener('change', () => { state.mode = value; drawLottery(); });
            return el('label', { class: 'cp-radio' }, input, el('b', { text: title }), extra || null);
        };
        const couponSelect = el('select', { class: 'select', id: 'rewardCoupon', style: { flex: '1 1 220px', maxWidth: '340px' }, 'aria-label': '出すクーポン' }, ...couponOptions(state.coupon_id, '(クーポンを選んでください)'));
        couponSelect.addEventListener('change', () => { state.coupon_id = couponSelect.value; });
        const limitSelect = el('select', { class: 'select', id: 'claimLimit', style: { maxWidth: '260px' } },
            ...[['once', 'お一人さま1回'], ['daily', '1日1回'], ['unlimited', '回数の制限なし']].map(([v, t]) => el('option', { value: v, text: t, selected: state.claim_limit === v })));
        limitSelect.addEventListener('change', () => { state.claim_limit = limitSelect.value; });
        const msg = el('p', { class: 'msg', role: 'status' }); saveMsgs.push(msg);
        const btn = el('button', { class: 'btn', type: 'button', id: 'saveReward' }, '保存する');
        btn.addEventListener('click', () => saveSettings(msg, btn));
        rewardCard.replaceChildren(
            el('h2', { text: 'アンケート回答のお礼に出すクーポン' }),
            el('p', { class: 'muted', style: { marginBottom: '12px', lineHeight: '1.7' },
                text: 'お客様の画面の「アンケート回答によるクーポン取得」ボタンを押したあとに表示されます。口コミを投稿したかどうかには関係なく、アンケートに回答した方全員が対象です。' }),
            radio('coupon', '決まったクーポンを出す', couponSelect),
            radio('lottery', 'ルーレットで抽選する', el('span', { class: 'muted', text: '景品と確率は、下の「ルーレット(抽選)の設定」で決めます' })),
            radio('none', 'クーポンを出さない'),
            el('div', { class: 'field', style: { marginTop: '12px' } }, el('label', { for: 'claimLimit', text: '受け取れる回数' }), limitSelect,
                el('p', { class: 'muted', style: { marginTop: '4px', fontSize: '12px', lineHeight: '1.7' },
                    text: '同じスマートフォン(ブラウザ)ごとに数えます。会員登録なしの仕組みのため、ブラウザのデータを消した場合や別の端末では、もう一度受け取れます。' })),
            el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, btn), msg);
    }

    // ---------- クーポン一覧 ----------
    const listCard = el('div', { class: 'card', id: 'couponListCard' });
    function drawList() {
        const rows = coupons.map(c => {
            const st = stats[c.id] || { issued_count: 0, used_count: 0 };
            return el('tr', {},
                el('td', { style: { fontWeight: '700' }, text: c.name }),
                el('td', { text: couponSummary(c) }),
                el('td', { text: `${st.issued_count} / ${c.issue_limit ?? '上限なし'}` }),
                el('td', { text: String(st.used_count) }),
                el('td', { text: couponValidity(c) }),
                el('td', {}, el('span', { class: 'badge ' + (c.is_active ? 'on' : 'off'), text: c.is_active ? '公開中' : '下書き' })),
                el('td', {}, el('button', { class: 'btn small sub', type: 'button', onclick: () => openCouponForm(c) }, '編集')));
        });
        listCard.replaceChildren(
            el('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '12px' } },
                el('h2', { text: 'クーポン一覧', style: { margin: 0 } }),
                el('button', { class: 'btn', type: 'button', id: 'newCoupon', onclick: () => openCouponForm(null) }, el('i', { class: 'fa-solid fa-plus' }), 'クーポンを作成')),
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['クーポン名', '内容', '発行 / 上限', '利用', '有効期限', '状態', ''].map(h => el('th', { text: h })))),
                el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '7', class: 'muted', style: { textAlign: 'center', padding: '26px' }, text: 'クーポンはまだありません。「クーポンを作成」から作ってください。' }))])))));
    }

    function openCouponForm(coupon) {
        const c = coupon || { kind: 'amount', is_active: true, valid_days: 30 };
        const input = (attrs, value) => { const n = el('input', { class: 'input', ...attrs }); n.value = value ?? ''; return n; };
        const f = {
            name: input({ id: 'cpName', maxlength: '60', placeholder: '例:500円OFFクーポン' }, c.name),
            kind: el('select', { class: 'select', id: 'cpKind' }, ...[['amount', '金額割引(例:500円OFF)'], ['percent', '割合割引(例:10%OFF)'], ['gift', '特典(例:ドリンク1杯無料)']].map(([v, t]) => el('option', { value: v, text: t, selected: c.kind === v }))),
            amount: input({ id: 'cpAmount', inputmode: 'numeric', placeholder: '例:500' }, c.amount),
            percent: input({ id: 'cpPercent', inputmode: 'numeric', placeholder: '例:10' }, c.percent),
            cap_amount: input({ id: 'cpCap', inputmode: 'numeric', placeholder: '例:2000' }, c.cap_amount),
            benefit: input({ id: 'cpBenefit', maxlength: '100', placeholder: '例:ドリンク1杯無料' }, c.benefit),
            min_spend: input({ id: 'cpMin', inputmode: 'numeric', placeholder: '例:3000(空欄=条件なし)' }, c.min_spend),
            conditions: el('textarea', { class: 'textarea', id: 'cpConditions', maxlength: '300', placeholder: '例:お一人さま1回かぎり。ほかの割引との併用はできません。' }),
            description: el('textarea', { class: 'textarea', id: 'cpDescription', maxlength: '300', placeholder: '例:次回のご来店で使えるクーポンです。' }),
            valid_type: el('select', { class: 'select', id: 'cpValidType' }, el('option', { value: 'days', text: '発行した日から○日間', selected: !c.valid_until }), el('option', { value: 'date', text: '決まった日まで', selected: !!c.valid_until })),
            valid_days: input({ id: 'cpValidDays', inputmode: 'numeric', placeholder: '例:30' }, c.valid_days ?? (c.valid_until ? '' : 30)),
            valid_until: input({ id: 'cpValidUntil', type: 'date' }, c.valid_until),
            issue_limit: input({ id: 'cpLimit', inputmode: 'numeric', placeholder: '空欄=上限なし' }, c.issue_limit),
            is_active: el('select', { class: 'select', id: 'cpActive' }, el('option', { value: '1', text: '公開(お客様に出せる)', selected: c.is_active !== false }), el('option', { value: '0', text: '下書き(まだ出さない)', selected: c.is_active === false })),
        };
        f.conditions.value = c.conditions || ''; f.description.value = c.description || '';
        const field = (label, node, note) => el('div', { class: 'field' }, el('label', { for: node.id, text: label }), node, note ? el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' }, text: note }) : null);
        const fAmount = field('割引金額(円)', f.amount);
        const fPercent = el('div', { class: 'row' }, field('割引率(%)', f.percent), field('割引の上限額(円)', f.cap_amount, 'ルーレットの景品にする場合は、必ず入力してください'));
        const fBenefit = field('特典の内容', f.benefit);
        const fDays = field('発行から何日間', f.valid_days); const fDate = field('この日まで', f.valid_until);
        const sync = () => {
            fAmount.hidden = f.kind.value !== 'amount'; fPercent.hidden = f.kind.value !== 'percent'; fBenefit.hidden = f.kind.value !== 'gift';
            fDays.hidden = f.valid_type.value !== 'days'; fDate.hidden = f.valid_type.value !== 'date';
        };
        f.kind.addEventListener('change', sync); f.valid_type.addEventListener('change', sync); sync();
        const msg = el('p', { class: 'msg ng', role: 'alert' });
        const saveBtn = el('button', { class: 'btn', type: 'button', id: 'cpSave' }, coupon ? '変更を保存' : '作成する');
        const delBtn = coupon ? el('button', { class: 'btn danger', type: 'button', id: 'cpDelete' }, '削除') : null;
        const modal = openModal(el('div', { class: 'cp-form' },
            el('h3', { text: coupon ? 'クーポンの編集' : 'クーポンの作成' }),
            field('クーポン名(お客様に表示されます)', f.name),
            field('割引の種類', f.kind), fAmount, fPercent, fBenefit,
            field('最低利用金額(円)', f.min_spend),
            field('有効期限', f.valid_type), fDays, fDate,
            field('発行枚数の上限', f.issue_limit, '上限に達すると、それ以上は発行されません'),
            field('そのほかの利用条件', f.conditions),
            field('説明(お客様に表示されます)', f.description),
            field('状態', f.is_active),
            coupon ? el('p', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.7', marginBottom: '10px' }, text: '変更は、これから発行するクーポンに反映されます。すでにお客様に発行したクーポンの内容は変わりません。' }) : null,
            msg,
            el('div', { class: 'row', style: { justifyContent: 'space-between' } }, delBtn || el('span'),
                el('div', { class: 'row' }, el('button', { class: 'btn sub', type: 'button', onclick: () => modal.close() }, 'キャンセル'), saveBtn))));
        saveBtn.addEventListener('click', async () => {
            const built = buildCouponPayload({ name: f.name.value, description: f.description.value, kind: f.kind.value, amount: f.amount.value, percent: f.percent.value, cap_amount: f.cap_amount.value,
                benefit: f.benefit.value, min_spend: f.min_spend.value, conditions: f.conditions.value, valid_type: f.valid_type.value, valid_days: f.valid_days.value, valid_until: f.valid_until.value,
                issue_limit: f.issue_limit.value, is_active: f.is_active.value === '1' });
            if (built.error) { msg.textContent = built.error; return; }
            saveBtn.disabled = true; msg.textContent = '';
            const res = coupon
                ? await supabase.from('neo_coupons').update(built.payload).eq('id', coupon.id).select().single()
                : await supabase.from('neo_coupons').insert({ ...built.payload, client_id: clientId }).select().single();
            saveBtn.disabled = false;
            if (res.error) { msg.textContent = '保存できませんでした: ' + (res.error.message || ''); return; }
            if (coupon) coupons = coupons.map(x => x.id === coupon.id ? res.data : x); else coupons = [...coupons, res.data];
            modal.close(); drawAll();
        });
        delBtn?.addEventListener('click', async () => {
            const inUse = (state.mode === 'coupon' && state.coupon_id === coupon.id) || state.prizes.some(p => p.coupon_id === coupon.id);
            if (!confirm(`「${coupon.name}」を削除しますか?\n${inUse ? '※このクーポンは、今のお礼の設定(またはルーレットの景品)で使われています。削除すると、お客様に出せなくなります。\n' : ''}すでに発行したクーポンは、そのまま使えます。`)) return;
            delBtn.disabled = true;
            const { error } = await supabase.from('neo_coupons').update({ deleted_at: new Date().toISOString(), is_active: false }).eq('id', coupon.id);
            delBtn.disabled = false;
            if (error) { msg.textContent = '削除できませんでした: ' + (error.message || ''); return; }
            coupons = coupons.filter(x => x.id !== coupon.id);
            if (state.coupon_id === coupon.id) state.coupon_id = '';
            state.prizes = state.prizes.filter(p => p.coupon_id !== coupon.id);
            modal.close(); drawAll();
        });
    }

    // ---------- ルーレット(抽選)の設定 ----------
    const lotteryCard = el('div', { class: 'card', id: 'lotteryCard' });
    function drawLottery() {
        const totalNode = el('div', { class: 'cp-total', id: 'lotteryTotal' });
        const legalNode = el('div', { id: 'lotteryLegal' });
        const refresh = () => {
            const total = state.prizes.reduce((s, p) => s + Math.round((num(p.percent) || 0) * 10), 0) / 10;
            const ok = total === 100;
            totalNode.replaceChildren(`確率の合計 ${total}%`, el('span', { class: 'badge ' + (ok ? 'on' : 'off'), text: ok ? '保存できます' : '100%にしてください' }));
            const est = lotteryEstimate(state.prizes.map(p => ({ coupon: couponById(p.coupon_id), percent: num(p.percent) || 0 })), num(state.avg_spend));
            if (!est) { legalNode.replaceChildren(el('p', { class: 'muted', style: { fontSize: '12px' }, text: '平均客単価を入れると、景品の金額の目安を計算します。' })); return; }
            const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
            legalNode.replaceChildren(
                el('div', {}, `景品の最高額:${yen(est.maxValue)}(目安:客単価の20倍=${yen(est.maxAllowed)}まで) `, el('b', { style: { color: est.maxOk ? '#1E7E34' : '#9A3412' }, text: est.maxOk ? '範囲内' : '超えています' })),
                el('div', {}, `1回あたりの平均:約${yen(est.expected)} `, el('b', { style: { color: est.totalOk ? '#1E7E34' : '#9A3412' }, text: est.totalOk ? '範囲内の見込み' : '要確認' })),
                est.totalOk ? null : el('div', { text: `来店客の約${est.participationLimitPercent}%以上が参加すると、景品の総額が売上の2%を超える可能性があります。確率か割引の上限額を見直してください。` }),
                est.uncapped ? el('div', { style: { color: '#9A3412', fontWeight: '700' }, text: '割引率(%)のクーポンに、割引の上限額が入っていないものがあります。上限額を入れてください。' }) : null,
                est.hasGift ? el('div', { text: '特典(金額のないクーポン)は、この計算に含まれていません。' }) : null);
        };
        const rows = state.prizes.map((p, i) => {
            const sel = el('select', { class: 'select', 'aria-label': `景品${i + 1}のクーポン` }, ...couponOptions(p.coupon_id, '(クーポンを選ぶ)'));
            sel.addEventListener('change', () => { p.coupon_id = sel.value; refresh(); });
            const pct = el('input', { class: 'input', inputmode: 'decimal', style: { width: '90px', textAlign: 'right' }, 'aria-label': `景品${i + 1}の当選確率` }); pct.value = p.percent;
            pct.addEventListener('input', () => { p.percent = pct.value; refresh(); });
            const fb = el('input', { type: 'radio', name: 'fallbackPrize', checked: p.fallback, 'aria-label': `景品${i + 1}を参加賞にする`, style: { width: '18px', height: '18px' } });
            fb.addEventListener('change', () => { state.prizes.forEach(x => { x.fallback = x === p; }); });
            const c = couponById(p.coupon_id);
            return el('tr', { class: 'cp-prize' }, el('td', {}, sel),
                el('td', {}, el('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '6px' } }, pct, '%')),
                el('td', { style: { textAlign: 'center' } }, fb),
                el('td', { class: 'muted', text: c ? `${(stats[c.id]?.issued_count) || 0} / ${c.issue_limit ?? '上限なし'}` : '-' }),
                el('td', {}, el('button', { class: 'icon-btn', type: 'button', 'aria-label': `景品${i + 1}を削除`, onclick: () => { state.prizes.splice(i, 1); drawLottery(); } }, el('i', { class: 'fa-solid fa-trash' }), '削除')));
        });
        const avg = el('input', { class: 'input', id: 'avgSpend', inputmode: 'numeric', style: { maxWidth: '160px' }, placeholder: '例:5000' }); avg.value = state.avg_spend;
        avg.addEventListener('input', () => { state.avg_spend = avg.value; refresh(); });
        const msg = el('p', { class: 'msg', role: 'status' }); saveMsgs.push(msg);
        const btn = el('button', { class: 'btn', type: 'button', id: 'saveLottery' }, '設定を保存');
        btn.addEventListener('click', () => saveSettings(msg, btn));
        lotteryCard.replaceChildren(
            el('div', { class: 'row', style: { marginBottom: '10px' } }, el('h2', { text: 'ルーレット(抽選)の設定', style: { margin: 0 } }),
                el('span', { class: 'badge ' + (state.mode === 'lottery' ? 'on' : 'off'), id: 'lotteryBadge', text: state.mode === 'lottery' ? '使う設定になっています' : 'いまは使っていません' })),
            el('p', { class: 'muted', style: { marginBottom: '12px', lineHeight: '1.7' },
                text: '景品は、上の「クーポン一覧」で作ったクーポンから選びます。当選確率の合計は100%にしてください。「参加賞」は、ほかの景品が発行枚数の上限に達したときの代わりにも出るクーポンです(ほかの景品の確率は変わりません)。' }),
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['景品(クーポン)', '当選確率', '参加賞', '発行 / 上限', ''].map(h => el('th', { text: h })))),
                el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '5', class: 'muted', style: { textAlign: 'center', padding: '22px' }, text: '景品はまだありません。「景品を追加」から追加してください。' }))])))),
            el('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '12px' } },
                el('button', { class: 'btn sub', type: 'button', id: 'addPrize', onclick: () => { state.prizes.push({ id: newId('p'), coupon_id: '', percent: '', fallback: state.prizes.length === 0 }); drawLottery(); } }, el('i', { class: 'fa-solid fa-plus' }), '景品を追加'),
                totalNode),
            el('div', { class: 'cp-legal' },
                el('h3', { text: '景品表示法の目安チェック' }),
                el('div', { class: 'row', style: { marginBottom: '8px' } }, el('label', { for: 'avgSpend', text: '平均客単価(円)', style: { fontWeight: '700' } }), avg),
                legalNode,
                el('p', { style: { marginTop: '8px', fontSize: '12px' }, text: '抽選で渡す割引券は、景品表示法の「懸賞」にあたります(最高額は取引価額の20倍まで、総額は売上予定総額の2%まで)。ここに出るのは平均客単価から計算した目安です。実施の前に、専門家へご確認ください。' })),
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '14px' } }, btn), msg);
        refresh();
    }

    function drawAll() { saveMsgs.length = 0; drawReward(); drawList(); drawLottery(); }
    app.replaceChildren(el('div', { class: 'page-title' }, 'クーポン・抽選'), rewardCard, listCard, lotteryCard);
    drawAll();
}
