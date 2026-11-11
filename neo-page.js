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

// 申し込みフォームでは店舗名を聞かないため、登録直後の店舗名はこの仮の名前になっている(DBのトリガーが設定する)
const NAME_PENDING = '(店舗名未入力)';
const isNamePending = (c) => !c.company_name || !String(c.company_name).trim() || c.company_name === NAME_PENDING;

// 初回ログイン:店舗名を入力してもらう。保存できたら、その名前を返す。
function askStoreName(client) {
    return new Promise((resolve) => {
        const navs = document.querySelectorAll('.sidebar .nav-item[data-view]');
        navs.forEach(a => { a.style.pointerEvents = 'none'; a.style.opacity = '0.4'; });
        const input = el('input', { class: 'input', id: 'firstStoreName', maxlength: '100', placeholder: '例: 焼肉 新宿本店', autocomplete: 'organization' });
        const msg = el('p', { class: 'msg ng', role: 'alert' });
        const btn = el('button', { class: 'btn', type: 'button' }, '保存して始める');
        const save = async () => {
            const name = input.value.trim();
            if (!name) { msg.textContent = '店舗名を入力してください。'; input.focus(); return; }
            if (name === NAME_PENDING) { msg.textContent = '別の名前を入力してください。'; input.focus(); return; }
            btn.disabled = true; msg.textContent = '';
            const { data, error } = await supabase.rpc('neo_update_store_name', { p_client_id: String(client.id), p_name: name });
            btn.disabled = false;
            if (error) {
                const m = String(error.message || '');
                msg.textContent = m.includes('Could not find') || m.includes('does not exist')
                    ? '保存できませんでした(データベースの設定が必要です)。担当者にご連絡ください。'
                    : m.includes('name_too_long') ? '店舗名は100文字以内で入力してください。'
                    : '保存できませんでした。時間をおいて、もう一度お試しください。';
                return;
            }
            navs.forEach(a => { a.style.pointerEvents = ''; a.style.opacity = ''; });
            resolve(data || name);
        };
        btn.addEventListener('click', save);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); } });
        $('app').replaceChildren(el('div', { class: 'card', id: 'firstSetup', style: { maxWidth: '560px', margin: '40px auto' } },
            el('h2', { text: 'はじめに、店舗名を入力してください' }),
            el('p', { class: 'muted', style: { lineHeight: '1.8', marginBottom: '16px' },
                text: 'お客様のアンケートやクーポンの画面に表示される名前です。あとから「設定」で変更できます。' }),
            el('div', { class: 'field' }, el('label', { for: 'firstStoreName', text: '店舗名' }), input),
            msg,
            el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } }, btn)));
        input.focus();
    });
}

// 店舗の情報を読み込む。Google口コミURLの列は「追加SQL_8」で追加されるため、
// まだ実行されていない場合は、URLなしで読み込む(ログインできなくならないようにする)。
async function loadClient(filter) {
    const base = 'id, company_name, email, plan';
    const full = await filter(supabase.from('clients').select(base + ', google_review_url')).maybeSingle();
    if (!full.error) return full;
    return await filter(supabase.from('clients').select(base)).maybeSingle();
}

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
        const { data, error } = await loadClient((q) => q.eq('id', requestedId));
        if (error || !data) { showMessage('契約者が見つかりません。マスター画面の「MapOn NEO」から開き直してください。'); return; }
        client = data;
        const banner = $('masterBanner');
        banner.hidden = false;
        banner.replaceChildren(
            el('span', {}, el('i', { class: 'fa-solid fa-user-shield' }), ' マスターとして「', el('span', { id: 'bannerStoreName', text: client.company_name }), '」様の管理画面を表示しています'),
            el('a', { href: '/master-surveys', class: 'btn small dark' }, '契約者一覧に戻る'));
    } else {
        // 契約者本人:自分の店舗
        const { data, error } = await loadClient((q) => q.eq('auth_id', session.user.id));
        if (error || !data) { showMessage('アカウントは確認できましたが、店舗情報が登録されていません。お手数ですが、担当者にお問い合わせください。'); return; }
        client = data;
    }

    const showStoreName = (name) => {
        $('storeName').textContent = name === NAME_PENDING ? '店舗名 未設定' : `${name} 様`;
        const b = document.getElementById('bannerStoreName');
        if (b) b.textContent = name;
        document.title = `MapOn NEO 管理画面 - ${name}`;
    };
    showStoreName(client.company_name || NAME_PENDING);
    document.documentElement.classList.remove('auth-pending');
    // 契約者本人の初回ログイン:店舗名が未入力なら、先に入力してもらう(マスター表示では聞かない)
    if (!isStaff && isNamePending(client)) {
        client.company_name = await askStoreName(client);
        showStoreName(client.company_name);
    }
    startNeoApp({ root: $('app'), client, isMasterView: isStaff, onStoreNameChange: showStoreName });
})();
