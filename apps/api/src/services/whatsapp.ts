import { z } from 'zod';
import { env } from '../config/env';

const metaSendSuccessSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  contacts: z
    .array(
      z.object({
        input: z.string(),
        wa_id: z.string(),
      })
    )
    .optional(),
  messages: z.array(
    z.object({
      id: z.string(),
    })
  ),
});

const metaMediaMetadataSchema = z.object({
  url: z.string().url(),
  mime_type: z.string(),
  sha256: z.string().optional(),
  file_size: z.number().optional(),
  id: z.string(),
});

const metaErrorPayloadSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
  }),
});

export interface WhatsAppSendResult {
  waMessageId: string;
}

export interface WhatsAppMediaDownloadResult {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Ejecuta una petición POST autenticada hacia Meta Graph API (v21.0)
 * manejando errores de forma estructurada sin exponer el accessToken en logs.
 */
async function postToMetaMessagesApi(
  phoneNumberId: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<WhatsAppSendResult> {
  const endpoint = `https://graph.facebook.com/${env.META_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const rawJson: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      const parsedError = metaErrorPayloadSchema.safeParse(rawJson);
      const errorDetails = parsedError.success
        ? {
            status: response.status,
            code: parsedError.data.error.code,
            subcode: parsedError.data.error.error_subcode,
            type: parsedError.data.error.type,
            message: parsedError.data.error.message,
            fbtrace_id: parsedError.data.error.fbtrace_id,
            phoneNumberId,
          }
        : {
            status: response.status,
            phoneNumberId,
            message: 'Respuesta de error no estructurada desde Meta API',
          };

      console.error('[WhatsApp Service] Error HTTP de Meta Cloud API:', JSON.stringify(errorDetails));
      throw new Error(
        `Meta WhatsApp API Error (HTTP ${response.status}): ${errorDetails.message}`
      );
    }

    const parsedSuccess = metaSendSuccessSchema.safeParse(rawJson);
    const firstMessage = parsedSuccess.success ? parsedSuccess.data.messages[0] : undefined;

    if (!firstMessage) {
      throw new Error(
        '[WhatsApp Service] Respuesta 200 de Meta pero sin messages[0].id válido'
      );
    }

    return {
      waMessageId: firstMessage.id,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const safeMessage = err instanceof Error ? err.message : 'Error desconocido enviando WhatsApp';
    console.error(
      JSON.stringify({
        service: 'whatsapp',
        action: 'postToMetaMessagesApi',
        phoneNumberId,
        error: safeMessage,
      })
    );
    throw err;
  }
}

/**
 * Envía un mensaje de texto estándar dentro de la ventana de atención de 24 horas
 * usando Meta WhatsApp Cloud API v21.0.
 */
export async function sendWhatsAppText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string
): Promise<WhatsAppSendResult> {
  const cleanRecipient = to.replace(/[^0-9]/g, '');

  return postToMetaMessagesApi(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanRecipient,
    type: 'text',
    text: {
      preview_url: false,
      body: text,
    },
  });
}

/**
 * Envía una plantilla aprobada (HSM Template) para recordatorios o notificaciones
 * fuera de la ventana de 24 horas usando Meta WhatsApp Cloud API v21.0.
 */
export async function sendWhatsAppTemplate(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode: string,
  components: unknown[]
): Promise<WhatsAppSendResult> {
  const cleanRecipient = to.replace(/[^0-9]/g, '');

  return postToMetaMessagesApi(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanRecipient,
    type: 'template',
    template: {
      name: templateName,
      language: {
        code: languageCode,
      },
      components,
    },
  });
}

/**
 * Descarga un archivo multimedia (nota de voz `audio` o captura de pago `image`) desde Meta Cloud API v21.0:
 * 1. Consulta `GET https://graph.facebook.com/v21.0/{mediaId}` para obtener la URL temporal de descarga y el `mime_type`.
 * 2. Descarga los bytes binarios desde la URL temporal autenticada con `Authorization: Bearer {accessToken}`.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  accessToken: string
): Promise<WhatsAppMediaDownloadResult> {
  const metadataEndpoint = `https://graph.facebook.com/${env.META_API_VERSION}/${encodeURIComponent(mediaId)}`;

  const metaController = new AbortController();
  const metaTimeout = setTimeout(() => metaController.abort(), 10000);

  try {
    // Paso 1: Obtener URL temporal de descarga
    const metaRes = await fetch(metadataEndpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: metaController.signal,
    });

    clearTimeout(metaTimeout);

    const rawMetaJson: unknown = await metaRes.json().catch(() => ({}));

    if (!metaRes.ok) {
      const parsedError = metaErrorPayloadSchema.safeParse(rawMetaJson);
      const errMsg = parsedError.success
        ? parsedError.data.error.message
        : `HTTP ${metaRes.status} consultando metadata de mediaId=${mediaId}`;
      throw new Error(`Meta Media Metadata Error: ${errMsg}`);
    }

    const parsedMeta = metaMediaMetadataSchema.safeParse(rawMetaJson);
    if (!parsedMeta.success) {
      throw new Error(
        `Respuesta inválida de Meta Media API para mediaId=${mediaId}`
      );
    }

    const { url: downloadUrl, mime_type: mimeType } = parsedMeta.data;

    // Paso 2: Descargar el binario desde la URL temporal de Meta
    const binaryController = new AbortController();
    const binaryTimeout = setTimeout(() => binaryController.abort(), 15000);

    const binaryRes = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: binaryController.signal,
    });

    clearTimeout(binaryTimeout);

    if (!binaryRes.ok) {
      throw new Error(
        `Error HTTP ${binaryRes.status} descargando binario multimedia de Meta (mediaId=${mediaId})`
      );
    }

    const arrayBuffer = await binaryRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      mimeType,
    };
  } catch (err) {
    clearTimeout(metaTimeout);
    const safeMessage =
      err instanceof Error ? err.message : 'Error descargando multimedia de WhatsApp';
    console.error(
      JSON.stringify({
        service: 'whatsapp',
        action: 'downloadWhatsAppMedia',
        mediaId,
        error: safeMessage,
      })
    );
    throw err;
  }
}
