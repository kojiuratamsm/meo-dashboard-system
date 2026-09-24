// survey-results.js
// アンケートの回答一覧・集計・CSV・QRコード(MSMスタッフ画面と店舗オーナー画面で共用)

import QRCode from 'qrcode';
import { CHOICE_TYPES, REVIEW_ACTION_LABEL, el, formatAnswer, surveyPublicUrl } from './survey-lib.js';

export const RESULTS_CSS = `
.sr-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin-bottom: 16px; }
.sr-toolbar label { font-size: 12px; color: #4A5568; font-weight: 700; display: flex; flex-direction: column; gap: 4px; }
.sr-toolbar input { padding: 8px 10px; border: 1px solid #E2E8F0; border-radius: 8px; font-size: 14px; }
.sr-btn { background: #4285F4; color: #fff; border: none; border-radius: 8px; padding: 9px 14px; font-weight: 700; font-size: 13px; cursor: pointer; }
.sr-btn.sub { background: #EDF2F7; color: #2D3748; }
.sr-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-bottom: 18px; }
.sr-card { background: #F8FAFC; border-radius: 14px; padding: 16px; }
.sr-card h4 { font-size: 13px; color: #4A5568; margin-bottom: 10px; }
.sr-big { font-size: 28px; font-weight: 800; color: #2B3674; }
.sr-bar-row { display: grid; grid-template-columns: minmax(70px, 38%) 1fr 64px; gap: 8px; align-items: center; font-size: 12px; margin-bottom: 6px; }
.sr-bar-row span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-bar { background: #E2E8F0; border-radius: 4px; height: 10px; overflow: hidden; }
.sr-bar i { display: block; height: 100%; background: #4285F4; }
.sr-table-wrap { overflow-x: auto; border: 1px solid #E2E8F0; border-radius: 12px; }
.sr-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.sr-table th, .sr-table td { padding: 10px 12px; border-bottom: 1px solid #EDF2F7; text-align: left; vertical-align: top; }
.sr-table th { background: #F8FAFC; color: #4A5568; white-space: nowrap; position: sticky; top: 0; }
.sr-table td { max-width: 320px; white-space: pre-wrap; word-break: break-word; }
.sr-empty { padding: 30px; text-align: center; color: #A0AEC0; }
`;

const MAX_ROWS = 2000;

function toDateInput(d) {
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function fmtDateTime(iso) {
    const d = new Date(iso);
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

/** 回答一覧と集計を描画する */
export async function renderResults(container, { supabase, survey }) {
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 30);
    const fromInput = el('input', { type: 'date', value: toDateInput(from) });
    const toInput = el('input', { type: 'date', value: toDateInput(today) });
    const summary = el('div');
    const tableArea = el('div');
    let rows = [];

    const csvBtn = el('button', { class: 'sr-btn sub', type: 'button', onclick: () => downloadCsv(survey, rows) }, 'CSVダウンロード');
    const reloadBtn = el('button', { class: 'sr-btn', type: 'button', onclick: load }, '表示');
    container.replaceChildren(
        el('div', { class: 'sr-toolbar' },
            el('label', {}, '開始日', fromInput),
            el('label', {}, '終了日', toInput),
            reloadBtn, csvBtn),
        summary, tableArea);

    async function load() {
        reloadBtn.disabled = true;
        tableArea.replaceChildren(el('p', { class: 'sr-empty', text: '読み込み中...' }));
        const start = new Date(fromInput.value + 'T00:00:00');
        const end = new Date(toInput.value + 'T00:00:00'); end.setDate(end.getDate() + 1);
        const { data, error } = await supabase
            .from('neo_survey_responses')
            .select('id, submitted_at, answers, star_rating, review_action, review_action_at')
            .eq('survey_id', survey.id)
            .gte('submitted_at', start.toISOString())
            .lt('submitted_at', end.toISOString())
            .order('submitted_at', { ascending: false })
            .limit(MAX_ROWS);
        reloadBtn.disabled = false;
        if (error) {
            tableArea.replaceChildren(el('p', { class: 'sr-empty', text: '読み込みに失敗しました: ' + error.message }));
            return;
        }
        rows = data || [];
        renderSummary();
        renderTable();
    }

    function renderSummary() {
        const stars = rows.map(r => r.star_rating).filter(Boolean);
        const avg = stars.length ? (stars.reduce((a, b) => a + b, 0) / stars.length).toFixed(2) : '-';
        const dist = [5, 4, 3, 2, 1].map(n => [n, stars.filter(s => s === n).length]);
        const acted = rows.filter(r => r.review_action === 'copied_and_opened' || r.review_action === 'copy_failed_opened' || r.review_action === 'self_write').length;

        const cards = [
            el('div', { class: 'sr-card' }, el('h4', { text: '回答数' }), el('div', { class: 'sr-big', text: `${rows.length}件` }),
                el('p', { style: { fontSize: '12px', color: '#718096', marginTop: '6px' }, text: `Googleのクチコミ画面を開いた人:${acted}人` })),
            el('div', { class: 'sr-card' }, el('h4', { text: `星の平均 ${avg}(${stars.length}件)` }),
                ...dist.map(([n, c]) => barRow('★'.repeat(n), c, stars.length))),
        ];
        // 選択式の設問ごとの集計(どの選択肢が選ばれているか)
        for (const q of survey.questions.filter(q => CHOICE_TYPES.has(q.type))) {
            const answered = rows.filter(r => r.answers && r.answers[q.id] != null);
            const counts = new Map((q.options || []).map(o => [o.id, 0]));
            for (const r of answered) {
                const v = r.answers[q.id];
                for (const id of (Array.isArray(v) ? v : [v])) counts.set(id, (counts.get(id) || 0) + 1);
            }
            const byId = Object.fromEntries((q.options || []).map(o => [o.id, o.label]));
            cards.push(el('div', { class: 'sr-card' }, el('h4', { text: `${q.label}(${answered.length}件)` }),
                ...[...counts.entries()].sort((a, b) => b[1] - a[1])
                    .map(([id, c]) => barRow(byId[id] ?? '(削除された選択肢)', c, answered.length))));
        }
        summary.replaceChildren(el('div', { class: 'sr-cards' }, cards));
    }

    function barRow(label, count, total) {
        const pct = total ? Math.round((count / total) * 100) : 0;
        return el('div', { class: 'sr-bar-row' },
            el('span', { text: label, title: label }),
            el('div', { class: 'sr-bar' }, el('i', { style: { width: pct + '%' } })),
            el('span', { text: `${count}件 ${pct}%` }));
    }

    function renderTable() {
        if (!rows.length) {
            tableArea.replaceChildren(el('p', { class: 'sr-empty', text: 'この期間の回答はありません。' }));
            return;
        }
        const head = el('tr', {}, el('th', { text: '日時' }), ...survey.questions.map(q => el('th', { text: q.label })), el('th', { text: '口コミ協力' }));
        const body = rows.map(r => el('tr', {},
            el('td', { text: fmtDateTime(r.submitted_at) }),
            ...survey.questions.map(q => el('td', { text: formatAnswer(q, r.answers?.[q.id]) })),
            el('td', { text: REVIEW_ACTION_LABEL[r.review_action] || '未操作' })));
        const note = rows.length >= MAX_ROWS ? el('p', { style: { fontSize: '12px', color: '#C05621', marginTop: '8px' }, text: `表示は最新${MAX_ROWS}件までです。期間を絞ってください。` }) : null;
        tableArea.replaceChildren(el('div', { class: 'sr-table-wrap' }, el('table', { class: 'sr-table' }, el('thead', {}, head), el('tbody', {}, body))), note);
    }

    await load();
}

function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(survey, rows) {
    const header = ['日時', ...survey.questions.map(q => q.label), '口コミ協力'];
    const lines = [header, ...rows.map(r => [
        fmtDateTime(r.submitted_at),
        ...survey.questions.map(q => {
            const v = r.answers?.[q.id];
            return q.type === 'stars' ? (v ?? '') : formatAnswer(q, v);
        }),
        REVIEW_ACTION_LABEL[r.review_action] || '未操作',
    ])].map(cols => cols.map(csvCell).join(','));
    // 先頭のBOMは、Excelで開いたときの文字化けを防ぐため
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `アンケート回答_${survey.title}_${toDateInput(new Date())}.csv` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** QRコードのcanvasを作る(印刷用に1200px) */
export async function makeQrCanvas(url, size = 1200) {
    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, url, { width: size, margin: 2, errorCorrectionLevel: 'Q' });
    return canvas;
}

export async function downloadQrPng(survey, storeName = '') {
    const canvas = await makeQrCanvas(surveyPublicUrl(survey.public_slug));
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const a = el('a', { href: URL.createObjectURL(blob), download: `アンケートQR_${storeName || ''}${storeName ? '_' : ''}${survey.title}.png` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
