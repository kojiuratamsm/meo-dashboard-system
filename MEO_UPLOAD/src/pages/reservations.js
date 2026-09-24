// src/pages/reservations.js
// 予約管理（スタッフ・メニュー・予約フォーム）モジュール

import { supabase } from '../supabase.js'

// ===========================
// スタッフ管理
// ===========================

let currentStaffList = []

/**
 * Supabaseからスタッフ一覧を取得して描画
 */
export async function loadStaffList() {
  const container = document.getElementById('staffListContainer')
  if (!container) return

  container.innerHTML = '<p style="color:#A3AED0; text-align:center; padding:10px;"><i class="fa-solid fa-spinner fa-spin"></i> 読み込み中...</p>'

  const { data, error } = await supabase.from('staff').select('*').order('created_at', { ascending: true })

  if (error) {
    console.error('スタッフ取得エラー:', error)
    container.innerHTML = '<p style="color:red;">スタッフデータの取得に失敗しました。</p>'
    return
  }

  currentStaffList = data || []
  container.innerHTML = ''

  if (currentStaffList.length === 0) {
    container.innerHTML = '<p style="color:#A3AED0; text-align:center; padding:20px; font-size:13px;">スタッフが登録されていません。下のボタンから追加してください。</p>'
    return
  }

  currentStaffList.forEach(staff => renderStaffCard(staff))
}

/**
 * スタッフカードを描画する
 * @param {Object} staff - スタッフデータ（nullなら新規）
 */
export function renderStaffCard(staff = null) {
  const container = document.getElementById('staffListContainer')
  if (!container) return

  const id = staff?.id || ''
  const photoUrl = staff?.photo_url || ''
  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`
    : '<i class="fa-solid fa-user" style="font-size:30px;"></i>'

  const card = document.createElement('div')
  card.className = 'card'
  card.dataset.id = id
  card.style.cssText = 'display:flex; align-items:center; gap:20px; padding:15px;'
  card.innerHTML = `
    <div style="position:relative; flex-shrink:0;">
      <div class="photo-preview" style="width:70px; height:70px; border-radius:50%; background:#E8F0FE; display:flex; align-items:center; justify-content:center; overflow:hidden; color:#4285F4;">${photoHtml}</div>
      <input type="hidden" class="staff-photo-url" value="${photoUrl}">
    </div>
    <div style="flex:1; display:grid; grid-template-columns:1fr 1fr; gap:10px; align-items:end;">
      <div class="form-group" style="margin-bottom:0;">
        <label style="font-size:12px;">名前</label>
        <input type="text" class="form-control staff-name" value="${staff?.name || ''}" placeholder="例: 山田 太郎" style="padding:8px;">
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label style="font-size:12px;">長所・特技</label>
        <input type="text" class="form-control staff-strength" value="${staff?.strength || ''}" placeholder="例: 丁寧な接客" style="padding:8px;">
      </div>
    </div>
    <div style="display:flex; flex-direction:column; gap:8px; flex-shrink:0;">
      <button class="btn-outline" style="font-size:11px; padding:6px 10px; white-space:nowrap;" onclick="handleImageSelect(this)">写真を選択</button>
      <button style="background:#FEE2E2; color:#EF4444; border:none; border-radius:8px; padding:6px 10px; font-size:11px; cursor:pointer;" onclick="this.closest('.card').remove()">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>
  `
  container.appendChild(card)
}

/**
 * スタッフ一覧をSupabaseに保存する
 */
export async function saveStaffList() {
  const btn = document.querySelector('[onclick="saveStaffList()"]')
  if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...'; btn.disabled = true }

  try {
    const cards = document.querySelectorAll('#staffListContainer .card[data-id]')
    const staffData = []

    cards.forEach(card => {
      const name = card.querySelector('.staff-name')?.value.trim()
      if (name) {
        staffData.push({
          id: card.dataset.id || crypto.randomUUID(),
          name,
          strength: card.querySelector('.staff-strength')?.value.trim() || '',
          photo_url: card.querySelector('.staff-photo-url')?.value.trim() || ''
        })
      }
    })

    // 既存レコードを全削除してから再挿入（upsertより確実）
    const { error: delError } = await supabase.from('staff').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (delError) throw delError

    if (staffData.length > 0) {
      const { error: insError } = await supabase.from('staff').insert(staffData)
      if (insError) throw insError
    }

    alert('✅ スタッフを保存しました！')
    loadStaffList()
  } catch (err) {
    console.error('保存エラー:', err)
    alert('保存に失敗しました: ' + err.message)
  } finally {
    if (btn) { btn.innerHTML = '保存する'; btn.disabled = false }
  }
}

// ===========================
// メニュー管理
// ===========================

/**
 * Supabaseからメニュー一覧を取得して描画
 */
export async function loadMenuList() {
  const container = document.getElementById('menuListContainer')
  if (!container) return

  container.innerHTML = '<p style="color:#A3AED0; text-align:center; padding:10px;"><i class="fa-solid fa-spinner fa-spin"></i> 読み込み中...</p>'

  const { data, error } = await supabase.from('menus').select('*').order('created_at', { ascending: true })

  if (error) {
    console.error('メニュー取得エラー:', error)
    container.innerHTML = '<p style="color:red;">メニューデータの取得に失敗しました。</p>'
    return
  }

  container.innerHTML = ''

  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color:#A3AED0; text-align:center; padding:20px; font-size:13px;">メニューが登録されていません。下のボタンから追加してください。</p>'
    return
  }

  data.forEach(menu => renderMenuCard(menu))
}

/**
 * メニューカードを描画する
 * @param {Object} menu - メニューデータ（nullなら新規）
 */
export function renderMenuCard(menu = null) {
  const container = document.getElementById('menuListContainer')
  if (!container) return

  // 既存の「登録なし」テキストを削除
  const emptyMsg = container.querySelector('p')
  if (emptyMsg) emptyMsg.remove()

  const id = menu?.id || ''
  const photoUrl = menu?.photo_url || ''
  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%; height:100%; object-fit:cover; border-radius:8px;">`
    : '<i class="fa-solid fa-image" style="font-size:24px;"></i>'

  const durationOptions = [30, 60, 90, 120, 150, 180].map(d =>
    `<option value="${d}" ${menu?.duration === d ? 'selected' : ''}>${d}分</option>`
  ).join('')

  const staffCheckboxes = currentStaffList.map(s => {
    const checked = (menu?.assignable_staff || []).includes(s.id) ? 'checked' : ''
    return `<label style="font-size:12px; display:flex; align-items:center; gap:4px;"><input type="checkbox" class="staff-check" value="${s.id}" ${checked}> ${s.name}</label>`
  }).join('')

  const card = document.createElement('div')
  card.className = 'card'
  card.dataset.id = id
  card.style.cssText = 'padding:15px;'
  card.innerHTML = `
    <div style="display:flex; gap:15px;">
      <div style="flex-shrink:0; width:100px;">
        <div class="photo-preview" style="width:100px; height:100px; background:#E8F0FE; border-radius:8px; display:flex; align-items:center; justify-content:center; overflow:hidden; color:#4285F4;">${photoHtml}</div>
        <input type="hidden" class="menu-photo-url" value="${photoUrl}">
        <button class="btn-outline" style="width:100%; font-size:10px; padding:4px; margin-top:6px;" onclick="handleImageSelect(this)">写真を選択</button>
      </div>
      <div style="flex:1; display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <div class="form-group" style="grid-column:span 2; margin-bottom:0;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <label style="font-size:12px;">メニュー名</label>
            <button style="background:none; border:none; color:#EF4444; cursor:pointer; font-size:12px;" onclick="this.closest('.card').remove()"><i class="fa-solid fa-trash"></i> 削除</button>
          </div>
          <input type="text" class="form-control menu-name" value="${menu?.item_name || ''}" placeholder="例: プレミアムコース" style="padding:8px;">
        </div>
        <div class="form-group" style="grid-column:span 2; margin-bottom:0;">
          <label style="font-size:12px;">メニュー詳細</label>
          <textarea class="form-control menu-description" style="padding:8px; height:60px; resize:vertical;" placeholder="内容の説明文">${menu?.description || ''}</textarea>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label style="font-size:12px;">価格 (税込)</label>
          <input type="number" class="form-control menu-price" value="${menu?.price || ''}" placeholder="8000" style="padding:8px;">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label style="font-size:12px;">所要時間</label>
          <select class="form-control menu-duration" style="padding:8px;">${durationOptions}</select>
        </div>
        <div class="form-group" style="grid-column:span 2; margin-bottom:0;">
          <label style="font-size:12px;">担当可能なスタッフ (複数選択可)</label>
          <div style="display:flex; flex-wrap:wrap; gap:8px;">${staffCheckboxes || '<span style="font-size:11px; color:#A3AED0;">スタッフが登録されていません</span>'}</div>
        </div>
      </div>
    </div>
  `
  container.appendChild(card)
}

/**
 * メニュー一覧をSupabaseに保存する
 */
export async function saveMenuList() {
  const btn = document.querySelector('[onclick="saveMenuList()"]')
  if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...'; btn.disabled = true }

  try {
    const cards = document.querySelectorAll('#menuListContainer .card[data-id]')
    const menuData = []

    cards.forEach(card => {
      const name = card.querySelector('.menu-name')?.value.trim()
      if (name) {
        const checkedStaff = [...card.querySelectorAll('.staff-check:checked')].map(c => c.value)
        menuData.push({
          id: card.dataset.id || crypto.randomUUID(),
          item_name: name,
          description: card.querySelector('.menu-description')?.value.trim() || '',
          price: parseInt(card.querySelector('.menu-price')?.value) || 0,
          duration: parseInt(card.querySelector('.menu-duration')?.value) || 60,
          photo_url: card.querySelector('.menu-photo-url')?.value.trim() || '',
          assignable_staff: checkedStaff
        })
      }
    })

    const { error: delError } = await supabase.from('menus').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (delError) throw delError

    if (menuData.length > 0) {
      const { error: insError } = await supabase.from('menus').insert(menuData)
      if (insError) throw insError
    }

    alert('✅ メニューを保存しました！')
    loadMenuList()
  } catch (err) {
    console.error('保存エラー:', err)
    alert('保存に失敗しました: ' + err.message)
  } finally {
    if (btn) { btn.innerHTML = '保存する'; btn.disabled = false }
  }
}

/**
 * 予約フォームURLの生成と表示
 */
export function updateReservationURL() {
  const urlInput = document.getElementById('reservationURL')
  const previewFrame = document.getElementById('reservationPreviewFrame')
  if (!urlInput) return

  const finalUrl = window.location.origin + '/reserve'
  urlInput.value = finalUrl
  if (previewFrame && previewFrame.src !== finalUrl) {
    previewFrame.src = finalUrl
  }
}

/**
 * 予約URLのコピー
 */
export function copyReservationURL() {
  const urlInput = document.getElementById('reservationURL')
  const copyBtn = document.getElementById('copyBtn')
  if (!urlInput || !copyBtn) return

  urlInput.select()
  urlInput.setSelectionRange(0, 99999)

  navigator.clipboard.writeText(urlInput.value).then(() => {
    const orig = copyBtn.innerText
    copyBtn.innerText = 'コピー済！'
    copyBtn.style.background = '#059669'
    setTimeout(() => { copyBtn.innerText = orig; copyBtn.style.background = '' }, 2000)
  }).catch(() => alert('コピーに失敗しました。'))
}

// グローバル公開（HTML側のonclickと互換性確保）
window.loadStaffList = loadStaffList
window.renderStaffCard = renderStaffCard
window.saveStaffList = saveStaffList
window.addStaffCard = () => {
  const c = document.getElementById('staffListContainer')
  if (c.children.length >= 100) { alert('スタッフは最大100名まで登録可能です。'); return }
  const p = c.querySelector('p')
  if (p) p.remove()
  renderStaffCard()
}
window.loadMenuList = loadMenuList
window.renderMenuCard = renderMenuCard
window.saveMenuList = saveMenuList
window.addMenuCard = () => {
  const c = document.getElementById('menuListContainer')
  if (c.querySelectorAll('.card').length >= 100) { alert('メニューは最大100種まで登録可能です。'); return }
  renderMenuCard()
}
window.updateReservationURL = updateReservationURL
window.copyReservationURL = copyReservationURL
