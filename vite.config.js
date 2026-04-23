import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  // Multi-Page App: 全HTMLファイルをエントリーポイントとして登録
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        masterLogin: resolve(__dirname, 'master-login.html'),
        masterDashboard: resolve(__dirname, 'master-dashboard.html'),
        signupA: resolve(__dirname, 'signup-a.html'),
        signupB: resolve(__dirname, 'signup-b.html'),
        signupC: resolve(__dirname, 'signup-c.html'),
        reserve: resolve(__dirname, 'reserve.html'),
        surveyMockup: resolve(__dirname, 'survey-mockup.html'),
      }
    }
  },
  // 開発サーバーの設定
  server: {
    port: 3000,
    open: true
  }
})
