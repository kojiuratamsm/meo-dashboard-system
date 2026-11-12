// card-page.js
// お客様の会員証・ショップカードの画面(card.html)。
//   /card?k=<お店ごとの文字>            会員証を開く(登録した端末では、入力なしで表示される。未登録なら登録フォーム)
//   /card?q=<スタンプ用QRコードの文字>   レジ横のQRコードを読み取ったとき(スタンプを付ける。同じ会員は1日1回)
//   /card?r=<再発行の合い言葉>          店頭でスタッフに再発行してもらったとき(この端末で会員証を使えるようにする)
// ・だれの会員証かは、サーバーが発行した「端末の印」(Cookie)で決まる。名前や電話番号を入れて開く方法はない。
// ・会員の画面では、URLの最後(#m=...)に会員専用の合い言葉を付ける。ホーム画面に追加しておくと、
//   端末の印が消えたときも、そのアイコンから開けば会員証が戻る。
// ・クーポンの利用は、クーポン画面(coupon.html)の「クーポンを使う」で行う(スタッフの前で、お客様が自分で押す)。

import { walletApi, renderCouponList, WALLET_CSS } from './wallet-lib.js';
import { formatDateJa } from './coupon-lib.js';

document.head.append(Object.assign(document.createElement('style'), { textContent: WALLET_CSS }));

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let cardKey = params.get('k') || '';
const stampQr = params.get('q') || '';
const reissueCode = params.get('r') || '';
const memberKeyInUrl = (location.hash.match(/m=([0-9a-f]{64})/) || [])[1] || '';
let current = null;   // いま表示している内容(サーバーの返事)

const STAMP_MESSAGES = {
    already_today: ['info', '本日のスタンプは、すでに付いています', 'スタンプは1日1回までです。またのご来店をお待ちしております。'],
    qr_expired: ['warn', 'このQRコードは、読み取り期限が過ぎています', 'お手数ですが、スタッフにお声がけください。'],
    qr_invalid: ['warn', 'このQRコードは使えません', '古いQRコードの可能性があります。お手数ですが、スタッフにお声がけください。'],
    card_disabled: ['warn', 'ショップカードは、現在お休み中です', ''],
};
const JOIN_ERRORS = {
    invalid_name: 'お名前を入力してください(40文字まで)。',
    invalid_phone: '電話番号を、市外局番から入力してください(例:090-1234-5678)。',
    consent_required: '利用規約と個人情報の利用目的を確認して、チェックを入れてください。',
    phone_exists: 'この電話番号は、すでに登録されています。プライベートブラウズや、登録したときとちがうアプリで開いていると、会員証が表示されません(上の「すでに登録済みの方はこちら」をご覧ください)。機種変更などのときは、お店のスタッフに「カードの再発行」とお伝えください。',
    busy: 'ただいま登録が混み合っています。しばらくしてから、もう一度お試しください。',
    card_disabled: 'このお店のショップカードは、現在ご利用いただけません。',
};
const NETWORK_ERROR = '通信できませんでした。電波の良い場所で、もう一度お試しください。';

function banner(kind, title, sub = '') {
    const b = $('banner');
    b.className = `banner ${kind}`;
    b.replaceChildren(title, ...(sub ? [Object.assign(document.createElement('small'), { textContent: sub })] : []));
    b.hidden = false;
}

function showError(title, text) {
    $('loading').hidden = true;
    ['joinView', 'cardView', 'couponBox', 'historyBox', 'homeHint'].forEach(id => { $(id).hidden = true; });
    $('errorTitle').textContent = title; $('errorText').textContent = text;
    $('errorView').hidden = false;
}

// 登録画面に出す文面(お店が書いた注意書きがあれば、あとに続ける)
function termsText(card) {
    return [
        '・スタンプは、ご来店のときにお店のQRコードを読み取ると付きます(同じ会員は1日1回まで)。',
        '・特典は、スタンプが決められた数になったときに、クーポンとしてお渡しします。クーポンには有効期限があります。',
        card.expire_months ? `・スタンプは、最後に付いた日から${card.expire_months}か月で消えます。` : null,
        '・カードとスタンプは、ほかの方に譲ることはできません。',
        '・正しくない方法で付いたスタンプは、取り消すことがあります。',
        '・内容は、変更・終了することがあります。',
        card.join_notice ? `\n【お店から】\n${card.join_notice}` : null,
    ].filter(Boolean).join('\n');
}
function privacyText(storeName) {
    return [
        `お預かりするお名前と電話番号は、${storeName || 'このお店'}が、次の目的で利用します。`,
        '・会員証とショップカードの発行・管理',
        '・カードを再発行するときのご本人確認',
        '広告や勧誘のご連絡には使いません。',
        'システムの運用は、株式会社MSM(MapOn)に委託しています。',
        '登録の削除をご希望のときは、お店のスタッフにお申し出ください。',
    ].join('\n');
}
const rewardsSummary = (card) => (card.rewards || []).map(r => `${r.at}個:${r.label}`);

function renderCoupons(view) {
    const coupons = view.coupons || [];
    $('couponBox').hidden = coupons.length === 0;
    $('couponTitle').textContent = `使えるクーポン ${coupons.length}枚`;
    renderCouponList($('couponList'), coupons);
}

function renderJoin(view) {
    const card = view.card || {};
    $('joinStore').textContent = view.store_name || '';
    const info = [`スタンプ${card.goal}個のカードです。`, ...rewardsSummary(card)];
    $('joinCardInfo').textContent = info.join(' / ');
    $('termsText').textContent = termsText(card);
    $('privacyText').textContent = privacyText(view.store_name);
    $('joinView').hidden = false;
}

const HISTORY_LABEL = { qr: 'スタンプ', manual: 'スタンプ(お店で付与)', cancel: '取り消し', expire: '有効期限切れ' };
function renderCard(view) {
    const card = view.card || {}, m = view.member;
    $('storeName').textContent = view.store_name || '';
    $('memberNo').textContent = m.no;
    $('memberName').textContent = `${m.name} 様`;
    const enabled = card.enabled === true;
    $('stampPanel').hidden = !enabled; $('howTo').hidden = !enabled; $('closedNote').hidden = enabled;
    if (enabled) {
        const goal = Number(card.goal) || 10, stamps = Number(m.stamps) || 0;
        const rewardAt = new Set((card.rewards || []).map(r => Number(r.at)));
        $('cardName').textContent = card.name || 'ショップカード';
        $('stampCount').textContent = String(stamps);
        $('stampGoal').textContent = String(goal);
        $('stampGrid').setAttribute('aria-label', `スタンプ ${goal}個中 ${stamps}個`);
        $('stampGrid').classList.toggle('many', goal > 30);
        $('stampGrid').replaceChildren(...Array.from({ length: goal }, (_, i) => {
            const n = i + 1, cell = document.createElement('div');
            cell.className = 'cell' + (n <= stamps ? ' on' : '') + (rewardAt.has(n) ? ' reward' : '');
            cell.textContent = n <= stamps ? '✓' : rewardAt.has(n) ? '特典' : String(n);
            return cell;
        }));
        const next = (card.rewards || []).find(r => Number(r.at) > stamps);
        $('nextReward').hidden = !next;
        if (next) $('nextReward').textContent = `あと${Number(next.at) - stamps}個で「${next.label}」がもらえます`;
        $('rewardList').replaceChildren(...rewardsSummary(card).map(t => Object.assign(document.createElement('li'), { textContent: t })));
        const exp = $('expireNote');
        exp.hidden = !card.expire_months;
        exp.textContent = m.stamps_expire_on
            ? `いまのスタンプの有効期限:${formatDateJa(m.stamps_expire_on + 'T00:00:00+09:00')}(最後のスタンプから${card.expire_months}か月)`
            : `スタンプの有効期限:最後のスタンプから${card.expire_months}か月`;
        $('howTo').textContent = m.stamped_today
            ? '本日のスタンプは付いています。次回のご来店でも、レジ横のQRコードを読み取ってください(1日1回)。'
            : 'レジ横のQRコードを、このスマートフォンのカメラで読み取ると、スタンプが付きます(1日1回)。';
    }
    const history = m.history || [];
    $('historyBox').hidden = history.length === 0;
    $('historyList').replaceChildren(...history.map(h => {
        const li = document.createElement('li');
        const d = Number(h.delta) || 0;
        li.append(Object.assign(document.createElement('span'), { textContent: `${formatDateJa(h.at)} ${HISTORY_LABEL[h.kind] || ''}` }),
            Object.assign(document.createElement('b'), { textContent: `${d > 0 ? '+' : ''}${d}個` }));
        return li;
    }));
    $('homeHint').hidden = false;
    $('cardView').hidden = false;
}

// サーバーの返事を画面に出す
function render(view) {
    $('loading').hidden = true;
    if (!view || view.ok === false) {
        showError('会員証を表示できません', 'お店のQRコードを、もう一度読み取ってください。');
        return;
    }
    current = view;
    const card = view.card || {};
    if (card.key) cardKey = card.key;
    document.title = `${view.store_name || ''} 会員証・ショップカード`;
    ['errorView', 'joinView', 'cardView', 'historyBox', 'homeHint'].forEach(id => { $(id).hidden = true; });
    renderCoupons(view);
    if (view.member) {
        renderCard(view);
        // アドレスを「このお店の会員証」の形にそろえる(スタンプ用・再発行用の文字は消す)。
        // #m=... は会員専用の合い言葉。ホーム画面に追加したアイコンから、会員証を開き直せるようにする。
        try { history.replaceState(null, '', `/card?k=${encodeURIComponent(cardKey)}#m=${view.member.key}`); } catch { /* 変えられなくても続ける */ }
    } else if (card.enabled) {
        renderJoin(view);
        if (reissueCode) { try { history.replaceState(null, '', `/card?k=${encodeURIComponent(cardKey)}`); } catch { /* 続ける */ } }
    } else {
        showError('ショップカードは、現在ご利用いただけません', 'このお店では、ショップカードを公開していません。');
        renderCoupons(view);
    }
}

function showStampResult(stamp) {
    if (!stamp) return;
    if (stamp.status === 'stamped') {
        const rewards = (stamp.rewards || []).map(r => `「${r.label}」`).join('');
        const lines = [];
        if (Number(stamp.completed) > 0) lines.push('カードがいっぱいになりました。新しいカードが始まります。');
        if (rewards) lines.push(`特典のクーポン${rewards}が届きました。下の「使えるクーポン」からご利用ください。`);
        banner('ok', 'スタンプが1個付きました', lines.join(' '));
    } else if (STAMP_MESSAGES[stamp.status]) {
        banner(...STAMP_MESSAGES[stamp.status]);
    }
}

$('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btnJoin'), msg = $('joinMsg');
    if (btn.disabled) return;
    const name = $('joinName').value.trim(), phone = $('joinPhone').value.trim();
    msg.textContent = '';
    if (!name) { msg.textContent = JOIN_ERRORS.invalid_name; $('joinName').focus(); return; }
    if (phone.replace(/[^0-90-9]/g, '').length < 10) { msg.textContent = JOIN_ERRORS.invalid_phone; $('joinPhone').focus(); return; }
    if (!$('joinConsent').checked) { msg.textContent = JOIN_ERRORS.consent_required; return; }
    btn.disabled = true; btn.textContent = '登録しています…';
    const res = await walletApi({ action: 'join', card_key: cardKey, name, phone, consent: true, qr: stampQr || undefined });
    btn.disabled = false; btn.textContent = '登録してカードを表示';
    if (!res.ok || !res.view) {
        if (res.status === 'phone_exists') $('alreadyBox').open = true;   // 登録済みの方への案内を開いて見せる
        msg.textContent = JOIN_ERRORS[res.status] || (res.reason === 'database_not_ready' ? 'ただいま登録を受け付けられません。お手数ですが、スタッフにお声がけください。' : NETWORK_ERROR);
        return;
    }
    $('banner').hidden = true;
    render(res.view);
    if (res.stamp && res.stamp.status === 'stamped') showStampResult(res.stamp);
    else banner('ok', res.status === 'already_member' ? 'すでに登録されています' : '登録が完了しました', res.status === 'already_member' ? '' : 'この画面が会員証です。次回からは、お店のQRコードを読み取ると表示されます。');
    window.scrollTo(0, 0);
});

async function init() {
    // 店頭で再発行してもらったとき
    if (reissueCode) {
        const res = await walletApi({ action: 'restore', code: reissueCode });
        if (res.ok && res.view) {
            render(res.view);
            banner('ok', 'このスマートフォンで、会員証を使えるようになりました', 'これまでのスタンプとクーポンは、そのまま引き継がれています。');
            return;
        }
        if (res.status === 'code_invalid') {
            banner('warn', 'この再発行用のQRコードは使えません', '15分をすぎたか、すでに使われています。お手数ですが、スタッフにもう一度お声がけください。');
            if (!cardKey) { showError('会員証を表示できません', 'スタッフに、再発行用のQRコードをもう一度出してもらってください。'); return; }
        } else if (!cardKey) { showError('会員証を表示できません', NETWORK_ERROR); return; }
    }
    // スタンプ用QRコードを読み取ったとき
    if (stampQr && !reissueCode) {
        const res = await walletApi({ action: 'stamp', qr: stampQr });
        if (!res.ok) { showError('スタンプを付けられませんでした', NETWORK_ERROR); return; }
        const status = res.stamp?.status;
        if (res.view && res.view.ok !== false) {
            render(res.view);
            if (status === 'need_join') banner('info', 'スタンプをためるには、ショップカードの登録が必要です', '登録すると、このあとスタンプが1個付きます。');
            else showStampResult(res.stamp);
            return;
        }
        const m = STAMP_MESSAGES[status] || STAMP_MESSAGES.qr_invalid;
        showError(m[1], m[2] || 'お手数ですが、スタッフにお声がけください。');
        return;
    }
    // 会員証を開いたとき
    if (!cardKey) { showError('会員証を表示できません', 'お店のQRコードを、もう一度読み取ってください。'); return; }
    const view = await walletApi({ action: 'view', card_key: cardKey, member_key: memberKeyInUrl || undefined });
    if (view.reason === 'network' || view.reason === 'database_not_ready') { showError('会員証を表示できません', NETWORK_ERROR); return; }
    render(view);
}

init();
