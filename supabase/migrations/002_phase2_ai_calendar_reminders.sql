-- ============================================================================
-- PULSO AI - SaaS Multi-Tenant para Clínicas en Venezuela
-- Migración 002: Campos de Fase 2 (Google Calendar, IA, Recordatorios)
-- NOTA: No altera ni elimina ninguna política RLS existente de la Fase 1.
-- ============================================================================

-- 1. Ampliar tabla clinics con campos de Google Calendar, WhatsApp Token por clínica,
-- métodos de pago, horarios de atención y prompt adicional
ALTER TABLE public.clinics
  ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT,
  ADD COLUMN IF NOT EXISTS google_calendar_id TEXT NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS google_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS business_hours JSONB NOT NULL DEFAULT '{
    "monday":    { "enabled": true,  "start": "08:00", "end": "17:00" },
    "tuesday":   { "enabled": true,  "start": "08:00", "end": "17:00" },
    "wednesday": { "enabled": true,  "start": "08:00", "end": "17:00" },
    "thursday":  { "enabled": true,  "start": "08:00", "end": "17:00" },
    "friday":    { "enabled": true,  "start": "08:00", "end": "17:00" },
    "saturday":  { "enabled": true,  "start": "09:00", "end": "13:00" },
    "sunday":    { "enabled": false, "start": "09:00", "end": "13:00" }
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS payment_methods TEXT[] NOT NULL DEFAULT ARRAY['Pago Móvil (Tasa BCV)', 'Zelle', 'Efectivo USD', 'Punto de Venta'],
  ADD COLUMN IF NOT EXISTS system_prompt_extra TEXT;

-- 2. Ampliar tabla patients con estado del embudo (lead, booked, active, inactive)
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'lead'
    CHECK (status IN ('lead', 'booked', 'active', 'inactive'));

-- 3. Ampliar tabla conversations con motivo de escalamiento a humano
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS escalation_reason TEXT;

-- 4. Ampliar tabla appointments con banderas de recordatorios 24h y 2h y google_event_id
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS google_event_id TEXT,
  ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reminder_2h_sent BOOLEAN NOT NULL DEFAULT FALSE;

-- Índices parciales para el worker de recordatorios automáticos (cada 15 min)
CREATE INDEX IF NOT EXISTS idx_appointments_reminders_24h
  ON public.appointments(starts_at)
  WHERE status = 'confirmed' AND reminder_24h_sent = FALSE;

CREATE INDEX IF NOT EXISTS idx_appointments_reminders_2h
  ON public.appointments(starts_at)
  WHERE status = 'confirmed' AND reminder_2h_sent = FALSE;
