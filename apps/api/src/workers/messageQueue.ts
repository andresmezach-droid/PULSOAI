import { Job, Queue, Worker } from 'bullmq';
import { createBullMQRedisConnection } from '../config/redis';
import { supabaseAdmin } from '../config/supabase';
import { processConversation } from '../services/aiAgent';
import { ConversationRow, MessageRow } from '../types/database';

export const INCOMING_MESSAGES_QUEUE_NAME = 'incoming-messages';
const DEBOUNCE_DELAY_MS = Number(process.env['DEBOUNCE_DELAY_MS'] ?? 2000); // 2 segundos para respuesta ultrarrápida

export interface ConversationDebounceJobData {
  clinicId: string;
  conversationId: string;
  enqueuedAt: string;
}

const queueConnection = createBullMQRedisConnection();
const workerConnection = createBullMQRedisConnection();

/**
 * Cola BullMQ para agrupar mensajes entrantes por conversación
 */
export const incomingMessagesQueue = new Queue<ConversationDebounceJobData>(
  INCOMING_MESSAGES_QUEUE_NAME,
  {
    connection: queueConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  }
);

/**
 * Encola o reinicia el temporizador de debounce (6 segundos) para una conversación.
 * Si el paciente envía varios mensajes seguidos ("Hola", "Quiero saber precios", "De limpieza dental"),
 * el job anterior (`debounce:${conversationId}`) se elimina y se crea uno nuevo con delay de 6000 ms.
 */
export async function enqueueConversationDebounce(
  clinicId: string,
  conversationId: string
): Promise<void> {
  // BullMQ v5 prohíbe el carácter ':' en custom jobId
  const jobId = `debounce-${conversationId}`;

  const existingJob = await incomingMessagesQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    // Si el job está en delay, esperando, completado o fallido, lo removemos
    // para que BullMQ permita crear el nuevo job con el mismo jobId y delay de 6s.
    if (
      state === 'delayed' ||
      state === 'waiting' ||
      state === 'waiting-children' ||
      state === 'completed' ||
      state === 'failed'
    ) {
      await existingJob.remove().catch(() => undefined);
    }
  }

  await incomingMessagesQueue.add(
    'process-conversation-batch',
    {
      clinicId,
      conversationId,
      enqueuedAt: new Date().toISOString(),
    },
    {
      jobId,
      delay: DEBOUNCE_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

/**
 * Worker de BullMQ que se ejecuta cuando transcurren 6 segundos sin nuevos mensajes en la conversación.
 */
export const incomingMessagesWorker = new Worker<ConversationDebounceJobData>(
  INCOMING_MESSAGES_QUEUE_NAME,
  async (job: Job<ConversationDebounceJobData>) => {
    const { clinicId, conversationId } = job.data;

    // 1. Verificar estado de la conversación y flag ai_enabled
    const { data: conversation, error: convError } = await supabaseAdmin
      .from('conversations')
      .select('id, clinic_id, patient_id, status, ai_enabled')
      .eq('id', conversationId)
      .eq('clinic_id', clinicId)
      .single<Pick<ConversationRow, 'id' | 'clinic_id' | 'patient_id' | 'status' | 'ai_enabled'>>();

    if (convError || !conversation) {
      throw new Error(
        `[DebounceWorker] No se encontró la conversación ${conversationId} para la clínica ${clinicId}: ${convError?.message ?? 'Null record'}`
      );
    }

    if (conversation.ai_enabled !== true || conversation.status === 'human_handoff') {
      console.info(
        `[DebounceWorker] IA desactivada o en handoff humano para conversación ${conversationId}. Omitiendo respuesta automática.`
      );
      return;
    }

    // 2. Obtener todos los mensajes del paciente aún no procesados por la IA
    const { data: unprocessedMessages, error: msgError } = await supabaseAdmin
      .from('messages')
      .select('id, clinic_id, conversation_id, wa_message_id, sender_type, message_type, content, media_url, metadata, processed_by_ai, created_at')
      .eq('clinic_id', clinicId)
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'patient')
      .eq('processed_by_ai', false)
      .order('created_at', { ascending: true })
      .returns<MessageRow[]>();

    if (msgError) {
      throw new Error(
        `[DebounceWorker] Error leyendo mensajes no procesados en conversación ${conversationId}: ${msgError.message}`
      );
    }

    if (!unprocessedMessages || unprocessedMessages.length === 0) {
      console.info(
        `[DebounceWorker] No hay mensajes pendientes por procesar en conversación ${conversationId}.`
      );
      return;
    }

    const combinedText = unprocessedMessages.map((m) => m.content).join('\n');
    console.info(
      `[DebounceWorker] Procesando lote de ${unprocessedMessages.length} mensaje(s) para clínica=${clinicId}, conversación=${conversationId}:\n"${combinedText}"`
    );

    // 3. Invocar motor de IA con Function Calling únicamente cuando conversations.ai_enabled === true
    if (conversation.ai_enabled === true) {
      await processConversation(clinicId, conversationId);
    }
  },
  {
    connection: workerConnection,
    concurrency: 10,
  }
);

incomingMessagesWorker.on('completed', (job: Job<ConversationDebounceJobData>) => {
  console.info(`[DebounceWorker] Job completado: ${job.id}`);
});

incomingMessagesWorker.on('failed', (job: Job<ConversationDebounceJobData> | undefined, err: Error) => {
  console.error(`[DebounceWorker] Job fallido (${job?.id ?? 'unknown'}):`, err.message);
});
