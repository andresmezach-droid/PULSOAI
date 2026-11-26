import {
  Content,
  FunctionCall,
  FunctionDeclaration,
  GoogleGenAI,
  Part,
  Type,
} from '@google/genai';
import { z } from 'zod';
import { env } from '../config/env';
import { supabaseAdmin } from '../config/supabase';
import {
  ClinicRow,
  ConversationRow,
  MessageRow,
  PatientRow,
  ServiceRow,
} from '../types/database';
import { decryptNullableToken } from '../utils/crypto';
import { getBcvRate } from './bcv';
import {
  bookAppointment,
  checkAvailability,
  getPatientActiveAppointments,
  rescheduleOrCancelAppointment,
} from './calendar';
import { downloadWhatsAppMedia, sendWhatsAppText } from './whatsapp';

const GEMINI_MODEL = process.env['GEMINI_MODEL'] || 'gemini-3.5-flash';
const GEMINI_FALLBACK_MODELS = [
  GEMINI_MODEL,
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];
const MAX_TOOL_ITERATIONS = 5;

const genAI = new GoogleGenAI({
  apiKey: env.GEMINI_API_KEY,
});

/**
 * Invoca Gemini con fallback automático de modelo si hay saturación temporal (HTTP 503/429)
 */
async function generateContentWithFallback(
  params: Omit<Parameters<typeof genAI.models.generateContent>[0], 'model'>
) {
  let lastError: unknown;
  for (const candidateModel of GEMINI_FALLBACK_MODELS) {
    try {
      return await genAI.models.generateContent({
        ...params,
        model: candidateModel,
      });
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[AIAgent] Modelo ${candidateModel} devolvió error (${errMsg}). Intentando modelo de respaldo...`
      );
    }
  }
  throw lastError;
}

// Esquemas Zod para validar los argumentos de Function Calling
const checkAvailabilityArgsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Debe ser YYYY-MM-DD'),
  durationMinutes: z.coerce.number().int().positive().default(30),
});

const bookAppointmentArgsSchema = z.object({
  patientName: z.string().min(2),
  serviceId: z.string().uuid(),
  startTimeIso: z.string().min(10),
});

const rescheduleOrCancelArgsSchema = z.object({
  appointment_id: z.string().uuid(),
  action: z.enum(['cancel', 'reschedule']),
  new_start_time_iso: z.string().optional(),
});

const escalateToHumanArgsSchema = z.object({
  reason: z.string().min(3),
});

const paymentAnalysisJsonSchema = z.object({
  isPaymentReceipt: z.boolean(),
  paymentMethod: z.string().optional(),
  amount: z.string().optional(),
  referenceNumber: z.string().optional(),
  summary: z.string(),
});

/**
 * Declaración de las herramientas (Function Calling) para Gemini 2.5 Flash
 */
const pulsoToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'get_clinic_services',
    description:
      'Consulta la lista oficial de servicios y tratamientos activos de la clínica con su ID (serviceId), duración en minutos, precio en USD y el equivalente calculado en Bolívares (Bs) a la tasa oficial del BCV.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'check_availability',
    description:
      'Consulta los bloques horarios libres en la agenda de la clínica para una fecha específica en formato YYYY-MM-DD y la duración del servicio en minutos.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: {
          type: Type.STRING,
          description: 'Fecha a consultar en formato YYYY-MM-DD (ej. 2025-05-20)',
        },
        durationMinutes: {
          type: Type.NUMBER,
          description: 'Duración del tratamiento en minutos (ej. 30, 45, 60)',
        },
      },
      required: ['date', 'durationMinutes'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Agenda y confirma una cita nueva en el sistema de la clínica. REGLA ESTRICTA: PROHIBIDO invocar esta herramienta si en el mensaje actual o reciente el paciente solo mencionó el nombre del servicio sin haber elegido explícitamente el DÍA y la HORA. Antes de invocarla SIEMPRE debes haber ejecutado check_availability en esta conversación y el paciente debe haber confirmado la hora deseada.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        patientName: {
          type: Type.STRING,
          description: 'Nombre y apellido del paciente',
        },
        serviceId: {
          type: Type.STRING,
          description: 'UUID exacto del servicio (obtenido con get_clinic_services)',
        },
        startTimeIso: {
          type: Type.STRING,
          description:
            'Fecha y hora exacta de inicio confirmada explícitamente por el paciente en formato ISO 8601 con zona horaria de Venezuela -04:00 (ej. 2025-05-20T10:30:00-04:00)',
        },
      },
      required: ['patientName', 'serviceId', 'startTimeIso'],
    },
  },
  {
    name: 'get_patient_appointments',
    description:
      'Consulta las citas activas (confirmadas o agendadas) del paciente actual para obtener su appointment_id antes de reprogramar o cancelar.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'reschedule_or_cancel',
    description:
      'Reprograma o cancela una cita existente del paciente. Primero debes obtener el appointment_id invocando get_patient_appointments. Si action es "reschedule", debes enviar new_start_time_iso en formato ISO 8601 (-04:00).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        appointment_id: {
          type: Type.STRING,
          description: 'UUID de la cita activa del paciente (obtenido de get_patient_appointments)',
        },
        action: {
          type: Type.STRING,
          description: 'Acción a realizar: "cancel" para cancelar o "reschedule" para reprogramar',
        },
        new_start_time_iso: {
          type: Type.STRING,
          description:
            'Obligatorio si action es "reschedule": nueva fecha y hora de inicio en formato ISO 8601 con zona horaria de Venezuela -04:00 (ej. 2025-05-22T14:00:00-04:00)',
        },
      },
      required: ['appointment_id', 'action'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Desactiva la respuesta automática de IA y transfiere la conversación a un especialista o recepcionista humano. Úsala inmediatamente ante emergencias médicas, dolor agudo, sangrado, comprobantes de pago recibidos, reclamos o cuando el paciente pida hablar con una persona.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: {
          type: Type.STRING,
          description: 'Motivo detallado por el cual se transfiere la conversación a un humano',
        },
      },
      required: ['reason'],
    },
  },
];

function getCaracasCurrentDateTimeString(timezone = 'America/Caracas'): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('es-VE', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const isoCaracas =
    new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 19) +
    '-04:00';

  return `${formatter.format(now)} (ISO Referencia: ${isoCaracas})`;
}

function buildDynamicSystemPrompt(params: {
  clinic: ClinicRow;
  patient: PatientRow;
  bcvRate: number;
  services: Array<
    Pick<
      ServiceRow,
      'id' | 'name' | 'description' | 'category' | 'price_usd' | 'duration_minutes'
    >
  >;
}): string {
  const { clinic, patient, bcvRate, services } = params;
  const currentDateTime = getCaracasCurrentDateTimeString(
    clinic.timezone || 'America/Caracas'
  );
  const paymentMethodsStr =
    clinic.payment_methods && clinic.payment_methods.length > 0
      ? clinic.payment_methods.join(', ')
      : 'Pago Móvil (a tasa BCV), Zelle, Efectivo USD, Punto de Venta';

  const businessHoursStr = clinic.business_hours
    ? JSON.stringify(clinic.business_hours)
    : 'Lunes a Viernes 08:00 a 17:00, Sábados 09:00 a 13:00';

  const servicesCatalogStr =
    services.length > 0
      ? services
          .map((s) => {
            const usd = Number(s.price_usd);
            const ves = (usd * bcvRate).toFixed(2);
            return `- ${s.name} (serviceId: "${s.id}" | Duración: ${s.duration_minutes} min): $${usd.toFixed(2)} USD (Bs. ${ves} a tasa BCV)${s.description ? ` — ${s.description}` : ''}`;
          })
          .join('\n')
      : 'Sin servicios activos registrados.';

  const extraInstructions = [clinic.ai_system_prompt, clinic.system_prompt_extra]
    .filter((s): s is string => Boolean(s && s.trim().length > 0))
    .join('\n');

  return `Eres el asistente virtual de recepción de **${clinic.name}** (Especialidad: ${clinic.specialty}) en Venezuela, impulsado por PULSO AI.

### CONTEXTO EN TIEMPO REAL
- **Clínica:** ${clinic.name}
- **Fecha y hora actual en Venezuela (${clinic.timezone || 'America/Caracas'}):** ${currentDateTime}
- **Tasa Oficial del BCV hoy:** Bs. ${bcvRate.toFixed(2)} por cada 1 USD.
- **Métodos de pago aceptados:** ${paymentMethodsStr}
- **Horarios de atención (business_hours):** ${businessHoursStr}
- **Paciente actual:** ${patient.full_name ?? 'Aún no ha indicado su nombre'} (Teléfono WhatsApp: ${patient.phone})

### CATÁLOGO OFICIAL DE SERVICIOS Y PRECIOS ACTIVOS (YA PRE-CARGADOS)
${servicesCatalogStr}

### REGLAS OBLIGATORIAS E INQUEBRANTABLES
1. **Tono y longitud:** Mantén un tono cálido, empático, profesional venezolano y muy breve (MÁXIMO 3 a 4 líneas por mensaje). Usa formato claro para WhatsApp.
2. **Precios y servicios:** Usa ÚNICAMENTE el catálogo oficial pre-cargado arriba (no necesitas llamar a \`get_clinic_services\` a menos que requieras refrescarlo). NUNCA inventes precios ni tratamientos que no estén en la lista.
3. **Conversión a Bolívares (Tasa BCV):** Cuando el paciente pregunte precios en Bolívares (Bs.), Pago Móvil o transferencia nacional, informa el monto en USD y su equivalente exacto en Bolívares calculado a la tasa oficial del BCV (Bs. ${bcvRate.toFixed(2)}/USD).
4. **Flujo obligatorio de 3 pasos para agendar citas (PROHIBIDO SALTARSE PASOS):**
   - **Paso A:** Si el paciente solo dice el nombre de un tratamiento (ej. "limpieza", "blanqueamiento"), dale su precio en USD y Bs. BCV y **pregúntale para qué día desea agendar**. NUNCA reutilices fechas ni horas de citas viejas ya agendadas en días anteriores.
   - **Paso B:** Cuando el paciente indique el día que desea (ej. "mañana", "el viernes"), ejecuta obligatoriamente \`check_availability\` para esa fecha y muéstrale los horarios libres para que elija uno.
   - **Paso C:** ÚNICAMENTE después de que el paciente confirme explícitamente la hora que prefiere de la lista disponible (y tengas su nombre), ejecuta \`book_appointment\`. Si aún no ha elegido fecha y hora en esta solicitud nueva, está ESTRICTAMENTE PROHIBIDO llamar a \`book_appointment\`.
   - Si el paciente desea **reprogramar o cancelar** una cita existente, primero usa \`get_patient_appointments\` para ubicar su cita activa y luego ejecuta \`reschedule_or_cancel\`.
5. **Notas de voz e imágenes:** Entiendes notas de voz e imágenes nativamente. Si el paciente envía una nota de voz, respóndele con total naturalidad.
6. **Prohibido diagnosticar o atender emergencias médicas:** NO des diagnósticos clínicos ni recetes medicamentos. Si el paciente reporta una emergencia médica (dolor agudo o severo, sangrado, infección, inflamación grave) o pide hablar con un humano/doctor, ejecuta DE INMEDIATO la herramienta \`escalate_to_human\` e infórmale con empatía que un especialista o recepcionista lo atenderá en breve.

${extraInstructions ? `### INSTRUCCIONES ESPECÍFICAS DE LA CLÍNICA\n${extraInstructions}` : ''}`;
}

/**
 * Ejecuta una herramienta solicitada por el modelo Gemini y devuelve un objeto JSON serializable
 */
async function executeToolCall(params: {
  functionCall: FunctionCall;
  clinicId: string;
  conversationId: string;
  patientId: string;
  bcvRate: number;
  checkedAvailabilityInSession: boolean;
}): Promise<Record<string, unknown>> {
  const {
    functionCall,
    clinicId,
    conversationId,
    patientId,
    bcvRate,
    checkedAvailabilityInSession,
  } = params;
  const toolName = functionCall.name ?? 'unknown_tool';
  const rawArgs = (functionCall.args ?? {}) as Record<string, unknown>;

  try {
    switch (toolName) {
      case 'get_clinic_services': {
        const { data: services, error } = await supabaseAdmin
          .from('services')
          .select('id, name, description, category, price_usd, duration_minutes')
          .eq('clinic_id', clinicId)
          .eq('is_active', true)
          .order('name', { ascending: true })
          .returns<
            Array<
              Pick<
                ServiceRow,
                'id' | 'name' | 'description' | 'category' | 'price_usd' | 'duration_minutes'
              >
            >
          >();

        if (error) {
          return { ok: false, error: `Error consultando servicios: ${error.message}` };
        }

        const enrichedServices = (services ?? []).map((s) => {
          const priceUsd = Number(s.price_usd);
          const priceVesBcv = Number((priceUsd * bcvRate).toFixed(2));
          return {
            serviceId: s.id,
            name: s.name,
            description: s.description,
            category: s.category,
            durationMinutes: s.duration_minutes,
            priceUsd,
            priceVesBcv,
            bcvRateUsed: bcvRate,
          };
        });

        return {
          ok: true,
          bcvRate,
          count: enrichedServices.length,
          services: enrichedServices,
        };
      }

      case 'check_availability': {
        const parsed = checkAvailabilityArgsSchema.safeParse(rawArgs);
        if (!parsed.success) {
          return {
            ok: false,
            error: `Argumentos inválidos para check_availability: ${parsed.error.message}`,
          };
        }

        const availableSlots = await checkAvailability(
          clinicId,
          parsed.data.date,
          parsed.data.durationMinutes
        );

        return {
          ok: true,
          date: parsed.data.date,
          durationMinutes: parsed.data.durationMinutes,
          timezone: 'America/Caracas',
          availableSlots,
          hasAvailability: availableSlots.length > 0,
        };
      }

      case 'book_appointment': {
        if (!checkedAvailabilityInSession) {
          return {
            ok: false,
            error:
              'BLOQUEADO: El paciente no ha especificado una hora explícita en su último mensaje. Pregúntale primero qué día y hora prefiere (y usa check_availability) antes de invocar book_appointment.',
          };
        }

        const parsed = bookAppointmentArgsSchema.safeParse(rawArgs);
        if (!parsed.success) {
          return {
            ok: false,
            error: `Argumentos inválidos para book_appointment: ${parsed.error.message}`,
          };
        }

        const booking = await bookAppointment(
          clinicId,
          patientId,
          parsed.data.patientName,
          parsed.data.serviceId,
          parsed.data.startTimeIso
        );

        return {
          ok: true,
          appointmentId: booking.appointmentId,
          googleEventId: booking.googleEventId,
          serviceName: booking.serviceName,
          startsAtIso: booking.startsAtIso,
          endsAtIso: booking.endsAtIso,
          priceUsd: booking.priceUsd,
          priceVesBcv: Number((booking.priceUsd * booking.bcvRateSnapshot).toFixed(2)),
          bcvRateSnapshot: booking.bcvRateSnapshot,
        };
      }

      case 'get_patient_appointments': {
        const appointments = await getPatientActiveAppointments(clinicId, patientId);
        return {
          ok: true,
          count: appointments.length,
          appointments,
        };
      }

      case 'reschedule_or_cancel': {
        const parsed = rescheduleOrCancelArgsSchema.safeParse(rawArgs);
        if (!parsed.success) {
          return {
            ok: false,
            error: `Argumentos inválidos para reschedule_or_cancel: ${parsed.error.message}`,
          };
        }

        const result = await rescheduleOrCancelAppointment({
          clinicId,
          patientId,
          appointmentId: parsed.data.appointment_id,
          action: parsed.data.action,
          newStartTimeIso: parsed.data.new_start_time_iso,
        });

        return {
          ok: true,
          ...result,
        };
      }

      case 'escalate_to_human': {
        const parsed = escalateToHumanArgsSchema.safeParse(rawArgs);
        const reason = parsed.success
          ? parsed.data.reason
          : 'Solicitud de atención humana o emergencia médica';

        const { error } = await supabaseAdmin
          .from('conversations')
          .update({
            ai_enabled: false,
            status: 'human_handoff',
            escalation_reason: reason,
          })
          .eq('id', conversationId)
          .eq('clinic_id', clinicId);

        if (error) {
          return {
            ok: false,
            error: `No se pudo actualizar estado de escalamiento: ${error.message}`,
          };
        }

        return {
          ok: true,
          aiEnabled: false,
          status: 'human_handoff',
          reason,
          instructionForAi:
            'Confirma brevemente al paciente con calidez que ya notificaste al equipo especialista/recepcionista de la clínica y que lo atenderán personalmente en breve.',
        };
      }

      default:
        return {
          ok: false,
          error: `Herramienta desconocida: ${toolName}`,
        };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Error ejecutando herramienta';
    console.error(`[AIAgent Tool Error] (${toolName}):`, errMsg);
    return {
      ok: false,
      error: errMsg,
    };
  }
}

/**
 * Procesa una nota de voz (`audio`) con Gemini 2.5 Flash:
 * Descarga el binario desde Meta, obtiene una transcripción/resumen breve para guardar en `media_transcript`
 * y devuelve el `inlineData` part para que el flujo principal de conversación lo entienda nativamente.
 */
async function processIncomingAudioMessage(params: {
  msg: MessageRow;
  accessToken: string;
}): Promise<{ inlinePart: Part | null; transcript: string }> {
  const { msg, accessToken } = params;
  if (!msg.media_id) {
    return { inlinePart: null, transcript: '[Nota de voz sin media_id]' };
  }

  try {
    const { buffer, mimeType } = await downloadWhatsAppMedia(
      msg.media_id,
      accessToken
    );
    const base64Data = buffer.toString('base64');
    const inlinePart: Part = {
      inlineData: {
        mimeType,
        data: base64Data,
      },
    };

    // Generar transcripción/resumen conciso para almacenar en messages.media_transcript
    const transcriptRes = await generateContentWithFallback({
      contents: [
        {
          role: 'user',
          parts: [
            inlinePart,
            {
              text: 'Transcribe literalmente en español el contenido de esta nota de voz enviada por un paciente a una clínica. Devuelve únicamente el texto transcrito.',
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
      },
    });

    const transcript =
      (transcriptRes.text ?? '').trim() || '[Nota de voz procesada por IA]';

    await supabaseAdmin
      .from('messages')
      .update({
        media_transcript: transcript,
        content: `[Nota de voz]: "${transcript}"`,
      })
      .eq('id', msg.id)
      .eq('clinic_id', msg.clinic_id);

    return { inlinePart, transcript };
  } catch (err) {
    console.warn(
      `[AIAgent Audio] No se pudo descargar/transcribir audio media_id=${msg.media_id}:`,
      err instanceof Error ? err.message : err
    );
    return { inlinePart: null, transcript: msg.content };
  }
}

/**
 * Analiza una imagen (`image`) enviada por el paciente con Gemini 2.5 Flash:
 * Detecta si es un comprobante de pago (Pago Móvil, Zelle, Binance, Transferencia).
 * Si lo es: extrae monto y referencia, guarda `media_transcript`, marca `payment_pending_verification = true`
 * y ejecuta el escalamiento `escalate_to_human("Comprobante de pago recibido para verificación")`.
 */
async function processIncomingImageMessage(params: {
  msg: MessageRow;
  accessToken: string;
  clinicId: string;
  conversationId: string;
}): Promise<{
  inlinePart: Part | null;
  isPaymentReceipt: boolean;
  receiptConfirmationReply: string | null;
}> {
  const { msg, accessToken, clinicId, conversationId } = params;
  if (!msg.media_id) {
    return {
      inlinePart: null,
      isPaymentReceipt: false,
      receiptConfirmationReply: null,
    };
  }

  try {
    const { buffer, mimeType } = await downloadWhatsAppMedia(
      msg.media_id,
      accessToken
    );
    const base64Data = buffer.toString('base64');
    const inlinePart: Part = {
      inlineData: {
        mimeType,
        data: base64Data,
      },
    };

    const analysisRes = await generateContentWithFallback({
      contents: [
        {
          role: 'user',
          parts: [
            inlinePart,
            {
              text: `Analiza esta imagen enviada por WhatsApp a una clínica en Venezuela.
Determina si es un comprobante o captura de pago (Pago Móvil, Zelle, Binance, transferencia bancaria).
Responde ESTRICTAMENTE en JSON válido sin bloques markdown con la siguiente estructura:
{
  "isPaymentReceipt": boolean,
  "paymentMethod": "Pago Móvil" | "Zelle" | "Binance" | "Transferencia" | "Otro",
  "amount": "Monto extraído con moneda (ej. Bs. 1.540,00 o $35.00)",
  "referenceNumber": "Número de referencia o confirmación extraído",
  "summary": "Descripción breve en español de la imagen"
}`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    });

    const rawText = (analysisRes.text ?? '{}').trim();
    let parsedAnalysis: z.infer<typeof paymentAnalysisJsonSchema> = {
      isPaymentReceipt: false,
      summary: 'Imagen enviada por el paciente',
    };

    try {
      const jsonObj: unknown = JSON.parse(rawText);
      const safeParsed = paymentAnalysisJsonSchema.safeParse(jsonObj);
      if (safeParsed.success) {
        parsedAnalysis = safeParsed.data;
      }
    } catch {
      // Fallback si el JSON no pudo parsearse
    }

    const transcriptSummary = parsedAnalysis.isPaymentReceipt
      ? `Comprobante ${parsedAnalysis.paymentMethod ?? 'de pago'} | Monto: ${parsedAnalysis.amount ?? 'N/D'} | Ref: ${parsedAnalysis.referenceNumber ?? 'N/D'}`
      : parsedAnalysis.summary;

    await supabaseAdmin
      .from('messages')
      .update({
        media_transcript: transcriptSummary,
        content: parsedAnalysis.isPaymentReceipt
          ? `[Comprobante de Pago]: ${transcriptSummary}`
          : `[Imagen]: ${transcriptSummary}`,
      })
      .eq('id', msg.id)
      .eq('clinic_id', clinicId);

    if (parsedAnalysis.isPaymentReceipt) {
      // Marcar payment_pending_verification = true y escalar a humano
      await supabaseAdmin
        .from('conversations')
        .update({
          payment_pending_verification: true,
          ai_enabled: false,
          status: 'human_handoff',
          escalation_reason: 'Comprobante de pago recibido para verificación',
        })
        .eq('id', conversationId)
        .eq('clinic_id', clinicId);

      const methodStr = parsedAnalysis.paymentMethod ?? 'pago';
      const amountStr = parsedAnalysis.amount ? ` por ${parsedAnalysis.amount}` : '';
      const refStr = parsedAnalysis.referenceNumber
        ? ` (Ref: ${parsedAnalysis.referenceNumber})`
        : '';

      const receiptConfirmationReply = `¡Muchas gracias! Hemos recibido tu comprobante de ${methodStr}${amountStr}${refStr}. Nuestro equipo de recepción validará tu pago en breve y te confirmará por esta vía.`;

      return {
        inlinePart,
        isPaymentReceipt: true,
        receiptConfirmationReply,
      };
    }

    return {
      inlinePart,
      isPaymentReceipt: false,
      receiptConfirmationReply: null,
    };
  } catch (err) {
    console.warn(
      `[AIAgent Image] No se pudo descargar/analizar imagen media_id=${msg.media_id}:`,
      err instanceof Error ? err.message : err
    );
    return {
      inlinePart: null,
      isPaymentReceipt: false,
      receiptConfirmationReply: null,
    };
  }
}

/**
 * Procesa una conversación tras cumplirse el debounce de 6 segundos:
 * 1. Carga clínica, paciente, tasa BCV actual y los últimos 15 mensajes.
 * 2. Si el último lote sin procesar contiene notas de voz (`audio`) o imágenes (`image`),
 *    descarga el binario desde Meta y lo procesa multimodalmente con `gemini-2.5-flash`.
 * 3. Ejecuta el bucle seguro de Function Calling (hasta 5 iteraciones).
 * 4. Envía la respuesta al paciente por WhatsApp Cloud API y registra el mensaje en Supabase.
 */
export async function processConversation(
  clinicId: string,
  conversationId: string
): Promise<void> {
  const [convRes, clinicRes, messagesRes, servicesRes, bcvRes] = await Promise.all([
    supabaseAdmin
      .from('conversations')
      .select(
        'id, clinic_id, patient_id, status, ai_enabled, payment_pending_verification'
      )
      .eq('id', conversationId)
      .eq('clinic_id', clinicId)
      .single<
        Pick<
          ConversationRow,
          | 'id'
          | 'clinic_id'
          | 'patient_id'
          | 'status'
          | 'ai_enabled'
          | 'payment_pending_verification'
        >
      >(),
    supabaseAdmin
      .from('clinics')
      .select('*')
      .eq('id', clinicId)
      .single<ClinicRow>(),
    supabaseAdmin
      .from('messages')
      .select(
        'id, clinic_id, conversation_id, wa_message_id, sender_type, message_type, media_type, media_id, media_transcript, content, media_url, metadata, processed_by_ai, created_at'
      )
      .eq('clinic_id', clinicId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(12)
      .returns<MessageRow[]>(),
    supabaseAdmin
      .from('services')
      .select('id, name, description, category, price_usd, duration_minutes')
      .eq('clinic_id', clinicId)
      .eq('is_active', true)
      .order('name', { ascending: true })
      .returns<
        Array<
          Pick<
            ServiceRow,
            'id' | 'name' | 'description' | 'category' | 'price_usd' | 'duration_minutes'
          >
        >
      >(),
    getBcvRate().catch(() => ({
      rate: 1,
      updatedAt: new Date().toISOString(),
      source: 'fallback' as const,
    })),
  ]);

  if (convRes.error || !convRes.data) {
    throw new Error(
      `[AIAgent] Conversación no encontrada (${conversationId}): ${convRes.error?.message ?? ''}`
    );
  }

  const conversation = convRes.data;
  if (!conversation.ai_enabled) {
    console.info(
      `[AIAgent] Conversación ${conversationId} tiene ai_enabled=false. Abortando respuesta IA.`
    );
    return;
  }

  if (clinicRes.error || !clinicRes.data) {
    throw new Error(
      `[AIAgent] Clínica no encontrada (${clinicId}): ${clinicRes.error?.message ?? ''}`
    );
  }

  const clinic = clinicRes.data;
  const decryptedClinicToken = decryptNullableToken(clinic.whatsapp_access_token);
  const accessToken = decryptedClinicToken || env.META_SYSTEM_ACCESS_TOKEN;

  const { data: patient, error: patientErr } = await supabaseAdmin
    .from('patients')
    .select('*')
    .eq('id', conversation.patient_id)
    .eq('clinic_id', clinicId)
    .single<PatientRow>();

  if (patientErr || !patient) {
    throw new Error(
      `[AIAgent] Paciente no encontrado (${conversation.patient_id}): ${patientErr?.message ?? ''}`
    );
  }

  const recentMessagesDesc = messagesRes.data ?? [];
  if (recentMessagesDesc.length === 0) {
    return;
  }

  const chronologicalMessages = [...recentMessagesDesc].reverse();

  // Pre-procesar archivos multimedia (audio e image) de los mensajes aún no procesados
  const inlineMediaPartsByMessageId = new Map<string, Part>();
  let paymentReceiptAutoReply: string | null = null;

  for (const msg of chronologicalMessages) {
    if (msg.sender_type !== 'patient' || msg.processed_by_ai) {
      continue;
    }

    if (msg.media_type === 'audio' && msg.media_id) {
      const audioRes = await processIncomingAudioMessage({ msg, accessToken });
      msg.media_transcript = audioRes.transcript;
      msg.content = `[Nota de voz]: "${audioRes.transcript}"`;
      if (audioRes.inlinePart) {
        inlineMediaPartsByMessageId.set(msg.id, audioRes.inlinePart);
      }
    } else if (msg.media_type === 'image' && msg.media_id) {
      const imageRes = await processIncomingImageMessage({
        msg,
        accessToken,
        clinicId,
        conversationId,
      });
      if (imageRes.inlinePart) {
        inlineMediaPartsByMessageId.set(msg.id, imageRes.inlinePart);
      }
      if (imageRes.isPaymentReceipt && imageRes.receiptConfirmationReply) {
        paymentReceiptAutoReply = imageRes.receiptConfirmationReply;
      }
    }
  }

  let finalReplyText = '';

  // Si se detectó un comprobante de pago, ya se marcó payment_pending_verification = true y se escaló a humano
  if (paymentReceiptAutoReply) {
    finalReplyText = paymentReceiptAutoReply;
  } else {
    // Construir el historial Content[] incluyendo inlineData (base64) cuando el mensaje tiene audio o imagen
    const contents: Content[] = chronologicalMessages.map((msg) => {
      const parts: Part[] = [];
      const inlineMedia = inlineMediaPartsByMessageId.get(msg.id);
      if (inlineMedia) {
        parts.push(inlineMedia);
      }
      parts.push({
        text: msg.media_transcript
          ? `${msg.content} (Transcripción/Detalle: ${msg.media_transcript})`
          : msg.content,
      });

      return {
        role: msg.sender_type === 'patient' ? 'user' : 'model',
        parts,
      };
    });

    const systemInstruction = buildDynamicSystemPrompt({
      clinic,
      patient,
      bcvRate: bcvRes.rate,
      services: servicesRes.data ?? [],
    });

    // Verificar si el último mensaje del paciente contiene explícitamente una hora o intención de confirmar hora
    const latestPatientTexts = chronologicalMessages
      .filter((m) => m.sender_type === 'patient' && !m.processed_by_ai)
      .map((m) => m.content)
      .join(' ');
    const patientMentionedTimeOrConfirm =
      /(\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.|hrs|horas)?\b|mañana a las|tarde a las|confirmo|agéndame|agendame|reserva|sí a las|si a las)/i.test(
        latestPatientTexts
      );

    // Bucle seguro de Function Calling (máximo 5 iteraciones)
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await generateContentWithFallback({
        contents,
        config: {
          systemInstruction,
          temperature: 0.2,
          tools: [{ functionDeclarations: pulsoToolDeclarations }],
        },
      });

      const functionCalls = response.functionCalls;

      if (!functionCalls || functionCalls.length === 0) {
        finalReplyText = (response.text ?? '').trim();
        break;
      }

      const modelCandidateContent = response.candidates?.[0]?.content;
      if (modelCandidateContent) {
        contents.push(modelCandidateContent);
      } else {
        contents.push({
          role: 'model',
          parts: functionCalls.map((fc): Part => ({ functionCall: fc })),
        });
      }

      const toolResponseParts: Part[] = [];

      for (const fc of functionCalls) {
        console.info(
          `[AIAgent] Iteración ${iteration + 1}/${MAX_TOOL_ITERATIONS} -> Ejecutando herramienta "${fc.name}" para clínica ${clinic.name}`
        );

        const toolResult = await executeToolCall({
          functionCall: fc,
          clinicId,
          conversationId,
          patientId: patient.id,
          bcvRate: bcvRes.rate,
          checkedAvailabilityInSession: patientMentionedTimeOrConfirm,
        });

        const functionResponsePart: Part = {
          functionResponse: {
            name: fc.name ?? 'unknown_tool',
            response: toolResult,
            ...(fc.id ? { id: fc.id } : {}),
          },
        };

        toolResponseParts.push(functionResponsePart);
      }

      contents.push({
        role: 'user',
        parts: toolResponseParts,
      });
    }
  }

  if (!finalReplyText) {
    finalReplyText =
      'Un miembro de nuestro equipo de atención al paciente revisará tu solicitud y te responderá en breve.';
  }

  // Enviar respuesta al paciente vía Meta WhatsApp Cloud API (v21.0)
  let waMessageId: string | null = null;
  let whatsappDeliveryError: string | null = null;

  try {
    const sendResult = await sendWhatsAppText(
      clinic.whatsapp_phone_id,
      accessToken,
      patient.phone,
      finalReplyText
    );
    waMessageId = sendResult.waMessageId;
  } catch (waErr) {
    whatsappDeliveryError =
      waErr instanceof Error ? waErr.message : 'Error enviando mensaje a Meta Cloud API';
    console.warn(
      `[AIAgent] No se pudo entregar a Meta Cloud API (guardando igualmente en DB local): ${whatsappDeliveryError}`
    );
  }

  const unprocessedPatientMessageIds = chronologicalMessages
    .filter((m) => m.sender_type === 'patient' && !m.processed_by_ai)
    .map((m) => m.id);

  await Promise.all([
    supabaseAdmin.from('messages').insert({
      clinic_id: clinicId,
      conversation_id: conversationId,
      wa_message_id: waMessageId,
      sender_type: 'ai',
      message_type: 'text',
      media_type: 'text',
      content: finalReplyText,
      metadata: {
        model: GEMINI_MODEL,
        bcv_rate_used: bcvRes.rate,
        ...(whatsappDeliveryError ? { whatsapp_delivery_error: whatsappDeliveryError } : {}),
      },
      processed_by_ai: true,
    }),
    unprocessedPatientMessageIds.length > 0
      ? supabaseAdmin
          .from('messages')
          .update({ processed_by_ai: true })
          .in('id', unprocessedPatientMessageIds)
          .eq('clinic_id', clinicId)
      : Promise.resolve(),
    supabaseAdmin
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: finalReplyText.slice(0, 160),
      })
      .eq('id', conversationId)
      .eq('clinic_id', clinicId),
  ]);
}
