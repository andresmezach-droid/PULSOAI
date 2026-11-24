-- ============================================================================
-- PULSO AI - SaaS Multi-Tenant para Clínicas en Venezuela
-- Migración 004: Soporte Multimedia (Audios/Capturas), Follow-up 24h y Pagos
-- NOTA: No altera ni elimina ninguna política RLS existente de Fases 1, 2 o 3.
-- ============================================================================

-- 1. Ampliar tabla messages con columnas multimedia y transcripción/resumen de IA
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'text'
    CHECK (media_type IN ('text', 'audio', 'image')),
  ADD COLUMN IF NOT EXISTS media_id TEXT,
  ADD COLUMN IF NOT EXISTS media_transcript TEXT;

-- 2. Ampliar tabla conversations con banderas de follow-up de leads fríos y verificación de pago
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS followup_24h_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_pending_verification BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Índices parciales para optimizar el worker de follow-up cada 30 minutos y filtros del Inbox
CREATE INDEX IF NOT EXISTS idx_conversations_cold_lead_followup
  ON public.conversations(last_message_at)
  WHERE ai_enabled = TRUE AND followup_24h_sent = FALSE;

CREATE INDEX IF NOT EXISTS idx_conversations_payment_pending
  ON public.conversations(clinic_id, payment_pending_verification)
  WHERE payment_pending_verification = TRUE;
