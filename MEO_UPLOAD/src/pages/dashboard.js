// src/pages/dashboard.js
// ダッシュボード画面の動的処理

import { supabase } from '../supabase.js'

/**
 * ダッシュボードの初期化
 * @param {Object} user - ログイン中ユーザーデータ
 */
export async function initDashboard(user) {
  initChart()
  if (user?.plan === 'A') {
    initBlogWidget(user.blogs || [])
  }
}

/**
 * パフォーマンスチャートの初期化
 */
function initChart() {
  const canvas = document.getElementById('performanceChart')
  if (!canvas || !window.Chart) return

  const ctx = canvas.getContext('2d')
  const labels = ['2025/11', '2025/12', '2026/1', '2026/2', '2026/3', '2026/4']
  
  new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '表示回数',
          data: [0, 0, 0, 0, 0, 0],
          borderColor: '#4285F4',
          backgroundColor: 'rgba(66,133,244,0.1)',
          tension: 0.4,
          fill: true,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#F4F7FE' } },
        x: { grid: { display: false } }
      }
    }
  })
}

/**
 * 運用代行プラン向けブログウィジェット初期化
 * @param {Array} blogs
 */
export function initBlogWidget(blogs = []) {
  window.agencyBlogs = blogs
  
  const selector = document.getElementById('blogMonthSelector')
  if (!selector) return

  // 月セレクターを生成
  const months = [...new Set(blogs.map(b => b.month))].sort((a, b) => b.localeCompare(a))
  // 既存オプションを1つ目（全て）だけ残してリセット
  while (selector.options.length > 1) selector.remove(1)
  months.forEach(m => {
    const opt = document.createElement('option')
    opt.value = m
    opt.textContent = m
    selector.appendChild(opt)
  })

  renderBlogList()
}

/**
 * ブログ一覧の描画
 */
export function renderBlogList() {
  const container = document.getElementById('blogListContainer')
  const selector = document.getElementById('blogMonthSelector')
  if (!container || !selector) return

  const selectedMonth = selector.value
  let blogs = window.agencyBlogs || []
  if (selectedMonth !== 'all') {
    blogs = blogs.filter(b => b.month === selectedMonth)
  }
  blogs = [...blogs].reverse()

  if (blogs.length === 0) {
    container.innerHTML = '<p style="font-size:13px; color:#A3AED0; text-align:center; padding:10px;">ブログ記事がまだありません。</p>'
    return
  }

  container.innerHTML = blogs.map((b, i) => {
    const badge = i === 0
      ? '<span style="font-size:10px; background:#FEF3C7; color:#D97706; padding:2px 8px; border-radius:10px; margin-right:10px;">一番最新</span>'
      : i === 1
      ? '<span style="font-size:10px; background:#E2E8F0; color:#4A5568; padding:2px 8px; border-radius:10px; margin-right:10px;">前回</span>'
      : ''
    return `
      <div style="display:flex; align-items:center; border:1px solid #E2E8F0; border-radius:10px; padding:12px; background:#fff;">
        <div style="flex:1;">${badge}<a href="${b.url}" target="_blank" style="color:#2B3674; font-weight:bold; font-size:14px; text-decoration:none;">${b.title}</a></div>
        <div style="font-size:12px; color:#A3AED0; margin-right:12px;">${b.month}</div>
        <a href="${b.url}" target="_blank" style="color:#4285F4;"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
      </div>`
  }).join('')
}

// グローバル公開（HTMLのonchangeと互換性確保）
window.renderBlogList = renderBlogList
window.initBlogWidget = initBlogWidget
