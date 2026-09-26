// msm-config.js
// MSM管理画面(自社管理サイト)の Supabase への接続設定。
// MapOnメディアで記事を公開したとき、MSM管理画面の「MEO対策チャンネル」の店舗のブログ履歴に記録するために使う。
//
// 【設定方法】下の MSM_SUPABASE_KEY の '' の中に、自社管理サイトの js/state.js の 6行目
//   const supabaseKey = '……';  の '……' の部分(eyJ で始まる長い文字列)をそのまま貼り付けてください。
//   ※ブラウザ用の公開キー(anon key)です。

export const MSM_SUPABASE_URL = 'https://xztaacxjlluzqzehendp.supabase.co';
export const MSM_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh6dGFhY3hqbGx1enF6ZWhlbmRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMzM4NzMsImV4cCI6MjA4OTgwOTg3M30.79wvIPepXjvPZwLHOPX7KullShvdvCB7LS2gZO5CtuQ';
