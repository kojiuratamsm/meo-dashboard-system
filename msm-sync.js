// msm-sync.js
// MapOnメディアで記事を公開したとき、MSM管理画面(自社管理サイト)の
// 「顧客管理 / 案件管理 → MEO対策チャンネル」の店舗の「ブログ履歴」に、タイトル・日付・URLを自動で記録する。
//
// ・MSM管理画面は別の Supabase プロジェクト(customers テーブル、service_type='meo')にデータがある
// ・接続先とキーは msm-config.js に書く
// ・ブログ履歴の1件 = { name: タイトル, date: 'YYYY-MM-DD', url, person: 執筆者, source: 'mapon_media', articleId }
//   同じ記事(URLが同じ)は1件にまとめ、更新時は上書き、店舗を選び直したら元の店舗からは外す

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { MSM_SUPABASE_URL, MSM_SUPABASE_KEY } from './msm-config.js';

export const msmReady = Boolean(MSM_SUPABASE_URL && MSM_SUPABASE_KEY);
const msm = msmReady
    ? createClient(MSM_SUPABASE_URL, MSM_SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'msm-sync' } })
    : null;

export const MEDIA_BASE_URL = 'https://www.mapon-meo.com/media';
export const articleUrl = (id) => `${MEDIA_BASE_URL}?id=${id}`;

// 日本時間の今日 'YYYY-MM-DD'
export function todayJst() {
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function requireMsm() {
    if (!msm) throw new Error('MSM管理画面との連携が設定されていません(msm-config.js)');
    return msm;
}

// MEO対策チャンネルの店舗一覧(契約中を先に、名前順)
export async function listMsmMeoStores() {
    const { data, error } = await requireMsm().from('customers').select('id, data').eq('service_type', 'meo');
    if (error) throw error;
    return (data || [])
        .map(r => ({ id: r.id, name: String(r.data?.client || '(名前なし)'), tag: r.data?.tag || '', blogs: Array.isArray(r.data?.blogs) ? r.data.blogs : [] }))
        .sort((a, b) => (a.tag === '解約済み') - (b.tag === '解約済み') || a.name.localeCompare(b.name, 'ja'));
}

// この記事(URL)が記録されている店舗のID(なければ null)
export function findStoreOfArticle(stores, url) {
    const hit = stores.find(s => s.blogs.some(b => b && b.url === url));
    return hit ? hit.id : null;
}

async function saveBlogs(id, mutate) {
    const client = requireMsm();
    const { data: row, error } = await client.from('customers').select('data').eq('id', id).single();
    if (error) throw error;
    const current = row?.data || {};
    const blogs = mutate(Array.isArray(current.blogs) ? [...current.blogs] : []);
    blogs.sort((a, b) => new Date(b.date) - new Date(a.date));
    const { error: upErr } = await client.from('customers').update({ data: { ...current, blogs } }).eq('id', id);
    if (upErr) throw upErr;
}

/**
 * 記事を公開・更新したときに呼ぶ。storeId が空なら、どの店舗にも記録しない(記録済みなら外す)。
 * @returns {Promise<string|null>} 記録した店舗名
 */
export async function syncArticleToMsm({ articleId, title, date, person, storeId }) {
    const url = articleUrl(articleId);
    const stores = await listMsmMeoStores();
    for (const s of stores) {
        if (String(s.id) !== String(storeId) && s.blogs.some(b => b && b.url === url)) {
            await saveBlogs(s.id, blogs => blogs.filter(b => !(b && b.url === url)));
        }
    }
    if (storeId === null || storeId === undefined || storeId === '') return null;
    const target = stores.find(s => String(s.id) === String(storeId));
    if (!target) throw new Error('MSM管理画面の店舗が見つかりません');
    const entry = { name: title, date: date || todayJst(), url, person: person || '', source: 'mapon_media', articleId };
    await saveBlogs(target.id, blogs => {
        const i = blogs.findIndex(b => b && b.url === url);
        if (i >= 0) blogs[i] = { ...blogs[i], ...entry };
        else blogs.push(entry);
        return blogs;
    });
    return target.name;
}

// 記事を削除したときに呼ぶ(記録済みのブログ履歴から外す)
export async function removeArticleFromMsm(articleId) {
    const url = articleUrl(articleId);
    const stores = await listMsmMeoStores();
    for (const s of stores) {
        if (s.blogs.some(b => b && b.url === url)) await saveBlogs(s.id, blogs => blogs.filter(b => !(b && b.url === url)));
    }
}
