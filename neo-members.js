// neo-members.js
// MapOn NEO 管理画面の「会員・ショップカード」
//   ・ショップカードの内容(スタンプの数・特典・有効期限・公開/非公開)
//   ・会員証の入口のQRコード、スタンプ用QRコード(印刷・読み取り期限・作り直し)
//   ・会員一覧、手でスタンプを付ける・取り消す(修正用)、カードの再発行、電話番号の表示、会員の削除
// 見られる・書けるデータの範囲は、DB側の権限(RLS)と関数(追加SQL_10)で制限している。
// スタッフがお客様のQRコードを読み取る機能・クーポン番号で利用済みにする機能は、ない(お客様が自分で操作する)。

import { supabase } from './supabase-config.js';
import { el } from './survey-lib.js';
import { makeQrCanvas } from './survey-results.js';

export const MEMBERS_CSS = `
.mb-stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
.mb-stat { background: #fff; border-radius: 16px; padding: 16px 20px; box-shadow: 0 6px 18px rgba(0,0,0,0.04); min-width: 150px; flex: 1; }
.mb-stat .n { font-size: 26px; font-weight: 700; }
.mb-stat .l { font-size: 12px; color: var(--muted); }
.mb-qr { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
.mb-qr img { width: 180px; height: 180px; border: 1px solid var(--border-color); border-radius: 8px; flex: none; }
.mb-qr .info { flex: 1; min-width: 220px; font-size: 14px; line-height: 1.9; }
.mb-url { font-size: 12px; word-break: break-all; background: #F8FAFC; border-radius: 8px; padding: 8px 10px; margin: 6px 0; color: #4A5568; }
.mb-reward { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.mb-reward .input { width: 80px; text-align: right; }
.mb-reward .select { flex: 1; min-width: 200px; }
.mb-step { display: flex; align-items: center; gap: 8px; }
.mb-step button { width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--border-color); background: #fff; font-size: 20px; font-weight: 700; cursor: pointer; color: #2D3748; }
.mb-step output { min-width: 36px; text-align: center; font-size: 20px; font-weight: 700; }
.mb-section { border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px; }
.mb-section h4 { font-size: 14px; margin-bottom: 8px; }
.mb-hist { font-size: 12px; color: #4A5568; line-height: 1.9; max-height: 180px; overflow-y: auto; }
.mb-print { display: none; }
@media print {
  html.mb-printing body > *:not(.mb-print) { display: none !important; }
  html.mb-printing body { display: block; background: #fff; }
  html.mb-printing .mb-print { display: block; text-align: center; padding: 30px 20px; color: #000; }
  .mb-print h1 { font-size: 26px; margin-bottom: 6px; }
  .mb-print h2 { font-size: 34px; margin-bottom: 18px; }
  .mb-print img { width: 320px; height: 320px; }
  .mb-print p { font-size: 18px; line-height: 1.8; margin-top: 12px; }
}
`;

const ERRORS = [
    ['not_allowed', 'この店舗の会員を操作する権限がありません。'],
    ['invalid_card_name', 'カード名を入力してください(30文字まで)。'],
    ['invalid_goal', 'スタンプの数は、3〜30 の整数で入力してください。'],
    ['invalid_expire', 'スタンプの有効期限を選び直してください。'],
    ['invalid_notice', 'お店からの注意書きは、1000文字以内にしてください。'],
    ['invalid_rewards', '特典は5つまでにしてください。'],
    ['reward_at_invalid', '特典の「スタンプ何個目」は、1からスタンプの数までで、同じ数が重ならないようにしてください。'],
    ['reward_coupon_invalid', '特典に、公開中でないクーポン(下書き・削除済み)が含まれています。'],
    ['expires_in_past', '読み取り期限には、今日以降の日付を選んでください。'],
    ['no_stamps', '取り消せるスタンプがありません。'],
    ['invalid_delta', '付ける数は、1〜30 の範囲にしてください。'],
    ['member_not_found', 'この会員は、すでに削除されています。'],
];
function errorText(error) {
    const m = String(error?.message || '');
    const hit = ERRORS.find(([code]) => m.includes(code));
    if (hit) return hit[1];
    if (m.includes('Could not find') || m.includes('does not exist') || m.includes('schema cache')) return 'データベースの設定が必要です(Supabase で「追加SQL_10」を実行してください)。';
    return '処理できませんでした。時間をおいて、もう一度お試しください。';
}
// supabase の rpc は、失敗しても例外にしないことがある。通信の失敗(例外)もまとめて { data, error } にする
async function call(name, args) {
    try { return await supabase.rpc(name, args); } catch (e) { return { data: null, error: e }; }
}

const jst = (iso, withTime = false) => {
    if (!iso) return '-';
    const opt = { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) };
    return new Intl.DateTimeFormat('ja-JP', opt).format(new Date(iso));
};
const todayJst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());   // YYYY-MM-DD
export const memberNo = (n) => 'A' + String(n).padStart(4, '0');
export const cardEntryUrl = (key, origin = location.origin) => `${origin}/card?k=${encodeURIComponent(key)}`;
export const stampQrUrl = (token, origin = location.origin) => `${origin}/card?q=${encodeURIComponent(token)}`;
export const reissueUrl = (code, origin = location.origin) => `${origin}/card?r=${encodeURIComponent(code)}`;

async function qrImage(url, size = 480) {
    const img = el('img', { alt: 'QRコード' });
    try { img.src = (await makeQrCanvas(url, size)).toDataURL('image/png'); } catch { img.alt = 'QRコードを作れませんでした'; }
    return img;
}
async function downloadQr(url, filename) {
    const canvas = await makeQrCanvas(url, 1200);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
// 印刷用の紙面を作って、印刷の画面を開く
async function printQr({ storeName, title, url, lines }) {
    const img = await qrImage(url, 800);
    const sheet = el('div', { class: 'mb-print' }, el('h1', { text: storeName }), el('h2', { text: title }), img, ...lines.map(t => el('p', { text: t })));
    document.body.append(sheet);
    document.documentElement.classList.add('mb-printing');
    const done = () => { sheet.remove(); document.documentElement.classList.remove('mb-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
}

/** ショップカードの入力内容を確認して、保存する形にする。問題があれば { error } を返す */
export function buildCardPayload(f) {
    const name = String(f.card_name || '').trim();
    if (!name || name.length > 30) return { error: 'カード名を入力してください(30文字まで)。' };
    const goal = Number(String(f.stamp_goal || '').trim());
    if (!Number.isInteger(goal) || goal < 3 || goal > 30) return { error: 'スタンプの数は、3〜30 の整数で入力してください。' };
    const rewards = [];
    for (const r of f.rewards || []) {
        const at = Number(String(r.at || '').trim());
        if (!r.coupon_id) return { error: '特典に、クーポンが選ばれていない行があります。選ぶか、行を削除してください。' };
        if (!Number.isInteger(at) || at < 1 || at > goal) return { error: `特典の「スタンプ何個目」は、1〜${goal} の整数で入力してください。` };
        if (rewards.some(x => x.at === at)) return { error: `スタンプ${at}個目の特典が、2つあります。1つにしてください。` };
        rewards.push({ at, coupon_id: r.coupon_id });
    }
    if (rewards.length > 5) return { error: '特典は5つまでにしてください。' };
    const notice = String(f.join_notice || '').trim();
    if (notice.length > 1000) return { error: 'お店からの注意書きは、1000文字以内にしてください。' };
    return { payload: { enabled: !!f.enabled, card_name: name, stamp_goal: goal, rewards: rewards.sort((a, b) => a.at - b.at),
        expire_months: f.expire_months ? Number(f.expire_months) : null, join_notice: notice } };
}

export async function renderMembers({ app, client, openModal }) {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    const clientId = String(client.id);
    const storeName = client.company_name || '';
    const [setRes, couponsRes] = await Promise.all([
        call('neo_card_settings_get', { p_client_id: clientId }),
        supabase.from('neo_coupons').select('id, name, is_active, issue_limit, valid_until').eq('client_id', clientId).is('deleted_at', null).order('created_at', { ascending: true }),
    ]);
    if (setRes.error || !setRes.data?.settings) {
        app.replaceChildren(el('div', { class: 'page-title' }, '会員・ショップカード'), el('div', { class: 'card' }, el('p', { style: { lineHeight: '1.8' },
            text: setRes.error ? errorText(setRes.error).replace('データベースの設定が必要です', 'この画面を使うには、データベースの設定が必要です') : '読み込みに失敗しました。' })));
        return;
    }
    let settings = setRes.data.settings;
    let qr = setRes.data.qr || {};
    const coupons = (couponsRes.data || []).filter(c => c.is_active);
    let members = [];
    const loadMembers = async () => {
        const { data } = await supabase.from('neo_members')
            .select('id, member_no, name, phone_last4, stamps, cards_completed, total_stamps, last_stamp_at, created_at')
            .eq('client_id', clientId).is('deleted_at', null).order('member_no', { ascending: false }).limit(2000);
        members = data || [];
    };
    await loadMembers();

    // ---------- 上の数字 ----------
    const statsRow = el('div', { class: 'mb-stats', id: 'memberStats' });
    function drawStats() {
        const month = todayJst().slice(0, 7);
        const newThisMonth = members.filter(m => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(m.created_at)).slice(0, 7) === month).length;
        const stat = (n, l) => el('div', { class: 'mb-stat' }, el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: l }));
        statsRow.replaceChildren(stat(`${members.length}人`, '会員'), stat(`${newThisMonth}人`, '今月の登録'),
            stat(settings.enabled ? '公開中' : '非公開', 'ショップカード'));
    }

    // ---------- ショップカードの内容 ----------
    const cardCard = el('div', { class: 'card', id: 'cardSettings' });
    const state = {
        enabled: !!settings.enabled, card_name: settings.card_name || 'ショップカード', stamp_goal: String(settings.stamp_goal || 10),
        expire_months: settings.expire_months ? String(settings.expire_months) : '', join_notice: settings.join_notice || '',
        rewards: (settings.rewards || []).map(r => ({ at: String(r.at), coupon_id: r.coupon_id })),
    };
    function drawCard() {
        const enabled = el('select', { class: 'select', id: 'cardEnabled', style: { maxWidth: '320px' } },
            el('option', { value: '1', text: '公開(お客様が登録できる)', selected: state.enabled }), el('option', { value: '0', text: '非公開(登録もスタンプも止める)', selected: !state.enabled }));
        enabled.addEventListener('change', () => { state.enabled = enabled.value === '1'; });
        const name = el('input', { class: 'input', id: 'cardName', maxlength: '30', style: { maxWidth: '320px' } }); name.value = state.card_name;
        name.addEventListener('input', () => { state.card_name = name.value; });
        const goal = el('input', { class: 'input', id: 'cardGoal', inputmode: 'numeric', style: { maxWidth: '120px' } }); goal.value = state.stamp_goal;
        goal.addEventListener('input', () => { state.stamp_goal = goal.value; });
        const expire = el('select', { class: 'select', id: 'cardExpire', style: { maxWidth: '320px' } },
            ...[['', '期限なし'], ['3', '最後のスタンプから3か月'], ['6', '最後のスタンプから6か月'], ['12', '最後のスタンプから1年'], ['24', '最後のスタンプから2年']]
                .map(([v, t]) => el('option', { value: v, text: t, selected: state.expire_months === v })));
        expire.addEventListener('change', () => { state.expire_months = expire.value; });
        const notice = el('textarea', { class: 'textarea', id: 'cardNotice', maxlength: '1000', placeholder: '例:スタンプは、1回のご来店(お会計)につき1個です。' }); notice.value = state.join_notice;
        notice.addEventListener('input', () => { state.join_notice = notice.value; });
        const rewardRows = state.rewards.map((r, i) => {
            const at = el('input', { class: 'input', inputmode: 'numeric', 'aria-label': `特典${i + 1}:スタンプ何個目` }); at.value = r.at;
            at.addEventListener('input', () => { r.at = at.value; });
            const sel = el('select', { class: 'select', 'aria-label': `特典${i + 1}のクーポン` }, el('option', { value: '', text: '(クーポンを選ぶ)' }),
                ...coupons.map(c => el('option', { value: c.id, text: c.name + (c.issue_limit ? '(発行枚数の上限あり)' : ''), selected: c.id === r.coupon_id })));
            sel.addEventListener('change', () => { r.coupon_id = sel.value; });
            return el('div', { class: 'mb-reward' }, 'スタンプ', at, '個目で', sel,
                el('button', { class: 'icon-btn', type: 'button', 'aria-label': `特典${i + 1}を削除`, onclick: () => { state.rewards.splice(i, 1); drawCard(); } }, el('i', { class: 'fa-solid fa-trash' }), '削除'));
        });
        const msg = el('p', { class: 'msg', role: 'status' });
        const saveBtn = el('button', { class: 'btn', type: 'button', id: 'saveCard' }, '保存する');
        saveBtn.addEventListener('click', async () => {
            const built = buildCardPayload(state);
            if (built.error) { msg.className = 'msg ng'; msg.textContent = built.error; return; }
            saveBtn.disabled = true;
            const { data, error } = await call('neo_save_card_settings', { p_client_id: clientId, p_settings: built.payload });
            saveBtn.disabled = false;
            if (error || !data) { msg.className = 'msg ng'; msg.textContent = errorText(error); return; }
            settings = data;
            msg.className = 'msg ok';
            msg.textContent = settings.enabled ? '保存しました。お客様がショップカードを登録できます。' : '保存しました。いまは非公開です(登録もスタンプも止まっています)。';
            const badge = document.getElementById('cardBadge');
            if (badge) { badge.className = 'badge ' + (settings.enabled ? 'on' : 'off'); badge.textContent = settings.enabled ? '公開中' : '非公開'; }
            drawStats(); drawList();
        });
        cardCard.replaceChildren(
            el('div', { class: 'row', style: { marginBottom: '10px' } }, el('h2', { text: 'ショップカードの内容', style: { margin: 0 } }),
                el('span', { class: 'badge ' + (settings.enabled ? 'on' : 'off'), id: 'cardBadge', text: settings.enabled ? '公開中' : '非公開' })),
            el('div', { class: 'field' }, el('label', { for: 'cardEnabled', text: '状態' }), enabled),
            el('div', { class: 'field' }, el('label', { for: 'cardName', text: 'カード名(お客様に表示されます)' }), name),
            el('div', { class: 'field' }, el('label', { for: 'cardGoal', text: 'スタンプの数(カード1枚あたり)' }), goal,
                el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' }, text: 'いっぱいになると、次のカードが0個から始まります。付くのは、1回の読み取りで1個・同じ会員は1日1回までです。' })),
            el('div', { class: 'field' }, el('label', { text: '特典(スタンプが決めた数になったときに届くクーポン)' }),
                ...rewardRows,
                coupons.length ? null : el('p', { class: 'warnbox', text: '特典に使うクーポンがありません。先に「クーポン・抽選」でクーポンを作って、公開してください。' }),
                el('button', { class: 'btn sub small', type: 'button', id: 'addReward', disabled: state.rewards.length >= 5 || !coupons.length,
                    onclick: () => { state.rewards.push({ at: state.rewards.length ? '' : state.stamp_goal, coupon_id: '' }); drawCard(); } }, el('i', { class: 'fa-solid fa-plus' }), '特典を追加'),
                el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '6px', lineHeight: '1.7' },
                    text: '特典は、クーポンとしてお客様の会員証に届きます。使うときは、お客様がスタッフの前で「クーポンを使う」を押します。発行枚数の上限があるクーポンは、上限に達すると届かなくなります。' })),
            el('div', { class: 'field' }, el('label', { for: 'cardExpire', text: 'スタンプの有効期限' }), expire),
            el('div', { class: 'field' }, el('label', { for: 'cardNotice', text: 'お店からの注意書き(登録の画面の「利用規約」に表示されます)' }), notice),
            el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, saveBtn), msg);
    }

    // ---------- 会員証の入口・スタンプ用QRコード ----------
    const entryCard = el('div', { class: 'card', id: 'entryCard' });
    async function drawEntry() {
        const url = cardEntryUrl(settings.card_key);
        entryCard.replaceChildren(
            el('h2', { text: '会員証の入口(登録・会員証の表示用)' }),
            el('div', { class: 'mb-qr' }, await qrImage(url),
                el('div', { class: 'info' },
                    el('div', { text: 'お客様がこのQRコードを読み取ると、未登録の方には登録の画面、登録済みの方には会員証が出ます。' }),
                    el('div', { class: 'mb-url', id: 'entryUrl', text: url }),
                    el('div', { class: 'row' },
                        el('button', { class: 'btn sub small', type: 'button', onclick: () => printQr({ storeName, title: settings.card_name, url, lines: ['スマートフォンのカメラで読み取ると、ショップカードを作れます。', '登録はお名前と電話番号だけです。'] }) }, '印刷する'),
                        el('button', { class: 'btn sub small', type: 'button', onclick: () => downloadQr(url, `会員証の入口QR_${storeName}.png`) }, 'PNGをダウンロード')),
                    el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '8px', lineHeight: '1.7' }, text: 'アンケートのQRコードを読み取った画面にも、ショップカードへの入口と、お客様が持っているクーポンが出ます。' }))));
    }

    const qrCard = el('div', { class: 'card', id: 'stampQrCard' });
    async function drawQr(message = '') {
        const url = stampQrUrl(qr.token);
        const expired = qr.expires_on && qr.expires_on < todayJst();
        const msg = el('p', { class: 'msg ok', role: 'status', text: message });
        const expiryBtn = el('button', { class: 'btn sub small', type: 'button', id: 'qrExpiry' }, '期限を変える');
        expiryBtn.addEventListener('click', () => {
            const input = el('input', { class: 'input', type: 'date', id: 'qrExpiryDate', min: todayJst() }); input.value = qr.expires_on || '';
            const m = el('p', { class: 'msg ng', role: 'alert' });
            const save = async (value) => {
                const { data, error } = await call('neo_stamp_qr_update', { p_client_id: clientId, p_action: 'expiry', p_expires_on: value || null });
                if (error || !data) { m.textContent = errorText(error); return; }
                qr = data; modal.close(); drawQr(value ? '読み取り期限を変更しました。' : '読み取り期限をなくしました。');
            };
            const modal = openModal(el('div', {},
                el('h3', { text: 'スタンプ用QRコードの読み取り期限' }),
                el('p', { class: 'muted', style: { lineHeight: '1.7', marginBottom: '10px' }, text: '選んだ日の終わりまで読み取れます。期限を過ぎると、お客様が読み取ってもスタンプは付きません。QRコードの絵は変わりません。' }),
                el('div', { class: 'field' }, el('label', { for: 'qrExpiryDate', text: 'この日まで' }), input), m,
                el('div', { class: 'row', style: { justifyContent: 'space-between' } },
                    el('button', { class: 'btn sub', type: 'button', id: 'qrExpiryNone', onclick: () => save('') }, '期限なしにする'),
                    el('div', { class: 'row' }, el('button', { class: 'btn sub', type: 'button', onclick: () => modal.close() }, 'キャンセル'),
                        el('button', { class: 'btn', type: 'button', id: 'qrExpirySave', onclick: () => { if (!input.value) { m.textContent = '日付を選んでください。'; return; } save(input.value); } }, '保存する')))));
        });
        const renewBtn = el('button', { class: 'btn danger small', type: 'button', id: 'qrRenew' }, '作り直す');
        renewBtn.addEventListener('click', async () => {
            if (!confirm('スタンプ用QRコードを作り直しますか?\n古いQRコードは、すぐに使えなくなります。印刷して置いているものは、新しいものに取り替えてください。')) return;
            renewBtn.disabled = true;
            const { data, error } = await call('neo_stamp_qr_update', { p_client_id: clientId, p_action: 'renew', p_expires_on: null });
            renewBtn.disabled = false;
            if (error || !data) { msg.className = 'msg ng'; msg.textContent = errorText(error); return; }
            qr = data; drawQr('新しいQRコードを作りました。古いQRコードは使えません。印刷して取り替えてください。');
        });
        qrCard.replaceChildren(
            el('h2', { text: 'スタンプ用QRコード' }),
            el('div', { class: 'mb-qr' }, await qrImage(url),
                el('div', { class: 'info' },
                    el('div', { text: 'レジ横に置いて、お客様が自分のスマートフォンで読み取ります。' }),
                    el('div', {}, el('b', { text: '付く数:' }), '1回の読み取りで1個'),
                    el('div', {}, el('b', { text: '制限:' }), '同じ会員は1日1回まで'),
                    el('div', { id: 'qrExpiryText' }, el('b', { text: '読み取り期限:' }), qr.expires_on ? qr.expires_on.replaceAll('-', '/') + ' まで' : '期限なし',
                        expired ? el('span', { class: 'badge off', style: { marginLeft: '8px', color: 'var(--danger)' }, text: '期限切れ(いまは読み取れません)' }) : null),
                    el('div', { class: 'row', style: { marginTop: '8px' } },
                        el('button', { class: 'btn small', type: 'button', id: 'qrPrint', onclick: () => printQr({ storeName, title: 'スタンプはこちら', url, lines: ['お会計のときに、スマートフォンのカメラで読み取ってください。', 'スタンプが1個付きます(お一人さま1日1回)。'] }) }, '印刷する'),
                        expiryBtn, renewBtn),
                    msg,
                    el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '8px', lineHeight: '1.7' },
                        text: '作り直すと、古いQRコードは使えなくなります。写真に撮られて、来店していないのに読み取られている疑いがあるときに使います。会員でない方が読み取ると、登録の画面が出ます。' }))));
    }

    // ---------- 会員一覧 ----------
    const listCard = el('div', { class: 'card', id: 'memberList' });
    let keyword = '';
    function drawList() {
        const goal = settings.stamp_goal;
        const search = el('input', { class: 'input', id: 'memberSearch', placeholder: '名前・会員番号・電話番号の下4桁で検索', style: { maxWidth: '320px' } }); search.value = keyword;
        const body = el('tbody', {});
        const fill = () => {
            const k = keyword.trim().toLowerCase();
            const hit = members.filter(m => !k || m.name.toLowerCase().includes(k) || memberNo(m.member_no).toLowerCase().includes(k) || m.phone_last4 === k);
            body.replaceChildren(...(hit.length ? hit.map(m => el('tr', {},
                el('td', { style: { fontWeight: '700' }, text: memberNo(m.member_no) }),
                el('td', { text: `${m.name} 様` }),
                el('td', { text: `***-****-${m.phone_last4}` }),
                el('td', { text: `${m.stamps} / ${goal}個` + (m.cards_completed ? `(満了${m.cards_completed}枚)` : '') }),
                el('td', { text: jst(m.last_stamp_at) }),
                el('td', { text: jst(m.created_at) }),
                el('td', {}, el('button', { class: 'btn small sub', type: 'button', onclick: () => openMember(m.id) }, 'くわしく'))))
                : [el('tr', {}, el('td', { colspan: '7', class: 'muted', style: { textAlign: 'center', padding: '26px' }, text: members.length ? '当てはまる会員がいません。' : '会員はまだいません。お客様が「会員証の入口」か「スタンプ用QRコード」を読み取って登録すると、ここに出ます。' }))]));
        };
        search.addEventListener('input', () => { keyword = search.value; fill(); });
        listCard.replaceChildren(
            el('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '12px' } },
                el('h2', { text: `会員一覧 ${members.length}人`, style: { margin: 0 } }), search),
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['会員番号', '名前', '電話番号', 'スタンプ', '最後のスタンプ', '登録日', '操作'].map(h => el('th', { text: h })))), body)),
            el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' }, text: '電話番号は下4桁だけ表示しています。全部を表示した操作は記録されます。' }));
        fill();
    }

    // ---------- 会員1人の画面(手で付ける・取り消す、再発行、電話番号、削除) ----------
    async function openMember(id) {
        const content = el('div', { id: 'memberDetail' });
        const modal = openModal(content);
        const HIST = { qr: 'QRで付与', manual: '手で付与', cancel: '取り消し', expire: '有効期限切れ' };
        let count = 1;
        async function draw(message = '', ok = true) {
            const m = members.find(x => x.id === id);
            if (!m) { modal.close(); return; }
            const { data: events } = await supabase.from('neo_stamp_events').select('kind, delta, stamps_after, note, created_at, jst_date')
                .eq('member_id', id).order('created_at', { ascending: false }).limit(20);
            const stampedToday = (events || []).some(e => e.kind === 'qr' && e.jst_date === todayJst());
            const msg = el('p', { class: 'msg ' + (ok ? 'ok' : 'ng'), role: 'status', id: 'memberMsg', text: message });
            const run = async (name, args, done) => {
                const { data, error } = await call(name, args);
                if (error) { await draw(errorText(error), false); return; }
                await loadMembers(); drawStats(); drawList();
                await draw(done(data));
            };
            const out = el('output', { id: 'stampCountOut', text: String(count) });
            const step = (d) => { count = Math.min(30, Math.max(1, count + d)); out.textContent = String(count); };
            const note = el('input', { class: 'input', id: 'stampNote', maxlength: '100', placeholder: '理由のメモ(例:QRコードが読めなかった)' });
            const phoneNode = el('span', { id: 'memberPhone', text: `***-****-${m.phone_last4}` });
            const phoneBtn = el('button', { class: 'btn sub small', type: 'button', id: 'revealPhone' }, '全部を表示(記録されます)');
            phoneBtn.addEventListener('click', async () => {
                phoneBtn.disabled = true;
                const { data, error } = await call('neo_member_reveal_phone', { p_member_id: id });
                if (error || !data) { phoneBtn.disabled = false; msg.className = 'msg ng'; msg.textContent = errorText(error); return; }
                phoneNode.textContent = data; phoneBtn.remove();
            });
            const reissueBox = el('div', { id: 'reissueBox' });
            const reissueBtn = el('button', { class: 'btn sub', type: 'button', id: 'reissueBtn' }, 'カードを再発行する(機種変更・紛失のとき)');
            reissueBtn.addEventListener('click', async () => {
                if (!confirm(`${memberNo(m.member_no)} ${m.name} 様のカードを再発行しますか?\nお名前と電話番号の下4桁で、ご本人であることを確認してから進めてください。\n再発行すると、これまでのスマートフォンでは会員証が表示されなくなります(スタンプとクーポンは引き継がれます)。`)) return;
                reissueBtn.disabled = true;
                const { data, error } = await call('neo_member_reissue', { p_member_id: id });
                reissueBtn.disabled = false;
                if (error || !data?.code) { msg.className = 'msg ng'; msg.textContent = errorText(error); return; }
                const url = reissueUrl(data.code);
                reissueBox.replaceChildren(el('div', { class: 'mb-qr', style: { marginTop: '10px' } }, await qrImage(url),
                    el('div', { class: 'info' },
                        el('b', { text: 'お客様の新しいスマートフォンのカメラで、このQRコードを読み取ってもらってください。' }),
                        el('div', { text: `使えるのは1回だけ・${jst(data.expires_at, true).slice(-5)} まで(15分間)です。` }),
                        el('div', { class: 'muted', style: { fontSize: '12px' }, text: '読み取ると、そのスマートフォンで会員証が表示されるようになります。この画面を閉じると、QRコードは表示し直せません(もう一度「再発行」を押してください)。' }))));
            });
            const delBtn = el('button', { class: 'btn danger small', type: 'button', id: 'deleteMember' }, 'この会員を削除する');
            delBtn.addEventListener('click', async () => {
                if (!confirm(`${memberNo(m.member_no)} ${m.name} 様を削除しますか?\nお名前・電話番号・スタンプ・未使用の特典クーポンが消えて、元に戻せません。\n(お客様から削除のお申し出があったときに使います)`)) return;
                delBtn.disabled = true;
                const { error } = await call('neo_member_delete', { p_member_id: id });
                if (error) { delBtn.disabled = false; msg.className = 'msg ng'; msg.textContent = errorText(error); return; }
                await loadMembers(); drawStats(); drawList(); modal.close();
            });
            content.replaceChildren(
                el('h3', { text: `${memberNo(m.member_no)} ${m.name} 様` }),
                el('p', { id: 'memberSummary', style: { fontSize: '14px', lineHeight: '1.8' },
                    text: `いまのスタンプ:${m.stamps} / ${settings.stamp_goal}個` + (m.cards_completed ? `(いっぱいになったカード ${m.cards_completed}枚)` : '') + ` / ${stampedToday ? '今日はQRコードで付いています' : '今日はまだQRコードで付いていません'}` }),
                el('div', { class: 'row', style: { fontSize: '14px' } }, '電話番号:', phoneNode, phoneBtn),
                msg,
                el('div', { class: 'mb-section' }, el('h4', { text: '手で付ける・取り消す(修正用)' }),
                    el('div', { class: 'row' },
                        el('div', { class: 'mb-step' }, el('button', { type: 'button', 'aria-label': '減らす', onclick: () => step(-1) }, '−'), out, el('button', { type: 'button', 'aria-label': '増やす', id: 'stampPlus', onclick: () => step(1) }, '+')),
                        el('button', { class: 'btn', type: 'button', id: 'stampAdd', onclick: () => run('neo_member_stamp_manual', { p_member_id: id, p_delta: count, p_note: note.value.trim() || null },
                            (d) => `スタンプを${count}個付けました。` + ((d?.rewards || []).length ? `特典「${d.rewards.map(r => r.label).join('」「')}」のクーポンが、お客様の会員証に届きました。` : '') + (d?.reward_missed ? '※特典のクーポンは発行できませんでした(公開中でない、または発行枚数の上限に達しています)。' : '')) }, 'スタンプを付ける'),
                        el('button', { class: 'btn sub', type: 'button', id: 'stampCancel', onclick: () => { if (confirm(`スタンプを${count}個取り消しますか?\n取り消すスタンプで届いた特典のクーポンが未使用なら、そのクーポンも取り消されます。`)) run('neo_member_stamp_manual', { p_member_id: id, p_delta: -count, p_note: note.value.trim() || null }, () => `スタンプを${count}個取り消しました。`); } }, '取り消す')),
                    el('div', { class: 'field', style: { marginTop: '10px', marginBottom: 0 } }, note),
                    el('p', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' }, text: 'ふだんは、お客様がスタンプ用QRコードを読み取ります。ここは、読み取れなかったときや付け間違いの修正に使います。だれが操作したかは、履歴に残ります。' })),
                el('div', { class: 'mb-section' }, reissueBtn, reissueBox),
                el('div', { class: 'mb-section' }, el('h4', { text: 'スタンプの履歴(新しい順・20件まで)' }),
                    el('div', { class: 'mb-hist', id: 'memberHistory' }, ...((events || []).length
                        ? events.map(e => el('div', { text: `${jst(e.created_at, true)} ${HIST[e.kind] || e.kind} ${e.delta > 0 ? '+' : ''}${e.delta}個 → ${e.stamps_after}個${e.note ? ` (${e.note})` : ''}` }))
                        : [el('div', { text: 'まだありません。' })]))),
                el('div', { class: 'row mb-section', style: { justifyContent: 'space-between' } }, delBtn,
                    el('button', { class: 'btn sub', type: 'button', onclick: () => modal.close() }, '閉じる')));
        }
        await draw();
    }

    app.replaceChildren(el('div', { class: 'page-title' }, '会員・ショップカード'), statsRow, cardCard, entryCard, qrCard, listCard);
    drawStats(); drawCard(); drawList();
    await drawEntry(); await drawQr();
}
