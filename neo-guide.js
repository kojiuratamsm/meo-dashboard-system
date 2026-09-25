// neo-guide.js
// 「GoogleクチコミURLの取得手順」を、イメージ図つきで表示する
// 手順は Google ビジネスプロフィール ヘルプ「リンクまたは QR コードを作成してクチコミをリクエストする」
// (https://support.google.com/business/answer/16816815)に沿っている。
// 手順1・2は実際の Google の画面(店舗名・ロゴ・数値・URL・QRコードは差し替え済み)。画像は public/guide/ にある。

import { el } from './survey-lib.js';

export const GUIDE_CSS = `
.url-guide { margin-top: 12px; }
.url-guide > summary { cursor: pointer; font-weight: 700; font-size: 13px; color: #2B3674; padding: 10px 14px; background: #F8FAFC; border-radius: 10px; list-style: none; }
.url-guide > summary::-webkit-details-marker { display: none; }
.url-guide > summary::before { content: '▶'; display: inline-block; margin-right: 8px; font-size: 10px; transition: transform .15s; }
.url-guide[open] > summary::before { transform: rotate(90deg); }
.url-guide-steps { display: grid; grid-template-columns: 1fr; gap: 16px; margin-top: 14px; max-width: 760px; }
.url-guide-step { border: 1px solid #E2E8F0; border-radius: 14px; overflow: hidden; background: #fff; }
.url-guide-step svg, .url-guide-step img { display: block; width: 100%; height: auto; background: #F4F7FE; }
.url-guide-step img { background: #fff; border-bottom: 1px solid #E2E8F0; }
.url-guide-step svg { max-width: 460px; margin: 0 auto; }
.url-guide-step .cap { padding: 12px 14px; font-size: 13px; line-height: 1.7; color: #2D3748; }
.url-guide-step .num { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: #4285F4; color: #fff; font-size: 12px; font-weight: 700; margin-right: 6px; }
.url-guide-note { font-size: 12px; color: #718096; margin-top: 10px; line-height: 1.7; }
`;

// 図の共通部品(強調の赤い枠と、指さしの矢印)
const HL = '#E53E3E';
const FONT = `font-family="'Noto Sans JP', sans-serif"`;
const frame = (inner) => `<svg viewBox="0 0 320 190" xmlns="http://www.w3.org/2000/svg" role="img" ${FONT}>${inner}</svg>`;
const browser = (addr) => `
  <rect x="10" y="10" width="300" height="170" rx="10" fill="#fff" stroke="#CBD5E0"/>
  <rect x="10" y="10" width="300" height="26" rx="10" fill="#EDF2F7"/>
  <rect x="10" y="26" width="300" height="10" fill="#EDF2F7"/>
  <circle cx="24" cy="23" r="4" fill="#FC8181"/><circle cx="36" cy="23" r="4" fill="#F6E05E"/><circle cx="48" cy="23" r="4" fill="#68D391"/>
  <rect x="62" y="16" width="236" height="14" rx="7" fill="#fff"/>
  <text x="72" y="26.5" font-size="8.5" fill="#718096">${addr}</text>`;
// 1・2 は実際の Google の画面(店舗名・ロゴ・数値・URL・QRは差し替え済み)、3 は MapOn NEO の画面のイメージ
const STEPS = [
    {
        img: '/guide/gbp-step1.png', alt: 'Googleの管理画面。「レビューを依頼」ボタンが赤枠で囲まれている',
        text: ['Googleで、お店の名前を検索します(お店の管理者のGoogleアカウントでログインした状態で)。表示された管理画面の', '「レビューを依頼」', 'を押します(表示は「レビューを…」「クチコミを増やす」のこともあります)。'],
    },
    {
        img: '/guide/gbp-step2.png', alt: '「クチコミを増やす」画面。クチコミのリンクが赤枠で囲まれている',
        text: ['「クチコミを増やす」画面が開きます。赤枠の', '「クチコミのリンク」', 'の右端にあるコピーのマークを押して、リンクをコピーします。'],
    },
    {
        svg: frame(`${browser('MapOn NEO の管理画面')}
      <text x="24" y="58" font-size="10.5" font-weight="700" fill="#2B3674">GoogleクチコミURL(公開の条件)</text>
      <rect x="24" y="70" width="186" height="30" rx="8" fill="#fff" stroke="#4285F4" stroke-width="2"/>
      <text x="32" y="89" font-size="9" fill="#2D3748">https://g.page/r/XXXX/review</text>
      <rect x="218" y="70" width="78" height="30" rx="8" fill="#FFF5F5" stroke="${HL}" stroke-width="2.5"/>
      <text x="232" y="89" font-size="9.5" font-weight="700" fill="#2D3748">リンクを確認</text>
      <text x="24" y="120" font-size="9" fill="#1E7E34">✓ 正しい形式です</text>
      <text x="24" y="146" font-size="9" fill="#4A5568">① 貼り付け(⌘+V / Ctrl+V)</text>
      <text x="24" y="162" font-size="9" fill="#4A5568">② お店のクチコミ画面が開けば完了</text>`),
        text: ['この画面に戻り、上の入力欄に貼り付けます。', '「リンクを確認」', 'を押して、お店のクチコミ画面が開けば完了です。'],
    },
];

function svgNode(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();   // 固定の図だけを入れる(利用者の入力は入らない)
    return t.content.firstElementChild;
}

export function reviewUrlGuide() {
    return el('details', { class: 'url-guide' },
        el('summary', { text: 'URLの取得手順(画像で見る)' }),
        el('div', { class: 'url-guide-steps' },
            ...STEPS.map((step, i) => {
                const [a, b, c] = step.text;
                const visual = step.img
                    ? el('a', { href: step.img, target: '_blank', rel: 'noopener', title: 'クリックで拡大' },
                        el('img', { src: step.img, alt: step.alt, loading: 'lazy' }))
                    : svgNode(step.svg);
                return el('div', { class: 'url-guide-step' },
                    visual,
                    el('div', { class: 'cap' }, el('span', { class: 'num', text: String(i + 1) }), a, el('b', { text: b }), c));
            })),
        el('p', { class: 'url-guide-note', text: '※Google側の画面の表記や配置は変わることがあります。この操作はパソコンのブラウザで行うのが確実です。ビジネスプロフィールは business.google.com からも開けます。画像はクリックすると拡大できます。' }));
}
