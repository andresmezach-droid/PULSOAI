import { Job, Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { createBullMQRedisConnection } from '../config/redis';
import { supabaseAdmin } from '../config/supabase';
import { sendWhatsAppTemplate } from '../services/whatsapp';
import { decryptNullableToken } from '../utils/crypto';

export const REMINDERS_QUEUE_NAME = 'appointment-reminders';
const REMINDER_CHECK_INTERVAL_MS = 15 * 60 * 1000; // Cada 15 minutos

export interface ReminderScanJobData {
  triggeredAt: string;
}

interface ReminderAppointmentRecord {
  id: string;
  clinic_id: string;
  patient_id: string;
  service_id: string | null;
  starts_at: string;
  status: string;
  reminder_24h_sent: boolean;
  reminder_2h_sent: boolean;
  clinics: {
    id: string;
    name: string;
    whatsapp_phone_id: string;
    whatsapp_access_token: string | null;
    timezone: string;
    is_active: boolean;
  } | null;
  patients: {
    id: string;
    full_name: string | null;
    phone: string;
  } | null;
  services: {
    id: string;
    name: string;
  } | null;
}

const remindersQueueConnection = createBullMQRedisConnection();
const remindersWorkerConnection = createBullMQRedisConnection();

export const remindersQueue = new Queue<ReminderScanJobData>(REMINDERS_QUEUE_NAME, {
  connection: remindersQueueConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
  },
});

/**
 * Formatea fecha y hora de una cita en hora de Venezuela (America/Caracas)
 */
function formatCaracasAppointmentTime(isoString: string, timezone = 'America/Caracas'): {
  dateFormatted: string;
  timeFormatted: string;
} {
  const dateObj = new Date(isoString);

  const dateFormatter = new Intl.DateTimeFormat('es-VE', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const timeFormatter = new Intl.DateTimeFormat('es-VE', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  return {
    dateFormatted: dateFormatter.format(dateObj),
    timeFormatted: timeFormatter.format(dateObj),
  };
}

/**
 * Envía una plantilla de recordatorio (24h o 2h) y actualiza la bandera correspondiente en Supabase.
 */
async function dispatchAppointmentReminder(
  appt: ReminderAppointmentRecord,
  type: '24h' | '2h'
): Promise<void> {
  if (!appt.clinics || !appt.clinics.is_active || !appt.patients) {
    return;
  }

  const clinic = appt.clinics;
  const patient = appt.patients;
  const serviceName = appt.services?.name ?? 'Consulta';
  const patientName = patient.full_name ?? 'Paciente';
  const accessToken =
    decryptNullableToken(clinic.whatsapp_access_token) || env.META_SYSTEM_ACCESS_TOKEN;

  const { dateFormatted, timeFormatted } = formatCaracasAppointmentTime(
    appt.starts_at,
    clinic.timezone || 'America/Caracas'
  );

  const templateName =
    type === '24h' ? 'appointment_reminder_24h' : 'appointment_reminder_2h';

  const components: unknown[] = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: patientName },
        { type: 'text', text: clinic.name },
        { type: 'text', text: serviceName },
        { type: 'text', text: dateFormatted },
        { type: 'text', text: timeFormatted },
      ],
    },
  ];

  await sendWhatsAppTemplate(
    clinic.whatsapp_phone_id,
    accessToken,
    patient.phone,
    templateName,
    'es',
    components
  );

  const updateField =
    type === '24h' ? { reminder_24h_sent: true } : { reminder_2h_sent: true };

  const { error } = await supabaseAdmin
    .from('appointments')
    .update(updateField)
    .eq('id', appt.id)
    .eq('clinic_id', appt.clinic_id);

  if (error) {
    console.error(
      `[RemindersWorker] Error actualizando bandera ${type} para cita ${appt.id}:`,
      error.message
    );
  } else {
    console.info(
      `[RemindersWorker] Recordatorio ${type} enviado con éxito para cita ${appt.id} (${patient.phone})`
    );
  }
}

/**
 * Escanea citas `confirmed` próximas a 24 horas o 2 horas y envía la plantilla de WhatsApp correspondiente.
 */
async function scanAndSendReminders(): Promise<void> {
  const nowMs = Date.now();

  // Ventana para recordatorio de 24h: entre +23h y +24h30m desde ahora
  const window24hStartIso = new Date(nowMs + 23 * 60 * 60 * 1000).toISOString();
  const window24hEndIso = new Date(nowMs + 24.5 * 60 * 60 * 1000).toISOString();

  // Ventana para recordatorio de 2h: entre +1h30m y +2h30m desde ahora
  const window2hStartIso = new Date(nowMs + 1.5 * 60 * 60 * 1000).toISOString();
  const window2hEndIso = new Date(nowMs + 2.5 * 60 * 60 * 1000).toISOString();

  const selectQuery = `
    id,
    clinic_id,
    patient_id,
    service_id,
    starts_at,
    status,
    reminder_24h_sent,
    reminder_2h_sent,
    clinics ( id, name, whatsapp_phone_id, whatsapp_access_token, timezone, is_active ),
    patients ( id, full_name, phone ),
    services ( id, name )
  `;

  // 1. Buscar citas confirmed para recordatorio de 24 horas
  const { data: due24h, error: err24h } = await supabaseAdmin
    .from('appointments')
    .select(selectQuery)
    .eq('status', 'confirmed')
    .eq('reminder_24h_sent', false)
    .gte('starts_at', window24hStartIso)
    .lte('starts_at', window24hEndIso)
    .returns<ReminderAppointmentRecord[]>();

  if (err24h) {
    console.error('[RemindersWorker] Error consultando citas 24h:', err24h.message);
  } else if (due24h && due24h.length > 0) {
    for (const appt of due24h) {
      try {
        await dispatchAppointmentReminder(appt, '24h');
      } catch (err) {
        console.error(
          `[RemindersWorker] Falló envío de recordatorio 24h para cita ${appt.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  // 2. Buscar citas confirmed para recordatorio de 2 horas
  const { data: due2h, error: err2h } = await supabaseAdmin
    .from('appointments')
    .select(selectQuery)
    .eq('status', 'confirmed')
    .eq('reminder_2h_sent', false)
    .gte('starts_at', window2hStartIso)
    .lte('starts_at', window2hEndIso)
    .returns<ReminderAppointmentRecord[]>();

  if (err2h) {
    console.error('[RemindersWorker] Error consultando citas 2h:', err2h.message);
  } else if (due2h && due2h.length > 0) {
    for (const appt of due2h) {
      try {
        await dispatchAppointmentReminder(appt, '2h');
      } catch (err) {
        console.error(
          `[RemindersWorker] Falló envío de recordatorio 2h para cita ${appt.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
}

/**
 * Worker de BullMQ para ejecutar el escaneo de recordatorios automáticos
 */
export const remindersWorker = new Worker<ReminderScanJobData>(
  REMINDERS_QUEUE_NAME,
  async (_job: Job<ReminderScanJobData>) => {
    await scanAndSendReminders();
  },
  {
    connection: remindersWorkerConnection,
    concurrency: 1,
  }
);

remindersWorker.on('failed', (job: Job<ReminderScanJobData> | undefined, err: Error) => {
  console.error(`[RemindersWorker] Job fallido (${job?.id ?? 'unknown'}):`, err.message);
});

/**
 * Programa el job repetitivo en BullMQ cada 15 minutos al iniciar el servidor
 */
export async function scheduleRecurringRemindersJob(): Promise<void> {
  await remindersQueue.add(
    'scan-upcoming-appointments',
    {
      triggeredAt: new Date().toISOString(),
    },
    {
      jobId: 'recurring-reminders-15m',
      repeat: {
        every: REMINDER_CHECK_INTERVAL_MS,
      },
    }
  );
  console.info('⏰ [RemindersWorker] Job repetitivo de recordatorios registrado (cada 15 minutos).');
}
