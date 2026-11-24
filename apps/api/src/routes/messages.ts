import { Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { supabaseAdmin } from '../config/supabase';
import { AuthenticatedRequest, requireClinicAuth } from '../middleware/auth';
import { sendWhatsAppText } from '../services/whatsapp';
import {
  ClinicRow,
  ConversationRow,
  MessageRow,
  PatientRow,
} from '../types/database';
import { decryptNullableToken } from '../utils/crypto';

export const messagesRouter = Router();

// Todas las rutas de /api/conversations requieren JWT válido y membresía en clinic_users
messagesRouter.use(requireClinicAuth);

const conversationIdParamSchema = z.object({
  conversationId: z.string().uuid('conversationId debe ser un UUID válido'),
});

const sendManualMessageBodySchema = z.object({
  text: z.string().trim().min(1, 'El texto del mensaje no puede estar vacío').max(4096),
});

// Acepta tanto { ai_enabled: boolean } como { aiEnabled: boolean }
const aiToggleBodySchema = z
  .object({
    ai_enabled: z.boolean().optional(),
    aiEnabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.ai_enabled === 'boolean' || typeof data.aiEnabled === 'boolean',
    {
      message: 'Debe enviar { "ai_enabled": boolean }',
    }
  );

/**
 * POST /api/conversations/:conversationId/send
 * Valida que la conversación pertenezca a `req.auth.clinicId`, envía el mensaje manual
 * al paciente vía `whatsapp.ts`, lo guarda en `messages` (`sender_type: 'human'`)
 * y actualiza automáticamente `conversations.ai_enabled = false` (Human Handoff).
 */
messagesRouter.post(
  '/:conversationId/send',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const parsedParams = conversationIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        error: 'Parámetro conversationId inválido',
        details: parsedParams.error.flatten(),
      });
      return;
    }

    const parsedBody = sendManualMessageBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        error: 'Cuerpo de petición inválido',
        details: parsedBody.error.flatten(),
      });
      return;
    }

    const { conversationId } = parsedParams.data;
    const { text } = parsedBody.data;
    const { clinicId } = auth;

    try {
      // 1. Validar que la conversación pertenezca a req.auth.clinicId
      const { data: conversation, error: convErr } = await supabaseAdmin
        .from('conversations')
        .select('id, clinic_id, patient_id, status, ai_enabled')
        .eq('id', conversationId)
        .eq('clinic_id', clinicId)
        .single<
          Pick<ConversationRow, 'id' | 'clinic_id' | 'patient_id' | 'status' | 'ai_enabled'>
        >();

      if (convErr || !conversation) {
        res.status(404).json({
          error: 'Conversación no encontrada o no pertenece a tu clínica.',
        });
        return;
      }

      // 2. Cargar datos de la clínica y teléfono del paciente
      const [clinicRes, patientRes] = await Promise.all([
        supabaseAdmin
          .from('clinics')
          .select('id, name, whatsapp_phone_id, whatsapp_access_token')
          .eq('id', clinicId)
          .single<
            Pick<
              ClinicRow,
              'id' | 'name' | 'whatsapp_phone_id' | 'whatsapp_access_token'
            >
          >(),
        supabaseAdmin
          .from('patients')
          .select('id, clinic_id, phone, full_name')
          .eq('id', conversation.patient_id)
          .eq('clinic_id', clinicId)
          .single<Pick<PatientRow, 'id' | 'clinic_id' | 'phone' | 'full_name'>>(),
      ]);

      if (clinicRes.error || !clinicRes.data) {
        res.status(404).json({ error: 'Clínica no encontrada.' });
        return;
      }

      if (patientRes.error || !patientRes.data) {
        res.status(404).json({ error: 'Paciente asociado a la conversación no encontrado.' });
        return;
      }

      const clinic = clinicRes.data;
      const patient = patientRes.data;
      const decryptedClinicToken = decryptNullableToken(clinic.whatsapp_access_token);
      const accessToken = decryptedClinicToken || env.META_SYSTEM_ACCESS_TOKEN;

      // 3. Enviar el mensaje saliente por Meta WhatsApp Cloud API (resiliente en local si el token es de prueba)
      let waMessageId: string | null = null;
      let whatsappDeliveryError: string | null = null;

      try {
        const waResult = await sendWhatsAppText(
          clinic.whatsapp_phone_id,
          accessToken,
          patient.phone,
          text
        );
        waMessageId = waResult.waMessageId;
      } catch (waErr) {
        whatsappDeliveryError =
          waErr instanceof Error ? waErr.message : 'Error enviando a Meta Cloud API';
        console.warn(
          `[MessagesRoute] Falló entrega HTTP a Meta (guardando mensaje en DB igualmente): ${whatsappDeliveryError}`
        );
      }

      const nowIso = new Date().toISOString();

      // 4. Guardar mensaje en `messages` (`sender_type: 'human'`) y actualizar `conversations.ai_enabled = false`
      const [insertedMsgRes, updatedConvRes] = await Promise.all([
        supabaseAdmin
          .from('messages')
          .insert({
            clinic_id: clinicId,
            conversation_id: conversationId,
            wa_message_id: waMessageId,
            sender_type: 'human',
            message_type: 'text',
            content: text,
            metadata: {
              sent_by_user_id: auth.userId,
              sent_by_name: auth.fullName ?? auth.email ?? 'Recepción',
              sender: 'human',
              ...(whatsappDeliveryError ? { whatsapp_delivery_error: whatsappDeliveryError } : {}),
            },
            processed_by_ai: true,
          })
          .select('*')
          .single<MessageRow>(),
        supabaseAdmin
          .from('conversations')
          .update({
            ai_enabled: false,
            status: 'human_handoff',
            unread_count: 0,
            last_message_at: nowIso,
            last_message_preview: text.slice(0, 160),
          })
          .eq('id', conversationId)
          .eq('clinic_id', clinicId)
          .select('*')
          .single<ConversationRow>(),
      ]);

      if (insertedMsgRes.error) {
        res.status(500).json({
          error: `Error guardando el mensaje en DB: ${insertedMsgRes.error.message}`,
        });
        return;
      }

      res.status(200).json({
        message: insertedMsgRes.data,
        conversation: updatedConvRes.data ?? null,
      });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Error enviando mensaje manual de WhatsApp';
      console.error('[MessagesRoute POST /send Error]:', errorMessage);
      res.status(502).json({
        error: errorMessage,
      });
    }
  }
);

/**
 * PATCH /api/conversations/:conversationId/ai-toggle
 * Recibe `{ ai_enabled: boolean }`, actualiza la conversación y limpia `escalation_reason`
 * si se reactiva la IA.
 */
messagesRouter.patch(
  '/:conversationId/ai-toggle',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const parsedParams = conversationIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        error: 'Parámetro conversationId inválido',
        details: parsedParams.error.flatten(),
      });
      return;
    }

    const parsedBody = aiToggleBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        error: 'Debe enviar { "ai_enabled": boolean }',
        details: parsedBody.error.flatten(),
      });
      return;
    }

    const { conversationId } = parsedParams.data;
    const aiEnabled =
      typeof parsedBody.data.ai_enabled === 'boolean'
        ? parsedBody.data.ai_enabled
        : Boolean(parsedBody.data.aiEnabled);
    const { clinicId } = auth;

    const updatePayload: {
      ai_enabled: boolean;
      status: 'open' | 'human_handoff';
      escalation_reason?: null;
    } = {
      ai_enabled: aiEnabled,
      status: aiEnabled ? 'open' : 'human_handoff',
      ...(aiEnabled ? { escalation_reason: null } : {}),
    };

    const { data: updatedConversation, error } = await supabaseAdmin
      .from('conversations')
      .update(updatePayload)
      .eq('id', conversationId)
      .eq('clinic_id', clinicId)
      .select('*')
      .maybeSingle<ConversationRow>();

    if (error) {
      res.status(500).json({
        error: `Error actualizando estado de IA: ${error.message}`,
      });
      return;
    }

    if (!updatedConversation) {
      res.status(404).json({
        error: 'Conversación no encontrada o no pertenece a tu clínica.',
      });
      return;
    }

    res.status(200).json({
      conversation: updatedConversation,
    });
  }
);

/**
 * PATCH /api/conversations/:conversationId/verify-payment
 * Marca un comprobante de pago como verificado (`payment_pending_verification = false`) desde Recepción.
 */
messagesRouter.patch(
  '/:conversationId/verify-payment',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const parsedParams = conversationIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        error: 'Parámetro conversationId inválido',
        details: parsedParams.error.flatten(),
      });
      return;
    }

    const { conversationId } = parsedParams.data;

    const { data: updatedConversation, error } = await supabaseAdmin
      .from('conversations')
      .update({
        payment_pending_verification: false,
      })
      .eq('id', conversationId)
      .eq('clinic_id', auth.clinicId)
      .select('*')
      .maybeSingle<ConversationRow>();

    if (error) {
      res.status(500).json({
        error: `Error verificando pago: ${error.message}`,
      });
      return;
    }

    if (!updatedConversation) {
      res.status(404).json({
        error: 'Conversación no encontrada o no pertenece a tu clínica.',
      });
      return;
    }

    res.status(200).json({
      conversation: updatedConversation,
    });
  }
);
