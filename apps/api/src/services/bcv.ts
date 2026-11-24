import { z } from 'zod';
import { env } from '../config/env';
import { redisClient } from '../config/redis';

const BCV_CACHE_KEY = 'bcv:rate:current';
const BCV_FALLBACK_KEY = 'bcv:rate:fallback';
const BCV_CACHE_TTL_SECONDS = 12 * 60 * 60; // 12 horas

/**
 * Esquema flexible para validar respuestas de APIs públicas de tasa BCV en Venezuela
 * Soporta formatos estándar como ve.dolarapi.com ({ promedio: number }) o pydolarve ({ price: number })
 */
const externalBcvResponseSchema = z.union([
  z.object({
    promedio: z.number().positive(),
    fechaActualizacion: z.string().optional(),
  }),
  z.object({
    price: z.number().positive(),
    last_update: z.string().optional(),
  }),
  z.object({
    rate: z.number().positive(),
    updatedAt: z.string().optional(),
  }),
]);

const cachedRatePayloadSchema = z.object({
  rate: z.number().positive(),
  updatedAt: z.string(),
  source: z.enum(['cache', 'live', 'fallback']),
});

export type BcvRateResult = z.infer<typeof cachedRatePayloadSchema>;

function extractRateFromApiPayload(data: unknown): { rate: number; updatedAt: string } {
  const parsed = externalBcvResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Formato de respuesta BCV no reconocido: ${parsed.error.message}`);
  }

  const payload = parsed.data;
  if ('promedio' in payload) {
    return {
      rate: payload.promedio,
      updatedAt: payload.fechaActualizacion ?? new Date().toISOString(),
    };
  }
  if ('price' in payload) {
    return {
      rate: payload.price,
      updatedAt: payload.last_update ?? new Date().toISOString(),
    };
  }
  return {
    rate: payload.rate,
    updatedAt: payload.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * Obtiene la tasa oficial del BCV (VES/USD).
 * 1. Intenta leer de Redis (`bcv:rate:current`, TTL 12h).
 * 2. Si no existe o expiró, consulta la API externa configurada en `BCV_API_URL`.
 * 3. Guarda el valor fresco en `bcv:rate:current` (con TTL 12h) y en `bcv:rate:fallback` (sin expiración).
 * 4. Si la API externa falla, recupera `bcv:rate:fallback`.
 */
export async function getBcvRate(forceRefresh = false): Promise<BcvRateResult> {
  if (!forceRefresh) {
    try {
      const cachedRaw = await redisClient.get(BCV_CACHE_KEY);
      if (cachedRaw) {
        const parsedCache = cachedRatePayloadSchema.safeParse(JSON.parse(cachedRaw));
        if (parsedCache.success) {
          return {
            ...parsedCache.data,
            source: 'cache',
          };
        }
      }
    } catch (redisErr) {
      console.warn('[BCV Service] Advertencia leyendo caché de Redis:', redisErr);
    }
  }

  // Consulta en vivo a la API externa de tasa BCV
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(env.BCV_API_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} al consultar ${env.BCV_API_URL}`);
    }

    const rawJson: unknown = await response.json();
    const { rate, updatedAt } = extractRateFromApiPayload(rawJson);

    const liveResult: BcvRateResult = {
      rate: Number(rate.toFixed(4)),
      updatedAt,
      source: 'live',
    };

    const serialized = JSON.stringify(liveResult);

    // Guardar en caché con TTL de 12 horas y actualizar clave de respaldo permanente
    await Promise.all([
      redisClient.set(BCV_CACHE_KEY, serialized, 'EX', BCV_CACHE_TTL_SECONDS),
      redisClient.set(BCV_FALLBACK_KEY, serialized),
    ]);

    return liveResult;
  } catch (apiError) {
    console.error('[BCV Service] Error consultando API externa del BCV. Intentando fallback en Redis:', apiError);

    const fallbackRaw = await redisClient.get(BCV_FALLBACK_KEY);
    if (fallbackRaw) {
      const parsedFallback = cachedRatePayloadSchema.safeParse(JSON.parse(fallbackRaw));
      if (parsedFallback.success) {
        return {
          ...parsedFallback.data,
          source: 'fallback',
        };
      }
    }

    throw new Error(
      'No se pudo obtener la tasa BCV desde la API externa y no existe un valor de respaldo en Redis (bcv:rate:fallback).'
    );
  }
}

/**
 * Convierte un monto en USD a Bolívares (VES) usando la tasa oficial del BCV en caché/respaldo.
 */
export async function convertUsdToVes(amountUsd: number): Promise<{
  amountUsd: number;
  amountVes: number;
  bcvRate: number;
  source: BcvRateResult['source'];
}> {
  const bcv = await getBcvRate();
  const amountVes = Number((amountUsd * bcv.rate).toFixed(2));
  return {
    amountUsd,
    amountVes,
    bcvRate: bcv.rate,
    source: bcv.source,
  };
}
