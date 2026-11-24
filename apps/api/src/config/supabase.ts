import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Cliente administrativo de Supabase para el Backend.
 * Usa SUPABASE_SERVICE_ROLE_KEY para operar desde webhooks y workers
 * aplicando siempre filtros explícitos por clinic_id.
 */
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
