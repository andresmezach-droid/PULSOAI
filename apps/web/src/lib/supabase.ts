import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    '[PULSO AI Web] Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY en el archivo .env de apps/web.'
  );
}

export const supabase: SupabaseClient = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);

export const API_BASE_URL: string =
  import.meta.env.VITE_API_URL?.replace(/\/$/, '') || 'http://localhost:3001';
