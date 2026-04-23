// src/components/auth.js
// ログイン認証・ユーザー情報管理モジュール

/**
 * ログイン中のユーザーデータを取得する
 * @returns {Object|null} ユーザーデータ or null
 */
export function getCurrentUser() {
  try {
    const raw = localStorage.getItem('currentUser')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * ログアウト処理
 */
export function logout() {
  localStorage.removeItem('currentUser')
  localStorage.removeItem('masterAdmin')
  window.location.href = '/login'
}

/**
 * 未ログインの場合ログイン画面へリダイレクト
 */
export function requireAuth() {
  const user = getCurrentUser()
  const isMaster = localStorage.getItem('masterAdmin')
  const isDemo = sessionStorage.getItem('demoBypass')
  if (!user && !isMaster && !isDemo) {
    window.location.replace('/login')
    return null
  }
  return user
}

/**
 * ダッシュボード上のユーザー名・店舗名を動的に更新する
 * @param {Object} user
 */
export function applyUserInfo(user) {
  if (!user) return
  const storeName = user.company_name || '管理者'

  // 動的な店舗名テキストを全て更新
  document.querySelectorAll('.dynamic-store-name').forEach(el => {
    el.textContent = storeName
  })

  // ユーザープロフィール欄
  const profileEl = document.querySelector('.user-profile')
  if (profileEl) {
    profileEl.innerHTML = `<div class="avatar">店</div> ${storeName} 様`
  }
}

/**
 * プランに応じてナビゲーションと機能を制限する
 * @param {Object} user
 */
export function applyPlanRestrictions(user) {
  if (!user) return

  const postsBtn = document.getElementById('nav-posts-btn')
  const resBtn = document.getElementById('nav-reservations-btn')
  const custBtn = document.getElementById('nav-customers-btn')
  const resWidget = document.getElementById('reservationWidget')
  const blogWidget = document.getElementById('blogWidget')

  if (user.plan === 'A') {
    // 運用代行プラン: 投稿・予約・顧客管理を非表示
    if (postsBtn) postsBtn.style.display = 'none'
    if (resBtn) resBtn.style.display = 'none'
    if (custBtn) custBtn.style.display = 'none'
    if (resWidget) resWidget.style.display = 'none'
    if (blogWidget) {
      blogWidget.style.display = 'block'
      window.agencyBlogs = user.blogs || []
      if (window.initBlogWidget) window.initBlogWidget()
    }
  } else {
    // MapOn / MapOnモニタープラン: フル機能
    if (postsBtn) postsBtn.style.display = 'flex'
    if (resBtn) resBtn.style.display = 'flex'
    if (custBtn) custBtn.style.display = 'flex'
    if (resWidget) resWidget.style.display = 'block'
    if (blogWidget) blogWidget.style.display = 'none'
  }
}
