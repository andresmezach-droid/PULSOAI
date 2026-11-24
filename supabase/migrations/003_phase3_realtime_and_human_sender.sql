-- ============================================================================
-- PULSO AI - SaaS Multi-Tenant para Clínicas en Venezuela
-- Migración 003: Soporte de sender_type 'human' y Realtime en messages/conversations
-- NOTA: No altera ni elimina ninguna política RLS existente de Fase 1 o Fase 2.
-- ============================================================================

-- 1. Ampliar CHECK constraint de sender_type en messages para permitir 'human' (además de 'patient', 'ai', 'staff', 'system')
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_sender_type_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_type_check
  CHECK (sender_type IN ('patient', 'ai', 'human', 'staff', 'system'));

-- 2. Habilitar replicación en Supabase Realtime para messages y conversations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  END IF;
END
$$;
