import { createClient, SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://irtawkxxqxmedihyhcim.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'sb_publishable_ozNt4Dc5fom0l704OFiqrA_0G3XoH6r';

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL;
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || DEFAULT_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseAnonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);

export const API_BASE_URL: string =
  import.meta.env.VITE_API_URL?.replace(/\/$/, '') || 'http://localhost:3001';
