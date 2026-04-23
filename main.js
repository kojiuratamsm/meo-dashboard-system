// src/main.js
// アプリケーションのエントリーポイント

import { requireAuth, applyUserInfo, applyPlanRestrictions } from './components/auth.js'
import { switchMainView } from './components/router.js'
import { handleImageSelect } from './components/imageUtils.js'

// --- アプリ起動処理 ---
async function bootstrap() {
  // 1. 認証チェック（未ログインなら login.html へリダイレクト）
  const user = requireAuth()
  
  // 2. ユーザー情報をUIに反映
  applyUserInfo(user)
  
  // 3. プランに応じてメニューを制限
  applyPlanRestrictions(user)

  // 4. 各ページモジュールを遅延ロードで初期化
  const { initDashboard } = await import('./pages/dashboard.js')
  initDashboard(user)
}

// DOMの読み込み完了後に起動
document.addEventListener('DOMContentLoaded', bootstrap)
