import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  // Multi-Page App: 公開するHTMLファイルをエントリーポイントとして登録
  // ※2026/11/17:提供しないサービス(運用代行プラン・MapOn・MapOn(モニター))の画面は、公開しない(本番に置かない)。
  //   旧ダッシュボード(index.html)・予約ページ(reserve.html)・申し込みフォーム(signup-a/b/c.html)・旧アンケート見本(survey-mockup.html)
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'landing.html'),
        login: resolve(__dirname, 'login.html'),
        masterLogin: resolve(__dirname, 'master-login.html'),
        masterDashboard: resolve(__dirname, 'master-dashboard.html'),
        resetPassword: resolve(__dirname, 'reset-password.html'),
        masterSurveys: resolve(__dirname, 'master-surveys.html'),
        survey: resolve(__dirname, 'survey.html'),
        coupon: resolve(__dirname, 'coupon.html'),
        card: resolve(__dirname, 'card.html'),
        neo: resolve(__dirname, 'neo.html'),
        signupNeo: resolve(__dirname, 'signup-neo.html'),
        media: resolve(__dirname, 'media.html'),
        mediaLogin: resolve(__dirname, 'media-login.html'),
        mediaAdmin: resolve(__dirname, 'media-admin.html')
      }
    }
  },
  // 開発サーバーの設定
  server: {
    port: 3000,
    open: true
  }
})
