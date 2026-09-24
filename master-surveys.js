// master-surveys.js
// マスター管理画面「MapOn NEO」:契約者(申し込みフォームから登録した人)の一覧
// 「管理画面に入る」で、その契約者の MapOn NEO 管理画面(neo.html)をマスターとして開く。

import { supabase } from './supabase-config.js';
import { requireStaff, staffLogout } from './staff-guard.js';
import { el } from './survey-lib.js';

const NEO_PLAN = 'D';
const app = document.getElementById('app');
document.getElementById('logoutLink').addEventListener('click', (e) => { e.preventDefault(); staffLogout(); });

function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso); const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())}`;
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

function urlCard() {
    return el('div', { class: 'card' },
        el('h2', { text: '契約者に送るURL' }),
        urlRow('申し込みフォーム', '/signup-neo', '運用代行の契約者に送ってください。名前・メールアドレス・パスワードを入力すると、MapOn NEO の管理画面が発行されます。'),
        urlRow('ログインページ', '/login', '申し込み後は、このページから登録したメールアドレスとパスワードでログインすると、MapOn NEO の管理画面が開きます。'));
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

async function render() {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    const [clientsRes, surveysRes, statsRes, settingRes] = await Promise.all([
        supabase.from('clients').select('id, company_name, email, created_at, auth_id').eq('plan', NEO_PLAN).order('created_at', { ascending: false }),
        supabase.from('neo_surveys').select('id, client_id').is('deleted_at', null),
        supabase.from('neo_survey_stats').select('survey_id, response_count'),
        supabase.from('neo_settings').select('value').eq('key', 'question_guide_url').maybeSingle(),
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

    const search = el('input', { class: 'input', placeholder: '名前・メールアドレスで検索', style: { maxWidth: '320px' } });
    const tbody = el('tbody');
    const draw = () => {
        const q = search.value.trim().toLowerCase();
        const list = clients.filter(c => !q || `${c.company_name} ${c.email}`.toLowerCase().includes(q));
        if (!list.length) {
            tbody.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'muted', style: { textAlign: 'center', padding: '30px', lineHeight: '1.8' },
                text: clients.length ? '該当する契約者がいません。' : 'まだ登録した契約者がいません。上の「申し込みフォーム」のURLを、契約者に送ってください。' })));
            return;
        }
        tbody.replaceChildren(...list.map(c => {
            const stat = perClient[String(c.id)] || { surveys: 0, responses: 0 };
            return el('tr', {},
                el('td', { style: { fontWeight: '700' }, text: c.company_name }),
                el('td', { text: c.email || '-' }),
                el('td', { class: 'muted', text: fmtDate(c.created_at) }),
                el('td', { text: `${stat.surveys}件` }),
                el('td', { text: `${stat.responses}件` }),
                el('td', {}, el('a', { href: `/neo?client=${encodeURIComponent(c.id)}`, class: 'btn small' },
                    el('i', { class: 'fa-solid fa-right-to-bracket' }), '管理画面に入る')));
        }));
    };
    search.addEventListener('input', draw);

    app.replaceChildren(
        el('div', { class: 'page-title' }, 'MapOn NEO'),
        urlCard(),
        settingRes.error
            ? el('div', { class: 'card' }, el('h2', { text: '設問の書き方ガイドのURL' }),
                el('p', { class: 'muted', text: 'この欄を使うには、Supabase で「追加SQL_3_設問ガイドURL.sql」を実行してください。' }))
            : guideUrlCard(settingRes.data?.value),
        el('div', { class: 'card' },
            el('h2', { text: `契約者一覧(${clients.length}件)` }),
            el('div', { class: 'row', style: { marginBottom: '14px' } }, search),
            el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
                el('thead', {}, el('tr', {}, ...['名前', 'メールアドレス', '登録日', 'アンケート', '回答', ''].map(h => el('th', { text: h })))),
                tbody))));
    draw();
}

(async () => {
    const session = await requireStaff();
    if (!session) return;
    render();
})();
