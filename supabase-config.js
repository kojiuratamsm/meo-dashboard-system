// Supabase接続用の設定ファイル
// CDN経由でSupabaseクライアントをインポートして利用します
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

// 先ほど取得していただいた2つの鍵（URLとAPIキー）
const supabaseUrl = 'https://jgtcqmdpbgqximqlhiyl.supabase.co';
const supabaseKey = 'sb_publishable_apUiLddJuF23K3VkxpKiIQ__BD3g4Nx';

// 接続用のクライアントを作成
export const supabase = createClient(supabaseUrl, supabaseKey);
