// coupon-lib.js
// クーポンの表示と、ルーレットの「景品表示法の目安」の計算(管理画面とお客様の画面で共用)

const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;

/** クーポンの見出し(例:「500円OFF」「20%OFF」「ドリンク1杯無料」) */
export function couponHeadline(c) {
    if (!c) return '';
    if (c.kind === 'amount') return `${Number(c.amount).toLocaleString('ja-JP')}円OFF`;
    if (c.kind === 'percent') return `${c.percent}%OFF`;
    return String(c.benefit || '');
}

/** 管理画面の一覧に出す、クーポンの内容(例:「20%引き(最大2,000円)」) */
export function couponSummary(c) {
    if (!c) return '';
    if (c.kind === 'amount') return `${yen(c.amount)}引き`;
    if (c.kind === 'percent') return `${c.percent}%引き` + (c.cap_amount ? `(最大${yen(c.cap_amount)})` : '(上限額なし)');
    return `特典:${c.benefit || ''}`;
}

/** お客様の画面に出す利用条件(文の一覧) */
export function couponTerms(c) {
    if (!c) return [];
    const list = [];
    if (c.kind === 'percent' && c.cap_amount) list.push(`割引は最大${yen(c.cap_amount)}まで`);
    if (c.min_spend) list.push(`${yen(c.min_spend)}以上のご利用で使えます`);
    if (String(c.conditions || '').trim()) list.push(String(c.conditions).trim());
    return list;
}

/** 有効期限の表示(管理画面) */
export function couponValidity(c) {
    const parts = [];
    if (c.valid_days) parts.push(`発行から${c.valid_days}日`);
    if (c.valid_until) parts.push(`${String(c.valid_until).replaceAll('-', '/')}まで`);
    return parts.join('・');
}

/** 日時を「2026年12月31日」の形にする(日本時間) */
export function formatDateJa(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })
        .formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}年${p.month}月${p.day}日`;
}

/** クーポン1枚の金額の目安(円)。特典は金額が分からないので null */
export function couponValue(c, avgSpend) {
    if (!c) return null;
    if (c.kind === 'amount') return Number(c.amount);
    if (c.kind === 'percent') {
        const raw = Number(avgSpend) * Number(c.percent) / 100;
        return c.cap_amount ? Math.min(raw, Number(c.cap_amount)) : raw;
    }
    return null;
}

/**
 * ルーレットの「景品表示法の目安」を計算する。
 * 抽選(懸賞)で渡す割引券は、景品表示法の一般懸賞の対象(消費者庁「景品に関するQ&A」Q45・Q46)。
 *   ・最高額:取引価額の20倍まで  ・総額:懸賞に係る売上予定総額の2%まで
 * ここでは平均客単価を取引価額とみなして、目安だけを出す(正式な判断は専門家の確認が必要)。
 * @param {{coupon: object, percent: number}[]} prizes
 * @param {number} avgSpend 平均客単価(円)
 */
export function lotteryEstimate(prizes, avgSpend) {
    const avg = Number(avgSpend);
    if (!avg || avg <= 0 || !prizes?.length) return null;
    let maxValue = 0, expected = 0, hasGift = false, uncapped = false;
    for (const p of prizes) {
        if (!p.coupon) continue;
        if (p.coupon.kind === 'percent' && !p.coupon.cap_amount) uncapped = true;
        const v = couponValue(p.coupon, avg);
        if (v === null) { hasGift = true; continue; }
        maxValue = Math.max(maxValue, v);
        expected += v * (Number(p.percent) || 0) / 100;
    }
    const maxAllowed = avg * 20;
    const ratio = expected / avg;                       // 1回あたりの平均が、客単価の何割にあたるか
    const participation = ratio > 0 ? 0.02 / ratio : Infinity;   // 来店客のうち何割が参加すると、総額が売上の2%に達するか
    return {
        maxValue: Math.round(maxValue), maxAllowed, maxOk: maxValue <= maxAllowed,
        expected: Math.round(expected),
        participationLimitPercent: participation >= 1 ? null : Math.floor(participation * 100),
        totalOk: participation >= 1,
        hasGift, uncapped,
    };
}
