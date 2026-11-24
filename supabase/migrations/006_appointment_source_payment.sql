-- ============================================================================
-- PULSO AI - SaaS Multi-Tenant para Clínicas en Venezuela
-- Migración 006: Origen de cita (source) y Estado de pago (payment_status)
-- NOTA: No altera políticas RLS ni modifica la lógica del backend calendar.ts
-- ============================================================================

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ai'
    CHECK (source IN ('ai', 'manual')),
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'partial', 'paid'));

CREATE INDEX IF NOT EXISTS idx_appointments_clinic_payment_status
  ON public.appointments(clinic_id, payment_status);
