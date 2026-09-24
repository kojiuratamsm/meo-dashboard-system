// neo-guide.js
// 「GoogleクチコミURLの取得手順」を、イメージ図つきで表示する
// 手順は Google ビジネスプロフィール ヘルプ「リンクまたは QR コードを作成してクチコミをリクエストする」
// (https://support.google.com/business/answer/16816815)に沿っている。
// 図は画面の構成を簡略化したイメージで、実際の Google の画面とは見た目が異なる。

import { el } from './survey-lib.js';

export const GUIDE_CSS = `
.url-guide { margin-top: 12px; }
.url-guide > summary { cursor: pointer; font-weight: 700; font-size: 13px; color: #2B3674; padding: 10px 14px; background: #F8FAFC; border-radius: 10px; list-style: none; }
.url-guide > summary::-webkit-details-marker { display: none; }
.url-guide > summary::before { content: '▶'; display: inline-block; margin-right: 8px; font-size: 10px; transition: transform .15s; }
.url-guide[open] > summary::before { transform: rotate(90deg); }
.url-guide-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 14px; margin-top: 14px; }
.url-guide-step { border: 1px solid #E2E8F0; border-radius: 14px; overflow: hidden; background: #fff; }
.url-guide-step svg { display: block; width: 100%; height: auto; background: #F4F7FE; }
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
const arrow = (x, y) => `<path d="M${x} ${y} l14 -10 v6 h14 v8 h-14 v6 z" fill="${HL}"/>`;

const STEP_IMAGES = [
    // 1. Googleで店舗名を検索 → 管理パネル
    frame(`${browser('google.com で「お店の名前」を検索')}
      <text x="24" y="54" font-size="9" fill="#4A5568">あなたのビジネス</text>
      <text x="24" y="70" font-size="13" font-weight="700" fill="#2D3748">〇〇店</text>
      <g font-size="9" fill="#2D3748">
        <rect x="24" y="84" width="84" height="26" rx="13" fill="#EDF2F7"/><text x="42" y="100">プロフィール</text>
        <rect x="116" y="84" width="84" height="26" rx="13" fill="#FFF5F5" stroke="${HL}" stroke-width="2.5"/><text x="129" y="100" font-weight="700">クチコミを読む</text>
        <rect x="208" y="84" width="84" height="26" rx="13" fill="#EDF2F7"/><text x="236" y="100">写真</text>
      </g>
      <rect x="24" y="124" width="268" height="8" rx="4" fill="#EDF2F7"/>
      <rect x="24" y="140" width="200" height="8" rx="4" fill="#EDF2F7"/>
      <rect x="24" y="156" width="230" height="8" rx="4" fill="#EDF2F7"/>
      ${arrow(210, 118)}`),
    // 2. クチコミを増やす
    frame(`${browser('クチコミの一覧')}
      <text x="24" y="58" font-size="12" font-weight="700" fill="#2D3748">クチコミ</text>
      <rect x="186" y="44" width="110" height="24" rx="12" fill="#FFF5F5" stroke="${HL}" stroke-width="2.5"/>
      <text x="200" y="60" font-size="9.5" font-weight="700" fill="#2D3748">クチコミを増やす</text>
      <g fill="#EDF2F7">
        <circle cx="34" cy="92" r="9"/><rect x="50" y="86" width="120" height="7" rx="3.5"/><rect x="50" y="98" width="200" height="6" rx="3"/>
        <circle cx="34" cy="130" r="9"/><rect x="50" y="124" width="100" height="7" rx="3.5"/><rect x="50" y="136" width="220" height="6" rx="3"/>
      </g>
      <text x="50" y="164" font-size="9" fill="#ECC94B">★★★★★</text>
      ${arrow(262, 80)}`),
    // 3. リンクをコピー
    frame(`<rect x="10" y="10" width="300" height="170" rx="10" fill="#A0AEC0" opacity="0.35"/>
      <rect x="36" y="28" width="248" height="134" rx="12" fill="#fff" stroke="#CBD5E0"/>
      <text x="52" y="52" font-size="12" font-weight="700" fill="#2D3748">クチコミを増やす</text>
      <text x="52" y="70" font-size="8.5" fill="#718096">このリンクをお客様と共有しましょう</text>
      <rect x="52" y="82" width="176" height="28" rx="6" fill="#F7FAFC" stroke="#CBD5E0"/>
      <text x="60" y="100" font-size="9" fill="#2D3748">https://g.page/r/XXXX/review</text>
      <rect x="236" y="82" width="32" height="28" rx="6" fill="#FFF5F5" stroke="${HL}" stroke-width="2.5"/>
      <rect x="245" y="89" width="11" height="13" rx="2" fill="none" stroke="#2D3748" stroke-width="1.5"/>
      <rect x="249" y="92" width="11" height="13" rx="2" fill="#fff" stroke="#2D3748" stroke-width="1.5"/>
      <text x="228" y="128" font-size="9" font-weight="700" fill="${HL}">コピー</text>
      <rect x="52" y="136" width="60" height="16" rx="3" fill="#EDF2F7"/><text x="62" y="147" font-size="8" fill="#718096">QRコード</text>`),
    // 4. MapOn NEO に貼り付けて確認
    frame(`${browser('MapOn NEO の管理画面')}
      <text x="24" y="58" font-size="10.5" font-weight="700" fill="#2B3674">GoogleクチコミURL(公開の条件)</text>
      <rect x="24" y="70" width="186" height="30" rx="8" fill="#fff" stroke="#4285F4" stroke-width="2"/>
      <text x="32" y="89" font-size="9" fill="#2D3748">https://g.page/r/XXXX/review</text>
      <rect x="218" y="70" width="78" height="30" rx="8" fill="#FFF5F5" stroke="${HL}" stroke-width="2.5"/>
      <text x="232" y="89" font-size="9.5" font-weight="700" fill="#2D3748">リンクを確認</text>
      <text x="24" y="120" font-size="9" fill="#1E7E34">✓ 正しい形式です</text>
      <text x="24" y="146" font-size="9" fill="#4A5568">① 貼り付け(⌘+V / Ctrl+V)</text>
      <text x="24" y="162" font-size="9" fill="#4A5568">② お店のクチコミ画面が開けば完了</text>`),
];

const STEP_TEXTS = [
    ['Googleで、お店の名前を検索します(お店の管理者のGoogleアカウントでログインした状態で)。表示された管理画面の', '「クチコミを読む」', 'を押します。'],
    ['クチコミの一覧が開いたら、', '「クチコミを増やす」', 'を押します。'],
    ['クチコミ用のリンクが表示されます。横の', 'コピーのマーク', 'を押して、リンクをコピーします。'],
    ['この画面に戻り、上の入力欄に貼り付けます。', '「リンクを確認」', 'を押して、お店のクチコミ画面が開けば完了です。'],
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
            ...STEP_IMAGES.map((img, i) => {
                const [a, b, c] = STEP_TEXTS[i];
                return el('div', { class: 'url-guide-step' },
                    svgNode(img),
                    el('div', { class: 'cap' }, el('span', { class: 'num', text: String(i + 1) }), a, el('b', { text: b }), c));
            })),
        el('p', { class: 'url-guide-note', text: '※図は画面のイメージです。Google側の画面の表記や配置は変わることがあります。「クチコミを増やす」は、パソコンのブラウザで操作するのが確実です。ビジネスプロフィールは business.google.com からも開けます。' }));
}
