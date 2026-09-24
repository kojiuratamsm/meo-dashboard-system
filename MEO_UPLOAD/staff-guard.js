// staff-guard.js
// MSMスタッフ専用ページ(マスター管理画面など)の入口チェック。
//
// 本当の防御はDB側のRLS(行レベルセキュリティ)です。ここは「権限のない人に画面を見せない」ための表側の確認です。
// 判定はDB関数 is_msm_staff() で行い、メールアドレスやlocalStorageの値は使いません。

import { supabase } from './supabase-config.js';

const LOGIN_PATH = '/master-login';

// ログアウト後にブラウザの「戻る」で、保存されていた前の画面が表示されないようにする
// (戻るで復元されたときは読み込み直し、もう一度権限を確認する)
window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
});

/**
 * ログイン済みのMSMスタッフでなければログイン画面へ移動する。
 * スタッフであれば <html class="auth-pending"> を外して画面を表示し、セッションを返す。
 */
export async function requireStaff() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        location.replace(LOGIN_PATH);
        return null;
    }

    const { data: isStaff, error } = await supabase.rpc('is_msm_staff');
    if (error && (error.code === 'PGRST202' || /is_msm_staff/.test(error.message || ''))) {
        // Supabase で初期設定SQL(supabase/MapOn_setup.sql)がまだ実行されていない
        location.replace(LOGIN_PATH + '?reason=setup');
        return null;
    }
    if (error || isStaff !== true) {
        if (error) console.error('スタッフ権限の確認に失敗しました:', error);
        await supabase.auth.signOut();
        localStorage.removeItem('masterAdmin');
        location.replace(LOGIN_PATH + '?reason=forbidden');
        return null;
    }

    document.documentElement.classList.remove('auth-pending');
    return session;
}

/** ログアウトしてマスターログイン画面へ戻る */
export async function staffLogout() {
    try {
        await supabase.auth.signOut();
    } catch (e) {
        console.error('ログアウト処理でエラー:', e);
    }
    localStorage.removeItem('masterAdmin');
    localStorage.removeItem('currentUser');
    location.href = LOGIN_PATH;
}

/** サーバー関数(/api/admin/*)を呼ぶときに付ける認証ヘッダー */
export async function authHeaders() {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}
