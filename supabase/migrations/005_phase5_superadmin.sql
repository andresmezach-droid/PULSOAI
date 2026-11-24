-- ============================================================================
-- PULSO AI - SaaS Multi-Tenant para Clínicas en Venezuela
-- Migración 005: Tabla platform_admins (Super-Admin de Plataforma) + RLS
-- NOTA: No altera ni elimina ninguna política RLS existente de Fases 1 a 4.
-- ============================================================================

-- 1. Tabla platform_admins: usuarios con privilegios globales de Super-Admin
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Habilitar Row-Level Security (RLS)
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- 3. Política RLS: Un usuario autenticado solo puede leer su propia fila
--    (permite que apps/web verifique si debe mostrar el menú Super-Admin)
DROP POLICY IF EXISTS "platform_admins_select_self" ON public.platform_admins;
CREATE POLICY "platform_admins_select_self"
  ON public.platform_admins
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- 4. Permisos de tabla (GRANT) para roles de Supabase
GRANT SELECT ON public.platform_admins TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_admins TO service_role;
