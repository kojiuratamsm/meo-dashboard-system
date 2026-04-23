// src/components/imageUtils.js
// 画像圧縮・リサイズユーティリティ

/**
 * 画像ファイルを指定サイズに圧縮してBase64に変換する
 * @param {File} file - 入力画像ファイル
 * @param {number} maxSize - 最大ピクセルサイズ（デフォルト250px）
 * @returns {Promise<string>} Base64文字列
 */
export function compressImage(file, maxSize = 250) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let width = img.width
        let height = img.height

        if (width > height) {
          if (width > maxSize) { height = Math.round((height * maxSize) / width); width = maxSize }
        } else {
          if (height > maxSize) { width = Math.round((width * maxSize) / height); height = maxSize }
        }

        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}

/**
 * 画像選択ボタンのクリックハンドラ
 * @param {HTMLElement} btn - クリックされたボタン要素
 */
export async function handleImageSelect(btn) {
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/*'
  
  fileInput.onchange = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    const originalText = btn.innerText
    btn.innerText = '読込中...'

    try {
      const base64Str = await compressImage(file, 250)
      const card = btn.closest('.card')
      
      const previewContainer = card.querySelector('.photo-preview')
      if (previewContainer) {
        previewContainer.innerHTML = `<img src="${base64Str}" style="width:100%; height:100%; object-fit:cover;">`
      }
      
      const hiddenInput = card.querySelector('input[type="hidden"]')
      if (hiddenInput) {
        hiddenInput.value = base64Str
      }
    } catch (error) {
      console.error('画像処理エラー:', error)
      alert('画像の読み込みに失敗しました。')
    } finally {
      btn.innerText = originalText
    }
  }
  
  fileInput.click()
}

// グローバルに公開（既存のonclick="handleImageSelect(this)"と互換性を保つ）
window.compressImage = compressImage
window.handleImageSelect = handleImageSelect
