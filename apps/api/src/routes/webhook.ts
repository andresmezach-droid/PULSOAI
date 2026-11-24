import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { supabaseAdmin } from '../config/supabase';
import {
  ClinicRow,
  ConversationRow,
  MessageMediaType,
  MessageType,
  PatientRow,
} from '../types/database';
import { enqueueConversationDebounce } from '../workers/messageQueue';

export const webhookRouter = Router();

/**
 * Extiende Request de Express para acceder a rawBody capturado en express.json({ verify })
 */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Esquema Zod para validar el payload entrante de Meta WhatsApp Cloud API (v21.0)
 */
const metaWebhookMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z
    .object({
      body: z.string(),
    })
    .optional(),
  image: z
    .object({
      id: z.string(),
      caption: z.string().optional(),
      mime_type: z.string().optional(),
    })
    .optional(),
  audio: z
    .object({
      id: z.string(),
      mime_type: z.string().optional(),
    })
    .optional(),
  document: z
    .object({
      id: z.string(),
      filename: z.string().optional(),
      caption: z.string().optional(),
      mime_type: z.string().optional(),
    })
    .optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z
        .object({
          id: z.string(),
          title: z.string(),
        })
        .optional(),
      list_reply: z
        .object({
          id: z.string(),
          title: z.string(),
          description: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const metaWebhookContactSchema = z.object({
  wa_id: z.string(),
  profile: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
});

const metaWebhookValueSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({
    display_phone_number: z.string(),
    phone_number_id: z.string(),
  }),
  contacts: z.array(metaWebhookContactSchema).optional(),
  messages: z.array(metaWebhookMessageSchema).optional(),
});

const metaWebhookPayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: metaWebhookValueSchema,
        })
      ),
    })
  ),
});

type MetaWebhookPayload = z.infer<typeof metaWebhookPayloadSchema>;
type MetaWebhookMessage = z.infer<typeof metaWebhookMessageSchema>;

/**
 * Valida la firma X-Hub-Signature-256 enviada por Meta usando HMAC-SHA256 y timingSafeEqual
 */
function verifyMetaSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
  if (!rawBody || !signatureHeader) {
    return false;
  }

  const [algorithm, receivedHex] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !receivedHex) {
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha256', env.META_APP_SECRET)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedHex, 'hex');
  const receivedBuffer = Buffer.from(receivedHex, 'hex');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Extrae el texto legible, mediaType, mediaId y el tipo normalizado de un mensaje de WhatsApp
 */
function extractMessageContent(msg: MetaWebhookMessage): {
  messageType: MessageType;
  mediaType: MessageMediaType;
  mediaId: string | null;
  content: string;
  metadata: Record<string, unknown>;
} {
  switch (msg.type) {
    case 'text':
      return {
        messageType: 'text',
        mediaType: 'text',
        mediaId: null,
        content: msg.text?.body?.trim() ?? '',
        metadata: { timestamp: msg.timestamp },
      };

    case 'interactive': {
      const replyTitle =
        msg.interactive?.button_reply?.title ??
        msg.interactive?.list_reply?.title ??
        '[Respuesta interactiva]';
      const replyId =
        msg.interactive?.button_reply?.id ??
        msg.interactive?.list_reply?.id ??
        null;
      return {
        messageType: 'interactive',
        mediaType: 'text',
        mediaId: null,
        content: replyTitle,
        metadata: {
          timestamp: msg.timestamp,
          interactive_type: msg.interactive?.type,
          reply_id: replyId,
        },
      };
    }

    case 'image':
      return {
        messageType: 'image',
        mediaType: 'image',
        mediaId: msg.image?.id ?? null,
        content: msg.image?.caption?.trim() || '[Imagen / Comprobante recibido]',
        metadata: {
          timestamp: msg.timestamp,
          media_id: msg.image?.id,
          mime_type: msg.image?.mime_type,
          caption: msg.image?.caption,
        },
      };

    case 'audio':
      return {
        messageType: 'audio',
        mediaType: 'audio',
        mediaId: msg.audio?.id ?? null,
        content: '[Nota de voz recibida]',
        metadata: {
          timestamp: msg.timestamp,
          media_id: msg.audio?.id,
          mime_type: msg.audio?.mime_type,
        },
      };

    case 'document':
      return {
        messageType: 'document',
        mediaType: 'text',
        mediaId: msg.document?.id ?? null,
        content: msg.document?.caption ?? `[Documento: ${msg.document?.filename ?? 'archivo'}]`,
        metadata: {
          timestamp: msg.timestamp,
          media_id: msg.document?.id,
          filename: msg.document?.filename,
          mime_type: msg.document?.mime_type,
        },
      };

    default:
      return {
        messageType: 'unknown',
        mediaType: 'text',
        mediaId: null,
        content: `[Mensaje de tipo ${msg.type}]`,
        metadata: {
          timestamp: msg.timestamp,
          raw_type: msg.type,
        },
      };
  }
}

/**
 * Procesa de forma asíncrona el payload validado de WhatsApp Cloud API
 */
async function processWebhookPayloadAsync(payload: MetaWebhookPayload): Promise<void> {
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        continue;
      }

      const value = change.value;
      const messages = value.messages;
      if (!messages || messages.length === 0) {
        // Evento de estado (delivered, read, sent) sin mensajes entrantes
        continue;
      }

      const phoneNumberId = value.metadata.phone_number_id;

      // 1. Identificar la clínica por metadata.phone_number_id
      const { data: clinic, error: clinicError } = await supabaseAdmin
        .from('clinics')
        .select('id, name, is_active')
        .eq('whatsapp_phone_id', phoneNumberId)
        .single<Pick<ClinicRow, 'id' | 'name' | 'is_active'>>();

      if (clinicError || !clinic) {
        console.warn(
          `[Webhook] No se encontró clínica registrada para phone_number_id=${phoneNumberId}`
        );
        continue;
      }

      if (!clinic.is_active) {
        console.warn(
          `[Webhook] Clínica ${clinic.name} (${clinic.id}) está inactiva. Ignorando mensajes.`
        );
        continue;
      }

      // Mapa de nombres de perfil por wa_id enviados en el contacto
      const contactNames = new Map<string, string>();
      if (value.contacts) {
        for (const contact of value.contacts) {
          if (contact.profile?.name) {
            contactNames.set(contact.wa_id, contact.profile.name);
          }
        }
      }

      for (const waMsg of messages) {
        const patientPhone = waMsg.from;
        const profileName = contactNames.get(patientPhone) ?? null;

        // 2. Crear o recuperar el patient (upsert por clinic_id + phone)
        const { data: existingPatient } = await supabaseAdmin
          .from('patients')
          .select('id, clinic_id, phone, full_name')
          .eq('clinic_id', clinic.id)
          .eq('phone', patientPhone)
          .maybeSingle<Pick<PatientRow, 'id' | 'clinic_id' | 'phone' | 'full_name'>>();

        let patientId: string;

        if (existingPatient) {
          patientId = existingPatient.id;
          // Si no tenía nombre guardado y WhatsApp provee profile.name, lo actualizamos
          if (!existingPatient.full_name && profileName) {
            await supabaseAdmin
              .from('patients')
              .update({ full_name: profileName })
              .eq('id', existingPatient.id)
              .eq('clinic_id', clinic.id);
          }
        } else {
          const { data: createdPatient, error: createPatientErr } = await supabaseAdmin
            .from('patients')
            .insert({
              clinic_id: clinic.id,
              phone: patientPhone,
              full_name: profileName,
            })
            .select('id')
            .single<Pick<PatientRow, 'id'>>();

          if (createPatientErr || !createdPatient) {
            console.error(
              `[Webhook] Error creando paciente (${patientPhone}) en clínica ${clinic.id}:`,
              createPatientErr?.message
            );
            continue;
          }
          patientId = createdPatient.id;
        }

        // 3. Crear o recuperar la conversation (única por clinic_id + patient_id)
        const { data: conversation, error: convErr } = await supabaseAdmin
          .from('conversations')
          .upsert(
            {
              clinic_id: clinic.id,
              patient_id: patientId,
            },
            {
              onConflict: 'clinic_id,patient_id',
            }
          )
          .select('id, clinic_id, patient_id, ai_enabled, unread_count')
          .single<Pick<ConversationRow, 'id' | 'clinic_id' | 'patient_id' | 'ai_enabled' | 'unread_count'>>();

        if (convErr || !conversation) {
          console.error(
            `[Webhook] Error obteniendo/creando conversación para paciente ${patientId}:`,
            convErr?.message
          );
          continue;
        }

        // 4. Guardar el mensaje en messages (ignorando duplicados por wa_message_id)
        const { messageType, mediaType, mediaId, content, metadata } =
          extractMessageContent(waMsg);

        const { data: insertedMsg, error: insertMsgErr } = await supabaseAdmin
          .from('messages')
          .upsert(
            {
              clinic_id: clinic.id,
              conversation_id: conversation.id,
              wa_message_id: waMsg.id,
              sender_type: 'patient',
              message_type: messageType,
              media_type: mediaType,
              media_id: mediaId,
              content,
              metadata,
              processed_by_ai: false,
            },
            {
              onConflict: 'wa_message_id',
              ignoreDuplicates: true,
            }
          )
          .select('id')
          .maybeSingle<{ id: string }>();

        if (insertMsgErr) {
          console.error(
            `[Webhook] Error guardando mensaje wa_message_id=${waMsg.id}:`,
            insertMsgErr.message
          );
          continue;
        }

        if (!insertedMsg) {
          // Si ignoreDuplicates actuó, insertedMsg es null -> mensaje duplicado de Meta
          console.info(`[Webhook] Mensaje duplicado ignorado: wa_message_id=${waMsg.id}`);
          continue;
        }

        // Actualizar metadatos de la conversación (último mensaje y contador de no leídos)
        await supabaseAdmin
          .from('conversations')
          .update({
            last_message_at: new Date().toISOString(),
            last_message_preview: content.slice(0, 160),
            unread_count: conversation.unread_count + 1,
          })
          .eq('id', conversation.id)
          .eq('clinic_id', clinic.id);

        // 5. Disparar debounce de 6 segundos en BullMQ
        await enqueueConversationDebounce(clinic.id, conversation.id);
      }
    }
  }
}

/**
 * GET /webhook
 * Verificación estándar del Webhook de Meta (hub.mode, hub.verify_token, hub.challenge)
 */
webhookRouter.get('/', (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN && typeof challenge === 'string') {
    console.info('[Webhook] Verificación GET de Meta exitosa.');
    res.status(200).type('text/plain').send(challenge);
    return;
  }

  console.warn('[Webhook] Falló verificación GET de Meta: Token o modo inválido.');
  res.status(403).json({ error: 'Verification failed: Invalid verify_token or mode' });
});

/**
 * POST /webhook
 * Recepción de eventos de WhatsApp Cloud API con verificación HMAC-SHA256 obligatoria
 */
webhookRouter.post('/', (req: RawBodyRequest, res: Response): void => {
  const signatureHeader = req.header('X-Hub-Signature-256');

  if (!verifyMetaSignature(req.rawBody, signatureHeader)) {
    console.warn('[Webhook] Rechazado POST /webhook: Firma X-Hub-Signature-256 inválida o ausente.');
    res.status(401).json({ error: 'Invalid X-Hub-Signature-256' });
    return;
  }

  // Responder 200 OK inmediatamente para evitar reintentos de Meta
  res.status(200).json({ received: true });

  // Validar estructura del payload y procesar asíncronamente en background
  const parsedPayload = metaWebhookPayloadSchema.safeParse(req.body);
  if (!parsedPayload.success) {
    console.warn('[Webhook] Payload recibido no coincide con esquema de WhatsApp messages:', parsedPayload.error.flatten());
    return;
  }

  void processWebhookPayloadAsync(parsedPayload.data).catch((err: unknown) => {
    console.error('[Webhook] Error no controlado en procesamiento asíncrono:', err);
  });
});
