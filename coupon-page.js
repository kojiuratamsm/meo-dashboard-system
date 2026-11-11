// coupon-page.js
// お客様のクーポン画面(coupon.html?t=<クーポンごとの長い合い言葉>)。
// ・URLを知っている人だけが表示できる(会員登録なし)
// ・「クーポンを使う」→ 確認 →「利用済みにする」で、利用済みになる(スタッフの前で、お客様が自分で押す)
// ・利用済みにできるのは1回だけ(DBの関数 neo_use_coupon が判定する)

import { supabase } from './supabase-config.js';
import { couponHeadline, couponTerms, formatDateJa } from './coupon-lib.js';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t') || '';

function showNotFound() { $('loading').hidden = true; $('coupon').hidden = true; $('notFound').hidden = false; }

function formatDateTimeJa(iso) {
    const t = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
    return `${formatDateJa(iso)} ${t}`;
}

function render(data) {
    const c = data.coupon || {};
    document.title = `${couponHeadline(c)} クーポン - ${data.store_name || ''}`;
    $('storeName').textContent = data.store_name || '';
    $('headline').textContent = couponHeadline(c);
    $('name').textContent = c.name || '';
    $('desc').textContent = c.description || ''; $('desc').hidden = !String(c.description || '').trim();
    // 期限は「この時刻より前まで使える」。日付の表示は、その直前の日にする(例:1月1日0時まで → 12月31日まで)
    const lastDay = formatDateJa(new Date(new Date(data.expires_at).getTime() - 1000).toISOString());
    const items = [`有効期限:${lastDay}まで`, ...couponTerms(c)];
    $('terms').replaceChildren(...items.map(text => Object.assign(document.createElement('li'), { textContent: text })));
    $('code').textContent = data.code || '';
    const status = data.status;
    const badge = $('status');
    badge.className = `badge ${status}`;
    badge.textContent = status === 'used' ? '利用済み' : status === 'expired' ? '期限切れ' : '未使用';
    $('unusedArea').hidden = status !== 'unused';
    $('usedArea').hidden = status === 'unused';
    if (status === 'used') {
        $('title').textContent = 'このクーポンは利用済みです';
        $('usedTitle').textContent = '利用済み';
        $('usedNote').textContent = data.used_at ? `${formatDateTimeJa(data.used_at)} に利用` : '';
    } else if (status === 'expired') {
        $('title').textContent = 'このクーポンは期限が切れています';
        $('usedTitle').textContent = '期限切れ';
        $('usedNote').textContent = `有効期限は ${lastDay} まででした`;
    } else {
        $('title').textContent = 'クーポンを受け取りました';
    }
    $('loading').hidden = true; $('notFound').hidden = true; $('coupon').hidden = false;
}

async function load() {
    if (token.length < 32) { showNotFound(); return null; }
    let data = null;
    try { ({ data } = await supabase.rpc('neo_get_coupon', { p_token: token })); } catch { data = null; }
    if (!data) { showNotFound(); return null; }
    render(data);
    return data;
}

$('btnUse').addEventListener('click', () => { $('confirmBox').hidden = false; $('btnUse').hidden = true; $('useMsg').textContent = ''; $('confirmBox').scrollIntoView({ block: 'center' }); });
$('btnCancel').addEventListener('click', () => { $('confirmBox').hidden = true; $('btnUse').hidden = false; });
$('btnConfirm').addEventListener('click', async () => {
    const btn = $('btnConfirm');
    if (btn.disabled) return;
    btn.disabled = true; $('btnCancel').disabled = true;
    let error = null;
    try { ({ error } = await supabase.rpc('neo_use_coupon', { p_token: token })); } catch (e) { error = e; }
    btn.disabled = false; $('btnCancel').disabled = false;
    const m = String(error?.message || '');
    if (error && !m.includes('already_used') && !m.includes('coupon_expired')) {
        $('useMsg').textContent = '通信できませんでした。電波の良い場所で、もう一度お試しください。';
        return;
    }
    // 成功したとき・すでに利用済みだったとき・期限切れだったときは、最新の状態を表示し直す
    $('confirmBox').hidden = true; $('btnUse').hidden = false;
    await load();
});
$('btnCopyUrl').addEventListener('click', async () => {
    const btn = $('btnCopyUrl');
    try { await navigator.clipboard.writeText(location.href); btn.textContent = 'コピーしました'; }
    catch { btn.textContent = 'コピーできませんでした。URLの欄を長押ししてコピーしてください'; }
    setTimeout(() => { btn.textContent = 'このページのURLをコピー'; }, 2500);
});

load();
