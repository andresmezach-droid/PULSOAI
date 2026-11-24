import Redis from 'ioredis';
import { env } from './env';

let lastRedisWarningAt = 0;
const WARNING_THROTTLE_MS = 15000;

function logRedisErrorThrottled(source: string, message: string): void {
  const now = Date.now();
  if (now - lastRedisWarningAt >= WARNING_THROTTLE_MS) {
    lastRedisWarningAt = now;
    console.warn(
      `⚠️ [${source}] No se pudo conectar a Redis (${env.REDIS_URL}): ${message}. (Verifica que Docker Redis o Upstash esté activo).`
    );
  }
}

/**
 * Estrategia de reconexión suave para evitar saturar la consola si Redis local está apagado
 */
function buildRetryStrategy(times: number): number {
  return Math.min(times * 1000, 10000);
}

/**
 * Cliente Redis principal para caché (Tasa BCV, locks, etc.)
 */
export const redisClient = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy: buildRetryStrategy,
});

redisClient.on('error', (err: Error) => {
  logRedisErrorThrottled('Redis Client', err.message);
});

/**
 * Crea una nueva conexión Redis compatible con los requisitos de BullMQ
 * (BullMQ exige maxRetriesPerRequest: null para Workers y QueueEvents).
 */
export function createBullMQRedisConnection(): Redis {
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: buildRetryStrategy,
  });

  connection.on('error', (err: Error) => {
    logRedisErrorThrottled('BullMQ Redis', err.message);
  });

  return connection;
}
