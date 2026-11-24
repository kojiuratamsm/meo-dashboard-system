// terms.js
// MapOn の利用規約(有料の MapOn と、無料の MapOn Light の2つ)と、申し込みフォームで開くポップアップ。
// ・条ごとに開いたり閉じたりできる(最初は閉じている)。「すべて開く」で全文を表示できる。
// ・利用者に特に関わる条には「重要」の印を付ける。
// ・規約の文面を変えたときは、TERMS_VERSION を新しい日付にする(申し込み時に、同意した版としてデータベースに記録される)。
// ※ 公開前に、専門家(弁護士)の確認を受けてください。

export const TERMS_VERSION = '2026-11-24';
export const OFFICIAL_LINE_URL = 'https://sub.msm-fund.com/line/open/wPBzQBgRMj2L?mtid=bF2CR6ch0ym0';

// 各条:n=条の番号 / title=見出し / important=重要の印 / items=項(2つ以上なら「1.」から番号を付ける)
//   項は 文字列、または [文字列, [号の一覧]](号は「(1)」から番号を付ける)
const COMMON_AI = {
    title: 'AIによる文章作成',
    items: [
        'AIが作成した文章は、参考のためのものです。当社は、その正確性・適法性・適切性を保証しません。',
        '利用者は、内容を確認し、自己の責任で使用してください。',
        '第三者の権利を侵害する内容や、事実と異なる内容を含めないでください。',
        'AIによる文章作成のため、入力された内容(アンケートの回答など)が、AIを提供する事業者に送信されます。',
        '当社が定める回数の上限に達したときは、翌月まで、AIによる文章作成は利用できません。',
    ],
};
const GOOGLE = (measures) => ({
    title: '外部サービスとGoogleのポリシー',
    items: [
        '本サービスは、Googleなどの外部サービスと組み合わせて使われます。外部サービスの規約・ポリシーは、利用者が自ら守ってください。当社は、外部サービスの仕様の変更や、利用者のアカウントの停止などについて、責任を負いません。',
        ['利用者は、Googleのクチコミに関するポリシーを守り、次のことをしてはなりません。', [
            'クチコミの投稿と引き換えに、割引・景品・特典などを提供すること。',
            '肯定的なクチコミだけを選んで依頼すること、または否定的なクチコミの投稿を妨げること。',
            'クチコミの投稿を強要すること。',
        ]],
        measures,
    ],
});
const GOOGLE_MEASURES = '本サービスを利用したこと、または本サービスで作成・案内した内容(AIが作成した文章、アンケート、クーポンなど)を利用したことに関連して、利用者のGoogleアカウントやGoogleビジネスプロフィールが、停止、制限、削除、クチコミの非表示や削除、検索結果での順位の低下などの措置を受けた場合';
const POSITION = {
    title: '本サービスの位置づけ',
    items: [
        '本サービスは、利用者のお客様に、アンケートにご回答いただくためのサービスです。Googleのガイドラインに反する方法で、クチコミを増やすことを目的とするものではありません。',
        'クーポン・抽選などの特典は、アンケートにご回答いただいたことへのお礼として、お渡しするものです。Googleにクチコミを投稿したかどうか、クチコミの内容、評価の高低によって、特典の内容や、お渡しするかどうかを変えることは、ありません。',
        '本サービスのAIは、お客様が回答したアンケートの内容をもとに、クチコミの文章案を作成し、お客様が文章を考える手伝いをします。文章案は参考であり、お客様が内容を確認し、必要に応じて修正して、投稿するかどうかを、ご自身で決めます。クチコミの投稿は、お客様ご自身が行い、当社や利用者が代わりに投稿することは、ありません。',
        '利用者は、特典をお渡しすることを、クチコミの投稿の条件にしてはなりません。',
    ],
};
const PRIVACY = '個人情報の取り扱いは、本条に定めるほか、当社が別に定めるプライバシーポリシー(https://www.msm-fund.com/privacypolicy)によります。';
const CLOSING = '附則 本規約は、2026年11月1日から施行します。';
const COMMON_FORBIDDEN = {
    title: '禁止事項', important: true,
    items: [
        ['利用者は、次の行為をしてはなりません。', [
            '法令または公序良俗に違反する行為。',
            '虚偽の情報による申し込み。',
            '1店舗について複数のアカウントを作る行為、他人の名義での申し込み、同一人物による無断での重複申し込み。',
            '申し込みURLを第三者に共有、公開、または流出させる行為。第三者にURLを教えて、登録させる行為。',
            'アカウントの貸与・譲渡・売買。',
            '不正アクセス、自動プログラムによる申し込み、本サービスに過度な負荷をかける行為。',
            '本サービスの複製、解析、再販、または業として他者に提供する行為。',
            '第三者の権利の侵害、誹謗中傷、虚偽または誤解を招く表示。',
            '第8条に反する行為。',
            '反社会的勢力との関係、またはその利用。',
            'その他、当社が不適切と判断する行為。',
        ]],
    ],
};
const COMMON_CHANGE = {
    title: '規約の変更',
    items: ['当社は、必要と判断したときに、本規約を変更できます。変更後の内容と効力発生日は、本サービス上または当社が適切と定める方法で、お知らせします。効力発生日以後に本サービスを利用したときは、変更後の規約に同意したものとみなします。'],
};
const COMMON_LAW = {
    title: '準拠法・管轄',
    items: ['本規約は、日本法に基づき解釈されます。本サービスに関する紛争は、大阪地方裁判所を、第一審の専属的合意管轄裁判所とします。'],
};
const ACCOUNT = (urlNote) => ({
    title: 'アカウントとURLの管理', important: true,
    items: [
        '利用者は、ログイン情報(メールアドレス・パスワード)を、自己の責任で管理し、第三者に使用させ、貸与し、または譲渡してはなりません。',
        urlNote,
        'ログイン情報やURLの管理が不十分だったことにより生じた損害は、利用者が負担します。ただし、当社に故意または重大な過失がある場合を除きます。',
        '第三者による不正な利用を知ったときは、直ちに当社へ連絡してください。',
    ],
});
const VIOLATION = (extra) => ({
    title: '違反時の措置', important: true,
    items: [
        '不正な申し込み、無断での重複申し込み、第三者へのURL共有による登録など、第9条の違反が確認された場合は、規約違反とみなし、運営の判断により、事前の通知なく、ご本人および第三者のアカウントを削除し、本サービスの利用を停止することがあります。' + (extra || ''),
        '削除したアカウントのデータは、復元できません。',
        '当社は、違反の確認のために、申し込み時の入力内容(メールアドレス、店舗名など)を照合することがあります。',
        '当社は、本条の措置によって利用者に生じた損害について、責任を負いません。違反により当社に生じた損害は、利用者に賠償を請求することがあります。',
    ],
});

const LIGHT = {
    name: 'MapOn Light 利用規約',
    preface: 'この利用規約(以下「本規約」)は、株式会社MSM(以下「当社」)が提供するMapOn Light(以下「本サービス」)の利用条件を定めるものです。本サービスを利用する方(以下「利用者」)は、本規約に同意したうえで、お申し込みください。',
    articles: [
        { title: '適用', items: ['本規約は、本サービスの利用に関わる、当社と利用者との一切の関係に適用されます。', '当社が本サービス上に掲載する案内やルールは、本規約の一部となります。'] },
        { title: '定義', items: [
            '「本サービス」とは、当社が店舗向けに無料で提供する、アンケート・クーポン・AIによる文章作成などの機能を持つウェブサービスをいいます。',
            '「申し込みURL」とは、当社が利用者に案内する、本サービスの申し込みページのURLをいいます。',
            '「有料プラン」とは、当社が別に提供するMapOn(有料)をいいます。'] },
        { title: '利用資格・申し込み', items: [
            '本サービスは、当社のLINE公式アカウントに友だち登録している、店舗を運営する個人または法人のうち、当社から申し込みURLを案内された方が利用できます。',
            '申し込みは、フォームに、氏名・店舗名・メールアドレス・LINEに登録されているお名前を、事実のとおり入力して行います。',
            'アカウントは、1店舗につき1つです。',
            '当社は、虚偽の入力、重複した申し込み、本規約に違反するおそれがあるときなどは、申し込みを承諾しない、または承諾後でも取り消すことができます。',
            '申し込みの完了により、本規約に基づく利用契約が成立します。'] },
        ACCOUNT('申し込みURLは、利用者ご本人のためのものです。第三者に共有、公開、または流出させてはなりません。'),
        { title: 'Lightの内容と利用範囲', items: [
            ['本サービスでは、次の機能を利用できます。', ['アンケート(1つまで)', 'クーポン(1つまで)', 'AIによる文章作成(1か月に25回まで)', 'Googleビジネスプロフィールの運用を支援する機能(口コミ投稿ページのURLの設定の案内など)']],
            '会員証・ショップカードと、2つ目以降のアンケート・クーポンは、本サービスではご利用いただけません。',
            '当社は、上記の内容と上限を、変更することがあります。'] },
        POSITION,
        COMMON_AI,
        GOOGLE(GOOGLE_MEASURES + 'でも、当社は、理由のいかんを問わず、一切の責任を負いません。'),
        COMMON_FORBIDDEN,
        VIOLATION(),
        { title: '料金・有料プランについて', items: [
            '本サービスは無料です。通信費など、利用に必要な費用は、利用者が負担します。',
            '有料プランの内容・料金・申し込み方法は、別途、当社がご案内します。',
            '有料プランに移る場合、これまでのデータは、そのまま引き継がれます。'] },
        { title: '個人情報とデータの取扱い', items: [
            '当社は、次の情報を取得します。氏名、店舗名、メールアドレス、LINEに登録されているお名前、規約に同意した日時、本サービスの利用の記録(AIの利用回数など)、アクセスに関する情報。',
            '利用目的は、次のとおりです。アカウントの管理、本人確認と不正の防止(重複した登録の確認を含みます)、お問い合わせへの対応、お知らせの送信、本サービスの提供と改善。',
            '当社は、解約したあとも、不正の防止(再申し込みの確認)と、解約の記録のために、メールアドレス・店舗名・LINEに登録されているお名前を保管します。',
            '当社は、本サービスの提供のために、クラウドサービス、メール配信、AIの各事業者に、必要な範囲で情報の取り扱いを委託します。これらの事業者のサーバーは、海外にある場合があります。',
            '利用者が本サービスで取得するお客様のデータ(アンケートの回答など)は、利用者の責任で取り扱います。利用者は、ご自身のお客様に対して、利用目的の説明などを行ってください。',
            PRIVACY] },
        { title: 'サービスの変更・停止・終了', items: ['本サービスは無料のため、当社は、内容の変更、一時的な停止、または終了を、予告なく行うことがあります。終了するときは、できる限り事前にお知らせします。'] },
        { title: '免責', items: [
            '本サービスは、現状のままで提供します。当社は、特定の目的への適合性、継続的な利用、データが失われないことなどを、保証しません。',
            '当社は、当社に故意または重大な過失がある場合を除き、本サービスに関して利用者に生じた損害について、責任を負いません。'] },
        { title: '解約', important: true, items: [
            '利用者は、管理画面の「設定」にある「解約」から、今のパスワードを入力して、いつでも解約できます。',
            '解約すると、アカウントとデータ(アンケート、回答、クーポン、AIで作った文章など)は、直ちに削除され、元に戻せません。お客様に配っているアンケートのURLやQRコードも、使えなくなります。',
            '解約したメールアドレスでは、本サービスに再び申し込むことはできません。'] },
        COMMON_CHANGE,
        COMMON_LAW,
    ],
    closing: CLOSING,
};

const NEO = {
    name: 'MapOn 利用規約',
    preface: 'この利用規約(以下「本規約」)は、株式会社MSM(以下「当社」)が、運用代行プランをご契約のお客様に提供するMapOn(以下「本サービス」)の利用条件を定めるものです。本サービスを利用する方(以下「利用者」)は、本規約に同意したうえで、お申し込みください。',
    articles: [
        { title: '適用', items: ['本規約は、本サービスの利用に関わる、当社と利用者との一切の関係に適用されます。', '当社が本サービス上に掲載する案内やルールは、本規約の一部となります。'] },
        { title: '定義', items: [
            '「本サービス」とは、当社が店舗向けに提供する、アンケート・クーポン・会員証・AIによる文章作成などの機能を持つウェブサービスをいいます。',
            '「申し込みURL」とは、当社が利用者ごとに発行する、本サービスの申し込みページのURLをいいます。',
            '「運用代行のご契約」とは、利用者と当社との間で結ばれる、運用代行プランの契約をいいます。'] },
        { title: '利用資格・申し込み', items: [
            '本サービスは、当社の運用代行プランをご契約のお客様に提供します。',
            '申し込みは、当社が利用者ごとに発行する、1回限りの申し込みURLから行います。このURLでは、アカウントを1つだけ作れます。使用された後や、有効期限を過ぎた後は、無効になります。',
            '申し込みは、フォームに、氏名・店舗名・メールアドレス・パスワードを、事実のとおり入力して行います。',
            'アカウントは、1店舗につき1つです。',
            '当社は、虚偽の入力、重複した申し込み、本規約に違反するおそれがあるときなどは、申し込みを承諾しない、または承諾後でも取り消すことができます。',
            '申し込みの完了により、本規約に基づく利用契約が成立します。'] },
        ACCOUNT('申し込みURLは、利用者ご本人のためのものです。第三者に共有、公開、または流出させてはなりません。'),
        { title: 'サービスの内容', items: [
            '本サービスでは、アンケート、クーポン、会員証・ショップカード、AIによる文章作成(当社が定める上限まで)、Googleビジネスプロフィールの案内、ダッシュボードなどを利用できます。',
            '当社は、運用代行のご契約の範囲で、Googleビジネスプロフィールの運用支援を行います。',
            '運用代行の範囲は、運用代行のご契約に定めるとおりです。',
            '当社は、機能と上限を変更することがあります。'] },
        POSITION,
        COMMON_AI,
        GOOGLE(GOOGLE_MEASURES + '、当社は、当社に故意または重大な過失がある場合を除き、責任を負いません。'),
        COMMON_FORBIDDEN,
        VIOLATION('この場合、当社は、運用代行のご契約を解除することがあります。'),
        { title: '料金', important: true, items: [
            '本サービスの料金は、運用代行のご契約に定めるとおりです。',
            '利用者が当社に支払った料金は、解約、利用の中止、運用代行のご契約の終了、規約違反による取り消しなど、理由にかかわらず、一切返金しません。月の途中で解約した場合も、日割りでの返金は行いません。ただし、当社に故意または重大な過失がある場合は、この限りではありません。',
            '運用代行のご契約が終了したときは、本サービスの利用も終了し、当社は、アカウントとデータを削除します。',
            '当社がプランをMapOn Light(無料)に変更するときは、会員証・ショップカードのデータなど、Lightで使えない機能のデータが削除されます。事前に、当社からご説明します。'] },
        { title: '個人情報とデータの取扱い', items: [
            '当社は、次の情報を取得します。氏名、店舗名、メールアドレス、規約に同意した日時、本サービスの利用の記録(AIの利用回数など)、アクセスに関する情報。',
            '利用目的は、次のとおりです。アカウントの管理、本人確認と不正の防止、お問い合わせへの対応、お知らせの送信、本サービスの提供と改善。',
            '当社は、解約・削除の記録のために、店舗名・メールアドレスを保管します。',
            '当社は、本サービスの提供のために、クラウドサービス、メール配信、AIの各事業者に、必要な範囲で情報の取り扱いを委託します。これらの事業者のサーバーは、海外にある場合があります。',
            '利用者が本サービスで取得するお客様のデータ(アンケートの回答、会員情報など)は、利用者の責任で取り扱います。利用者は、ご自身のお客様に対して、利用目的の説明などを行ってください。',
            PRIVACY] },
        { title: 'サービスの変更・停止', items: ['当社は、本サービスの内容の変更や、一時的な停止を行うことがあります。重要な変更は、できる限り事前にお知らせします。'] },
        { title: '免責・責任の制限', items: [
            '本サービスは、現状のままで提供します。当社は、特定の目的への適合性、データが失われないことなどを、保証しません。',
            '当社が利用者に対して責任を負う場合、その額は、当社に故意または重大な過失がある場合を除き、損害が生じた月に利用者が当社に支払った本サービスの対価を上限とします。'] },
        { title: '解約', important: true, items: [
            '解約を希望するときは、当社の公式LINEにご連絡ください。当社が確認のうえ、手続きをご案内します。',
            '解約の手続きが完了すると、アカウントとデータ(アンケート、回答、クーポン、会員証・ショップカード、AIで作った文章など)は削除され、元に戻せません。お客様に配っているアンケートのURLやQRコードも、使えなくなります。',
            '運用代行のご契約とお支払いの停止についても、あわせてご案内します。'] },
        COMMON_CHANGE,
        COMMON_LAW,
    ],
    closing: CLOSING,
};

export const TERMS = { light: LIGHT, neo: NEO };

export const TERMS_CSS = `
.terms-bg { position: fixed; inset: 0; background: rgba(15, 23, 42, .55); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
.terms-modal { background: #fff; border-radius: 16px; width: 100%; max-width: 560px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; box-shadow: 0 20px 50px rgba(0,0,0,.25); }
.terms-head { padding: 18px 20px 12px; border-bottom: 1px solid #E2E8F0; }
.terms-head h2 { font-size: 17px; font-weight: 800; color: #1E293B; margin: 0 0 6px; }
.terms-head .terms-ver { font-size: 12px; color: #64748B; }
.terms-body { overflow-y: auto; padding: 14px 20px; -webkit-overflow-scrolling: touch; }
.terms-preface { font-size: 13px; line-height: 1.8; color: #334155; margin: 0 0 12px; }
.terms-tools { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 8px; }
.terms-tools button { background: none; border: 1px solid #CBD5E1; border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 700; color: #334155; cursor: pointer; }
.terms-art { border-top: 1px solid #E2E8F0; }
.terms-art:last-of-type { border-bottom: 1px solid #E2E8F0; }
.terms-art > button { width: 100%; display: flex; align-items: center; gap: 8px; background: none; border: none; padding: 12px 2px; font-size: 14px; font-weight: 700; color: #1E293B; text-align: left; cursor: pointer; }
.terms-art > button .chev { margin-left: auto; color: #64748B; font-size: 18px; font-weight: 500; line-height: 1; width: 18px; text-align: center; flex-shrink: 0; }
.terms-art .imp { font-size: 11px; font-weight: 800; color: #B91C1C; background: #FEE2E2; border-radius: 999px; padding: 2px 8px; flex-shrink: 0; }
.terms-art .content { padding: 0 2px 12px; font-size: 13px; line-height: 1.8; color: #334155; }
.terms-art .content[hidden] { display: none; }
.terms-art ol { margin: 0; padding-left: 1.6em; }
.terms-art ol.sub { list-style: none; padding-left: .4em; margin-top: 4px; }
.terms-art li { margin-bottom: 4px; }
.terms-closing { font-size: 12px; color: #64748B; margin: 12px 0 4px; }
.terms-foot { padding: 12px 20px 16px; border-top: 1px solid #E2E8F0; display: flex; justify-content: flex-end; }
.terms-foot button { background: #4F46E5; color: #fff; border: none; border-radius: 10px; padding: 10px 22px; font-size: 14px; font-weight: 700; cursor: pointer; }
.terms-art > button:focus-visible, .terms-tools button:focus-visible, .terms-foot button:focus-visible { outline: 3px solid rgba(79, 70, 229, .4); outline-offset: 2px; }
`;

function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') node.textContent = v;
        else if (k === 'onclick') node.addEventListener('click', v);
        else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c !== null && c !== undefined) node.append(c);
    return node;
}
// 文中のURL(https://…)は、新しいタブで開くリンクにする
function textWithLinks(text) {
    const frag = document.createDocumentFragment();
    String(text).split(/(https:\/\/[^\s()、。]+)/).forEach((part, i) => {
        if (!part) return;
        frag.append(i % 2 ? h('a', { href: part, target: '_blank', rel: 'noopener noreferrer', text: part }) : part);
    });
    return frag;
}
function itemNode(item) {
    if (!Array.isArray(item)) return textWithLinks(item);
    const [lead, subs] = item;
    const frag = document.createDocumentFragment();
    frag.append(lead, h('ol', { class: 'sub' }, ...subs.map((s, i) => h('li', { text: `(${i + 1}) ${s}` }))));
    return frag;
}

let cssAdded = false;
/** 利用規約のポップアップを開く(kind:'light' / 'neo')。閉じるときに onClose を呼ぶ */
export function openTermsPopup(kind, { onClose } = {}) {
    const terms = TERMS[kind] || TERMS.neo;
    if (!cssAdded) { document.head.append(h('style', { text: TERMS_CSS })); cssAdded = true; }
    document.getElementById('termsPopup')?.remove();
    const opener = document.activeElement;
    const toggles = [];
    const arts = terms.articles.map((a, i) => {
        const id = `termsArt${i + 1}`;
        const content = h('div', { class: 'content', id, hidden: true },
            a.items.length > 1 ? h('ol', {}, ...a.items.map(it => h('li', {}, itemNode(it)))) : h('div', {}, itemNode(a.items[0])));
        const btn = h('button', { type: 'button', 'aria-expanded': 'false', 'aria-controls': id, 'data-art': String(i + 1) },
            `第${i + 1}条(${a.title})`, a.important ? h('span', { class: 'imp', text: '重要' }) : null, h('span', { class: 'chev', 'aria-hidden': 'true', text: '+' }));
        const set = (open) => { btn.setAttribute('aria-expanded', open ? 'true' : 'false'); content.hidden = !open; btn.querySelector('.chev').textContent = open ? '−' : '+'; };
        btn.addEventListener('click', () => set(content.hidden));
        toggles.push(set);
        return h('section', { class: 'terms-art' }, btn, content);
    });
    let allOpen = false;
    const allBtn = h('button', { type: 'button', id: 'termsOpenAll' }, 'すべて開く');
    allBtn.addEventListener('click', () => { allOpen = !allOpen; toggles.forEach(f => f(allOpen)); allBtn.textContent = allOpen ? 'すべて閉じる' : 'すべて開く'; });
    const bg = h('div', { class: 'terms-bg', id: 'termsPopup', 'data-kind': kind });
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); opener?.focus?.(); onClose?.(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const closeBtn = h('button', { type: 'button', id: 'termsClose', onclick: close }, '閉じる');
    bg.append(h('div', { class: 'terms-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'termsTitle' },
        h('div', { class: 'terms-head' }, h('h2', { id: 'termsTitle', text: terms.name }), h('div', { class: 'terms-ver', text: `${terms.articles.length}条/各条の見出しを押すと、内容が開きます。` })),
        h('div', { class: 'terms-body' },
            h('p', { class: 'terms-preface', text: terms.preface }),
            h('div', { class: 'terms-tools' }, allBtn),
            ...arts,
            h('p', { class: 'terms-closing', text: terms.closing })),
        h('div', { class: 'terms-foot' }, closeBtn)));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(bg);
    closeBtn.focus();
    return bg;
}
