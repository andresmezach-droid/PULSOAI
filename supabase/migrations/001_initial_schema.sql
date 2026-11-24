-- ============================================================================
-- PULSO AI - SaaS Multi-Tenant para Clínicas en Venezuela
-- Migración 001: Esquema Inicial + Índices + Row-Level Security (RLS)
-- ============================================================================

-- Extensiones requeridas
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. FUNCIÓN UTILITARIA PARA ACTUALIZAR updated_at
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 2. TABLAS DEL DOMINIO MULTI-TENANT
-- ============================================================================

-- 2.1 Tabla: clinics (Tenants)
CREATE TABLE IF NOT EXISTS public.clinics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  specialty TEXT NOT NULL DEFAULT 'odontologia' CHECK (specialty IN ('odontologia', 'medicina_estetica', 'ambas')),
  whatsapp_phone_id TEXT NOT NULL UNIQUE,
  whatsapp_waba_id TEXT,
  whatsapp_display_phone TEXT,
  ai_system_prompt TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Caracas',
  currency_mode TEXT NOT NULL DEFAULT 'USD_BCV' CHECK (currency_mode IN ('USD_BCV', 'USD_ONLY', 'VES_ONLY')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_clinics_updated_at
BEFORE UPDATE ON public.clinics
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2.2 Tabla: clinic_users (Vínculo entre auth.users y clinics)
CREATE TABLE IF NOT EXISTS public.clinic_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'receptionist')),
  full_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_clinic_users_clinic_user UNIQUE (clinic_id, user_id)
);

CREATE TRIGGER trg_clinic_users_updated_at
BEFORE UPDATE ON public.clinic_users
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2.3 Tabla: services (Catálogo de tratamientos / servicios por clínica)
CREATE TABLE IF NOT EXISTS public.services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price_usd NUMERIC(10, 2) NOT NULL CHECK (price_usd >= 0),
  duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_services_updated_at
BEFORE UPDATE ON public.services
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2.4 Tabla: patients (Pacientes / Leads de WhatsApp por clínica)
CREATE TABLE IF NOT EXISTS public.patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  full_name TEXT,
  cedula TEXT,
  email TEXT,
  notes TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_patients_clinic_phone UNIQUE (clinic_id, phone)
);

CREATE TRIGGER trg_patients_updated_at
BEFORE UPDATE ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2.5 Tabla: conversations (Hilos de conversación de WhatsApp)
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'human_handoff', 'resolved', 'archived')),
  ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_conversations_clinic_patient UNIQUE (clinic_id, patient_id)
);

CREATE TRIGGER trg_conversations_updated_at
BEFORE UPDATE ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2.6 Tabla: messages (Mensajes individuales de WhatsApp / IA / Agente Humano)
CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  wa_message_id TEXT UNIQUE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('patient', 'ai', 'staff', 'system')),
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'audio', 'document', 'interactive', 'template', 'unknown')),
  content TEXT NOT NULL,
  media_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_by_ai BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2.7 Tabla: appointments (Citas agendadas por IA o Recepcionista)
CREATE TABLE IF NOT EXISTS public.appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  service_id UUID REFERENCES public.services(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show')),
  price_usd NUMERIC(10, 2) CHECK (price_usd >= 0),
  bcv_rate_snapshot NUMERIC(12, 4) CHECK (bcv_rate_snapshot > 0),
  google_calendar_event_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_appointments_time_range CHECK (ends_at > starts_at)
);

CREATE TRIGGER trg_appointments_updated_at
BEFORE UPDATE ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3. ÍNDICES OPTIMIZADOS
-- ============================================================================

-- clinics: búsqueda instantánea en el webhook de Meta por phone_number_id
CREATE INDEX IF NOT EXISTS idx_clinics_whatsapp_phone_id ON public.clinics(whatsapp_phone_id);

-- clinic_users: resolución rápida de membresía en políticas RLS
CREATE INDEX IF NOT EXISTS idx_clinic_users_user_id ON public.clinic_users(user_id);
CREATE INDEX IF NOT EXISTS idx_clinic_users_clinic_id ON public.clinic_users(clinic_id);
CREATE INDEX IF NOT EXISTS idx_clinic_users_user_clinic_active ON public.clinic_users(user_id, clinic_id) WHERE is_active = TRUE;

-- services: filtrado por clínica y estado activo
CREATE INDEX IF NOT EXISTS idx_services_clinic_id ON public.services(clinic_id);
CREATE INDEX IF NOT EXISTS idx_services_clinic_active ON public.services(clinic_id, is_active);

-- patients: búsqueda por clínica y teléfono del paciente
CREATE INDEX IF NOT EXISTS idx_patients_clinic_id ON public.patients(clinic_id);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON public.patients(phone);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_phone ON public.patients(clinic_id, phone);

-- conversations: bandeja de entrada ordenada por último mensaje
CREATE INDEX IF NOT EXISTS idx_conversations_clinic_id ON public.conversations(clinic_id);
CREATE INDEX IF NOT EXISTS idx_conversations_clinic_last_msg ON public.conversations(clinic_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_patient_id ON public.conversations(patient_id);

-- messages: historial de chat y lote de mensajes pendientes para debounce de IA
CREATE INDEX IF NOT EXISTS idx_messages_clinic_id ON public.messages(clinic_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON public.messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_unprocessed_ai ON public.messages(conversation_id, created_at ASC)
  WHERE sender_type = 'patient' AND processed_by_ai = FALSE;

-- appointments: agenda por clínica y rango de fechas
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_id ON public.appointments(clinic_id);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_starts_at ON public.appointments(clinic_id, starts_at ASC);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON public.appointments(patient_id);

-- ============================================================================
-- 4. FUNCIONES HELPER DE SEGURIDAD MULTI-TENANT (SECURITY DEFINER)
-- ============================================================================

-- Verifica si el usuario autenticado (auth.uid()) pertenece activamente a la clínica
CREATE OR REPLACE FUNCTION public.user_has_clinic_access(target_clinic_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clinic_users cu
    WHERE cu.clinic_id = target_clinic_id
      AND cu.user_id = auth.uid()
      AND cu.is_active = TRUE
  );
$$;

-- Verifica si el usuario autenticado es administrador activo de la clínica
CREATE OR REPLACE FUNCTION public.user_is_clinic_admin(target_clinic_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clinic_users cu
    WHERE cu.clinic_id = target_clinic_id
      AND cu.user_id = auth.uid()
      AND cu.role = 'admin'
      AND cu.is_active = TRUE
  );
$$;

-- ============================================================================
-- 5. HABILITACIÓN Y POLÍTICAS DE ROW-LEVEL SECURITY (RLS)
-- ============================================================================
-- Nota: El backend usa SUPABASE_SERVICE_ROLE_KEY que posee privilegio BYPASSRLS.
-- Estas políticas protegen estrictamente el acceso directo desde el frontend
-- con SUPABASE_ANON_KEY + JWT de usuario autenticado.

ALTER TABLE public.clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

-- 5.1 Políticas para: clinics
CREATE POLICY "clinics_select_member"
  ON public.clinics
  FOR SELECT
  TO authenticated
  USING (public.user_has_clinic_access(id));

CREATE POLICY "clinics_update_admin"
  ON public.clinics
  FOR UPDATE
  TO authenticated
  USING (public.user_is_clinic_admin(id))
  WITH CHECK (public.user_is_clinic_admin(id));

-- 5.2 Políticas para: clinic_users
CREATE POLICY "clinic_users_select_member"
  ON public.clinic_users
  FOR SELECT
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id));

CREATE POLICY "clinic_users_insert_admin"
  ON public.clinic_users
  FOR INSERT
  TO authenticated
  WITH CHECK (public.user_is_clinic_admin(clinic_id));

CREATE POLICY "clinic_users_update_admin"
  ON public.clinic_users
  FOR UPDATE
  TO authenticated
  USING (public.user_is_clinic_admin(clinic_id))
  WITH CHECK (public.user_is_clinic_admin(clinic_id));

CREATE POLICY "clinic_users_delete_admin"
  ON public.clinic_users
  FOR DELETE
  TO authenticated
  USING (public.user_is_clinic_admin(clinic_id));

-- 5.3 Políticas para: services
CREATE POLICY "services_select_member"
  ON public.services
  FOR SELECT
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id));

CREATE POLICY "services_insert_admin"
  ON public.services
  FOR INSERT
  TO authenticated
  WITH CHECK (public.user_is_clinic_admin(clinic_id));

CREATE POLICY "services_update_admin"
  ON public.services
  FOR UPDATE
  TO authenticated
  USING (public.user_is_clinic_admin(clinic_id))
  WITH CHECK (public.user_is_clinic_admin(clinic_id));

CREATE POLICY "services_delete_admin"
  ON public.services
  FOR DELETE
  TO authenticated
  USING (public.user_is_clinic_admin(clinic_id));

-- 5.4 Políticas para: patients
CREATE POLICY "patients_select_member"
  ON public.patients
  FOR SELECT
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id));

CREATE POLICY "patients_insert_member"
  ON public.patients
  FOR INSERT
  TO authenticated
  WITH CHECK (public.user_has_clinic_access(clinic_id));

CREATE POLICY "patients_update_member"
  ON public.patients
  FOR UPDATE
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id))
  WITH CHECK (public.user_has_clinic_access(clinic_id));

CREATE POLICY "patients_delete_admin"
  ON public.patients
  FOR DELETE
  TO authenticated
  USING (public.user_is_clinic_admin(clinic_id));

-- 5.5 Políticas para: conversations
CREATE POLICY "conversations_select_member"
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id));

CREATE POLICY "conversations_insert_member"
  ON public.conversations
  FOR INSERT
  TO authenticated
  WITH CHECK (public.user_has_clinic_access(clinic_id));

CREATE POLICY "conversations_update_member"
  ON public.conversations
  FOR UPDATE
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id))
  WITH CHECK (public.user_has_clinic_access(clinic_id));

CREATE POLICY "conversations_delete_admin"
  ON public.conversations
  FOR DELETE
  TO authenticated
  USING (public.user_is_clinic_admin(clinic_id));

-- 5.6 Políticas para: messages
CREATE POLICY "messages_select_member"
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id));

CREATE POLICY "messages_insert_member"
  ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (public.user_has_clinic_access(clinic_id));

CREATE POLICY "messages_update_member"
  ON public.messages
  FOR UPDATE
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id))
  WITH CHECK (public.user_has_clinic_access(clinic_id));

CREATE POLICY "messages_delete_admin"
  ON public.messages
  FOR DELETE
  TO authenticated
  USING (public.user_is_clinic_admin(clinic_id));

-- 5.7 Políticas para: appointments
CREATE POLICY "appointments_select_member"
  ON public.appointments
  FOR SELECT
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id));

CREATE POLICY "appointments_insert_member"
  ON public.appointments
  FOR INSERT
  TO authenticated
  WITH CHECK (public.user_has_clinic_access(clinic_id));

CREATE POLICY "appointments_update_member"
  ON public.appointments
  FOR UPDATE
  TO authenticated
  USING (public.user_has_clinic_access(clinic_id))
  WITH CHECK (public.user_has_clinic_access(clinic_id));

CREATE POLICY "appointments_delete_admin"
  ON public.appointments
  FOR DELETE
  TO authenticated
  USING (public.user_is_clinic_admin(clinic_id));

-- ============================================================================
-- 6. PERMISOS DE TABLA (GRANTS) PARA ROLES DE SUPABASE (authenticated / service_role)
-- ============================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;


