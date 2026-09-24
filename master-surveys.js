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

async function copySignupUrl(button) {
    const url = `${location.origin}/signup-neo`;
    try {
        await navigator.clipboard.writeText(url);
        button.textContent = 'コピーしました';
        setTimeout(() => { button.textContent = '申し込みフォームのURLをコピー'; }, 2000);
    } catch {
        prompt('このURLをコピーして送ってください', url);
    }
}

async function render() {
    app.replaceChildren(el('p', { class: 'muted', text: '読み込み中...' }));
    const [clientsRes, surveysRes, statsRes] = await Promise.all([
        supabase.from('clients').select('id, company_name, email, created_at, auth_id').eq('plan', NEO_PLAN).order('created_at', { ascending: false }),
        supabase.from('neo_surveys').select('id, client_id').is('deleted_at', null),
        supabase.from('neo_survey_stats').select('survey_id, response_count'),
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
                text: clients.length ? '該当する契約者がいません。' : 'まだ登録した契約者がいません。「申し込みフォームのURLをコピー」から、契約者にフォームを送ってください。' })));
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

    const copyBtn = el('button', { class: 'btn dark', type: 'button' }, '申し込みフォームのURLをコピー');
    copyBtn.addEventListener('click', () => copySignupUrl(copyBtn));

    app.replaceChildren(
        el('div', { class: 'page-title' }, 'MapOn NEO', el('span', { class: 'muted', text: `契約者一覧(${clients.length}件)` }),
            el('span', { style: { marginLeft: 'auto' } }, copyBtn)),
        el('div', { class: 'card' },
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
