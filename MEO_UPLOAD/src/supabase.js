// src/supabase.js
// Supabase接続クライアント（npmパッケージ版）
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://jgtcqmdpbgqximqlhiyl.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpndGNxbWRwYmdxeGltcWxoaXlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjE1NzgsImV4cCI6MjA5MTE5NzU3OH0.AGAduKEc_INXIQSDoeZQw3In1ctbPQEL_GcMrYYXdrY'

export const supabase = createClient(supabaseUrl, supabaseKey)
