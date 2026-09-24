// src/components/router.js
// 画面切り替え（ビュールーティング）モジュール

/**
 * メインビューを切り替える
 * @param {string} viewId - 表示するビューID ('dashboard', 'reviews', etc.)
 * @param {Element|null} element - クリックされたナビ要素
 */
export function switchMainView(viewId, element = null) {
  // ナビアイテムのアクティブ状態を更新
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'))
  
  if (element) {
    element.classList.add('active')
  } else {
    let targetId = viewId
    if (viewId.includes('form')) targetId = 'reservations'
    document.querySelectorAll('.nav-item').forEach(link => {
      const onclickStr = link.getAttribute('onclick')
      if (onclickStr && onclickStr.includes(`'${targetId}'`)) {
        link.classList.add('active')
      }
    })
  }

  // 全ビューを非表示にしてから対象ビューを表示
  document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'))
  const targetView = document.getElementById('view-' + viewId)
  if (targetView) targetView.classList.add('active')

  // ビューごとの初期処理（遅延インポートで必要な時だけ読み込む）
  handleViewActivation(viewId)
}

/**
 * ビューが開かれた時の追加処理
 * @param {string} viewId
 */
async function handleViewActivation(viewId) {
  switch (viewId) {
    case 'staff-form':
      const { loadStaffList } = await import('../pages/reservations.js')
      loadStaffList()
      break
    case 'menu-form':
      const { loadMenuList } = await import('../pages/reservations.js')
      loadMenuList()
      break
    case 'reservation-form':
      const { updateReservationURL } = await import('../pages/reservations.js')
      updateReservationURL()
      break
  }
}

/**
 * グローバルに公開（既存のonclick="switchMainView(...)"と互換性を保つ）
 */
window.switchMainView = switchMainView
