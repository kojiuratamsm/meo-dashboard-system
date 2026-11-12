// rank-lib.js
// ショップカードの「ランク」で、管理画面とお客様の会員証が共用する部品。
// ・ランクは「いっぱいになったカードの枚数」で決まる(1枚いっぱいで2番目のランク)。
// ・いちばん上のランクでは、いっぱいになっても同じランクのまま新しいカードが始まる。
// ・色は、決まった8色から選ぶ(文字が読める組み合わせだけを用意している。DB側の決まりと同じ並び)。

export const RANK_COLORS = [
    { key: 'blue', label: '青', bg: 'linear-gradient(135deg, #10244F, #1F5FD1)', fg: '#FFFFFF', dot: '#1F5FD1' },
    { key: 'green', label: '緑', bg: 'linear-gradient(135deg, #0B3D2A, #1E7E4A)', fg: '#FFFFFF', dot: '#1E7E4A' },
    { key: 'red', label: '赤', bg: 'linear-gradient(135deg, #5F1414, #B42318)', fg: '#FFFFFF', dot: '#B42318' },
    { key: 'purple', label: '紫', bg: 'linear-gradient(135deg, #2E1760, #6D3FC4)', fg: '#FFFFFF', dot: '#6D3FC4' },
    { key: 'bronze', label: 'ブロンズ', bg: 'linear-gradient(135deg, #5A3414, #96592A)', fg: '#FFFFFF', dot: '#96592A' },
    { key: 'silver', label: 'シルバー', bg: 'linear-gradient(135deg, #B9C2CF, #EDF0F4)', fg: '#1F2A44', dot: '#B9C2CF' },
    { key: 'gold', label: 'ゴールド', bg: 'linear-gradient(135deg, #D9A62E, #F4D774)', fg: '#3B2A00', dot: '#D9A62E' },
    { key: 'black', label: 'ブラック', bg: 'linear-gradient(135deg, #0B0F19, #3A4353)', fg: '#FFFFFF', dot: '#1B2230' },
];
export const MAX_RANKS = 5;
export const RANK_NAME_MAX = 12;

/** 色の名前から、会員証の色を返す(知らない名前は、青) */
export function rankColor(key) {
    return RANK_COLORS.find(c => c.key === key) || RANK_COLORS[0];
}

/** ランクを使う設定か(「ランクが上がる」で、ランクが2つ以上あるとき) */
export function ranksOf(card) {
    const ranks = card && card.full_mode === 'rank' && Array.isArray(card.ranks) ? card.ranks : [];
    return ranks.length >= 2 ? ranks : [];
}

/** いっぱいになったカードの枚数から、ランクの番号(0始まり)を返す。ランクを使わないときは -1 */
export function rankIndex(card, cardsCompleted) {
    const ranks = ranksOf(card);
    if (!ranks.length) return -1;
    const n = Math.floor(Number(cardsCompleted) || 0);
    return Math.min(Math.max(n, 0), ranks.length - 1);
}

/** はじめて「ランクが上がる」を選んだときの、ランクの例 */
export function defaultRanks() {
    return [
        { name: 'レギュラー', color: 'blue', own: false, rewards: [] },
        { name: 'シルバー', color: 'silver', own: false, rewards: [] },
        { name: 'ゴールド', color: 'gold', own: false, rewards: [] },
    ];
}
