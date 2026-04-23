// Supabase接続用の設定ファイル
// CDN経由でSupabaseクライアントをインポートして利用します
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

// 先ほど取得していただいた2つの鍵（URLとAPIキー）
const supabaseUrl = 'https://jgtcqmdpbgqximqlhiyl.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpndGNxbWRwYmdxeGltcWxoaXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjE1NzgsImV4cCI6MjA5MTE5NzU3OH0.AGAduKEc_INXIQSDoeZQw3In1ctbPQEL_GcMrYYXdrY';

// 接続用のクライアントを作成
export const supabase = createClient(supabaseUrl, supabaseKey);
