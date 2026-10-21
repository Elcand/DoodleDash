import 'url-polyfill';
import { createClient } from '@supabase/supabase-js';

// Ganti nilai di bawah dengan credentials dari Supabase Project Settings > API
const SUPABASE_URL = 'https://jmliptdugztdcknhwool.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'sb_publishable_77cGCXvis-cBoo3oEQK2cA_rW_3uTXd';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
  },
});