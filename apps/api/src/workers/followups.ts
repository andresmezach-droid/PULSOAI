import { Job, Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { createBullMQRedisConnection } from '../config/redis';
import { supabaseAdmin } from '../config/supabase';
import { sendWhatsAppText } from '../services/whatsapp';
import { decryptNullableToken } from '../utils/crypto';

export const FOLLOWUPS_QUEUE_NAME = 'cold-lead-followups';
const FOLLOWUP_CHECK_INTERVAL_MS = 30 * 60 * 1000; // Cada 30 minutos

export interface FollowupScanJobData {
  triggeredAt: string;
}

interface ColdLeadConversationRecord {
  id: string;
  clinic_id: string;
  patient_id: string;
  ai_enabled: boolean;
  followup_24h_sent: boolean;
  last_message_at: string;
  clinics: {
    id: string;
    name: string;
    whatsapp_phone_id: string;
    whatsapp_access_token: string | null;
    is_active: boolean;
  } | null;
  patients: {
    id: string;
    full_name: string | null;
    phone: string;
    status: string;
  } | null;
}

const followupsQueueConnection = createBullMQRedisConnection();
const followupsWorkerConnection = createBullMQRedisConnection();

export const followupsQueue = new Queue<FollowupScanJobData>(
  FOLLOWUPS_QUEUE_NAME,
  {
    connection: followupsQueueConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 50,
    },
  }
);

/**
 * Escanea conversaciones activas para seguimiento de Leads Fríos:
 * - `patients.status = 'lead'` (no ha agendado cita)
 * - `conversations.ai_enabled = true`
 * - `conversations.followup_24h_sent = false`
 * - Han transcurrido entre 20 y 23 horas desde el último mensaje del paciente
 *   (aprovechando la ventana gratuita de 24h de WhatsApp sin costo de plantilla HSM).
 */
async function scanAndSendColdLeadFollowups(): Promise<void> {
  const nowMs = Date.now();

  // Entre 20h y 23h atrás desde ahora:
  // olderBound (hace 23 horas) <= last_message_at <= newerBound (hace 20 horas)
  const twentyThreeHoursAgoIso = new Date(
    nowMs - 23 * 60 * 60 * 1000
  ).toISOString();
  const twentyHoursAgoIso = new Date(nowMs - 20 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabaseAdmin
    .from('conversations')
    .select(
      `
      id,
      clinic_id,
      patient_id,
      ai_enabled,
      followup_24h_sent,
      last_message_at,
      clinics ( id, name, whatsapp_phone_id, whatsapp_access_token, is_active ),
      patients!inner ( id, full_name, phone, status )
    `
    )
    .eq('ai_enabled', true)
    .eq('followup_24h_sent', false)
    .eq('patients.status', 'lead')
    .gte('last_message_at', twentyThreeHoursAgoIso)
    .lte('last_message_at', twentyHoursAgoIso)
    .returns<ColdLeadConversationRecord[]>();

  if (error) {
    console.error(
      '[FollowupsWorker] Error consultando conversaciones para follow-up:',
      error.message
    );
    return;
  }

  if (!candidates || candidates.length === 0) {
    return;
  }

  for (const conv of candidates) {
    if (!conv.clinics || !conv.clinics.is_active || !conv.patients) {
      continue;
    }

    if (conv.patients.status !== 'lead') {
      continue;
    }

    // Verificar que exista al menos un mensaje del paciente en la ventana de 20-23h
    const { data: lastPatientMsg } = await supabaseAdmin
      .from('messages')
      .select('id, created_at')
      .eq('conversation_id', conv.id)
      .eq('clinic_id', conv.clinic_id)
      .eq('sender_type', 'patient')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; created_at: string }>();

    if (!lastPatientMsg) {
      continue;
    }

    const patientMsgAgeHours =
      (nowMs - new Date(lastPatientMsg.created_at).getTime()) / (60 * 60 * 1000);

    if (patientMsgAgeHours < 20 || patientMsgAgeHours > 23.5) {
      continue;
    }

    const clinic = conv.clinics;
    const patient = conv.patients;
    const firstName = patient.full_name?.trim().split(' ')[0] || '';
    const greeting = firstName ? `¡Hola ${firstName}!` : '¡Hola!';
    const followupText = `${greeting} Te escribimos de ${clinic.name}. ¿Te quedó alguna duda sobre el tratamiento o quieres que revisemos los horarios disponibles para esta semana?`;

    const accessToken =
      decryptNullableToken(clinic.whatsapp_access_token) ||
      env.META_SYSTEM_ACCESS_TOKEN;

    let waMessageId: string | null = null;
    let whatsappDeliveryError: string | null = null;

    try {
      const sendRes = await sendWhatsAppText(
        clinic.whatsapp_phone_id,
        accessToken,
        patient.phone,
        followupText
      );
      waMessageId = sendRes.waMessageId;
    } catch (waErr) {
      whatsappDeliveryError =
        waErr instanceof Error
          ? waErr.message
          : 'Error enviando follow-up a Meta Cloud API';
      console.warn(
        `[FollowupsWorker] No se pudo entregar a Meta Cloud API (guardando igualmente en DB): ${whatsappDeliveryError}`
      );
    }

    const nowIso = new Date().toISOString();

    await Promise.all([
      supabaseAdmin.from('messages').insert({
        clinic_id: conv.clinic_id,
        conversation_id: conv.id,
        wa_message_id: waMessageId,
        sender_type: 'ai',
        message_type: 'text',
        media_type: 'text',
        content: followupText,
        metadata: {
          followup_24h: true,
          ...(whatsappDeliveryError
            ? { whatsapp_delivery_error: whatsappDeliveryError }
            : {}),
        },
        processed_by_ai: true,
      }),
      supabaseAdmin
        .from('conversations')
        .update({
          followup_24h_sent: true,
          last_message_at: nowIso,
          last_message_preview: followupText.slice(0, 160),
        })
        .eq('id', conv.id)
        .eq('clinic_id', conv.clinic_id),
    ]);

    console.info(
      `[FollowupsWorker] Follow-up enviado con éxito a lead ${patient.phone} (conversación ${conv.id})`
    );
  }
}

export const followupsWorker = new Worker<FollowupScanJobData>(
  FOLLOWUPS_QUEUE_NAME,
  async (_job: Job<FollowupScanJobData>) => {
    await scanAndSendColdLeadFollowups();
  },
  {
    connection: followupsWorkerConnection,
    concurrency: 1,
  }
);

followupsWorker.on(
  'failed',
  (job: Job<FollowupScanJobData> | undefined, err: Error) => {
    console.error(
      `[FollowupsWorker] Job fallido (${job?.id ?? 'unknown'}):`,
      err.message
    );
  }
);

/**
 * Programa el job repetitivo de Follow-up de Leads Fríos cada 30 minutos
 */
export async function scheduleRecurringFollowupsJob(): Promise<void> {
  await followupsQueue.add(
    'scan-cold-leads-20h-23h',
    {
      triggeredAt: new Date().toISOString(),
    },
    {
      jobId: 'recurring-cold-leads-followup-30m',
      repeat: {
        every: FOLLOWUP_CHECK_INTERVAL_MS,
      },
    }
  );
  console.info(
    '🧲 [FollowupsWorker] Job repetitivo de follow-up de leads fríos registrado (cada 30 minutos).'
  );
}
