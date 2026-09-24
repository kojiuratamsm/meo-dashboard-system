// neo-page.js
// MapOn NEO 管理画面(neo.html)の入口
// ・契約者本人:ログインすると、自分の店舗のアンケート管理画面が開く
// ・マスター(MSMスタッフ):neo.html?client=<店舗ID> で、どの契約者の画面にも入れる
// 見られるデータの範囲は、DB側の権限(RLS)で制限されている。

import { supabase } from './supabase-config.js';
import { el } from './survey-lib.js';
import { startNeoApp } from './neo-app.js';

const $ = (id) => document.getElementById(id);

// ログアウト後に「戻る」で前の画面が見えないようにする
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

function showMessage(text) {
    document.documentElement.classList.remove('auth-pending');
    $('app').replaceChildren(el('div', { class: 'card' }, el('p', { text, style: { lineHeight: '1.8' } })));
}

(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { location.replace('/login'); return; }

    const { data: isStaffData } = await supabase.rpc('is_msm_staff');
    const isStaff = isStaffData === true;

    $('logoutLink').addEventListener('click', async (e) => {
        e.preventDefault();
        await supabase.auth.signOut().catch(() => {});
        localStorage.removeItem('currentUser');
        localStorage.removeItem('masterAdmin');
        location.href = isStaff ? '/master-login' : '/login';
    });

    const requestedId = new URLSearchParams(location.search).get('client');
    let client = null;

    if (isStaff) {
        // マスター:指定された契約者の画面を開く
        if (!requestedId) { location.replace('/master-surveys'); return; }
        const { data, error } = await supabase.from('clients').select('id, company_name, email, plan').eq('id', requestedId).maybeSingle();
        if (error || !data) { showMessage('契約者が見つかりません。マスター画面の「MapOn NEO」から開き直してください。'); return; }
        client = data;
        const banner = $('masterBanner');
        banner.hidden = false;
        banner.replaceChildren(
            el('span', {}, el('i', { class: 'fa-solid fa-user-shield' }), ` マスターとして「${client.company_name}」様の管理画面を表示しています`),
            el('a', { href: '/master-surveys', class: 'btn small dark' }, '契約者一覧に戻る'));
    } else {
        // 契約者本人:自分の店舗
        const { data, error } = await supabase.from('clients').select('id, company_name, email, plan').eq('auth_id', session.user.id).maybeSingle();
        if (error || !data) { showMessage('アカウントは確認できましたが、店舗情報が登録されていません。お手数ですが、担当者にお問い合わせください。'); return; }
        client = data;
    }

    $('storeName').textContent = `${client.company_name} 様`;
    document.title = `MapOn NEO 管理画面 - ${client.company_name}`;
    document.documentElement.classList.remove('auth-pending');
    startNeoApp({ root: $('app'), client });
})();
