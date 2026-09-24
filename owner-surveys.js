// owner-surveys.js
// クライアント画面「MapOn NEO」(アンケート回答)(店舗オーナー・閲覧専用)
// ・見られるのは自店舗のアンケートと回答だけ(DB側のRLSで制限)
// ・アンケートの作成・編集はMSMが行うため、この画面には編集機能を置かない

import { supabase } from './supabase-config.js';
import { el } from './survey-lib.js';
import { RESULTS_CSS, renderResults, downloadQrPng } from './survey-results.js';

const root = document.getElementById('ownerSurveyApp');

async function init() {
    if (!root) return;
    document.head.append(el('style', { text: RESULTS_CSS }));

    let user = null;
    try { user = JSON.parse(localStorage.getItem('currentUser') || 'null'); } catch { /* 読めない場合は未ログイン扱い */ }
    const { data: { session } } = await supabase.auth.getSession();
    if (!user || !session) {
        root.replaceChildren(el('p', { style: { color: '#A3AED0' }, text: 'ログインするとアンケートの回答を確認できます。' }));
        return;
    }

    const { data: surveys, error } = await supabase
        .from('surveys')
        .select('id, title, questions, public_slug, is_published, created_at')
        .eq('client_id', user.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

    if (error) {
        root.replaceChildren(el('p', { style: { color: '#EA4335' }, text: '読み込みに失敗しました: ' + error.message }));
        return;
    }
    if (!surveys.length) {
        root.replaceChildren(el('p', { style: { color: '#A3AED0', lineHeight: '1.8' }, text: 'まだアンケートがありません。アンケートの作成は、担当のMSMスタッフが行います。' }));
        return;
    }

    const select = el('select', { class: 'form-control', style: { maxWidth: '360px' } },
        ...surveys.map(s => el('option', { value: s.id, text: `${s.title}${s.is_published ? '' : '(受付停止中)'}` })));
    const qrBtn = el('button', { class: 'sr-btn', type: 'button' }, 'QRコード(PNG)をダウンロード');
    const area = el('div', { style: { marginTop: '16px' } });

    const current = () => surveys.find(s => s.id === select.value);
    qrBtn.addEventListener('click', () => downloadQrPng(current(), user.company_name || ''));
    select.addEventListener('change', () => renderResults(area, { supabase, survey: current() }));

    root.replaceChildren(
        el('div', { class: 'sr-toolbar' },
            el('label', {}, 'アンケート', select),
            qrBtn),
        area);
    renderResults(area, { supabase, survey: current() });
}

init();
