import cors from 'cors';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { IncomingMessage, ServerResponse } from 'http';
import { env } from './config/env';
import { redisClient } from './config/redis';
import { supabaseAdmin } from './config/supabase';
import { adminRouter } from './routes/admin';
import { analyticsRouter } from './routes/analytics';
import { bcvRouter } from './routes/bcv';
import { googleAuthRouter } from './routes/googleAuth';
import { messagesRouter } from './routes/messages';
import { RawBodyRequest, webhookRouter } from './routes/webhook';
import {
  followupsWorker,
  scheduleRecurringFollowupsJob,
} from './workers/followups';
import { incomingMessagesWorker } from './workers/messageQueue';
import {
  remindersWorker,
  scheduleRecurringRemindersJob,
} from './workers/reminders';

const app = express();

// Seguridad HTTP (Helmet) y CORS habilitando el origen del Dashboard (local y Cloudflare Pages/Workers)
const allowedOrigin = process.env['VITE_APP_URL'] || 'http://localhost:5173';

app.use(helmet());
app.use(
  cors({
    origin: [
      allowedOrigin,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'https://pulsoai.andresmezach.workers.dev',
      /\.workers\.dev$/,
      /\.pages\.dev$/,
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Clinic-Id'],
  })
);

// Rate Limiter aplicado exclusivamente a /api/* (sin bloquear /webhook de Meta)
const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 300, // 300 peticiones por IP cada 15 minutos para el Dashboard
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      'Demasiadas solicitudes desde esta IP. Por favor intenta nuevamente en unos minutos.',
  },
});

app.use('/api', apiRateLimiter);

// Captura del buffer rawBody necesaria para validar X-Hub-Signature-256 (HMAC-SHA256)
app.use(
  express.json({
    limit: '2mb',
    verify: (req: IncomingMessage, _res: ServerResponse, buf: Buffer) => {
      (req as RawBodyRequest).rawBody = Buffer.from(buf);
    },
  })
);

/**
 * GET /health
 * Verifica conectividad en tiempo real con Redis y Supabase
 */
app.get('/health', async (_req: Request, res: Response): Promise<void> => {
  let redisOk = false;
  let supabaseOk = false;
  let redisError: string | null = null;
  let supabaseError: string | null = null;

  // 1. Ping Redis
  try {
    const pong = await redisClient.ping();
    redisOk = pong === 'PONG';
  } catch (err) {
    redisError = err instanceof Error ? err.message : 'Unknown Redis error';
  }

  // 2. Consulta ligera a Supabase
  try {
    const { error } = await supabaseAdmin
      .from('clinics')
      .select('id', { count: 'exact', head: true })
      .limit(1);

    if (error) {
      supabaseError = error.message;
    } else {
      supabaseOk = true;
    }
  } catch (err) {
    supabaseError = err instanceof Error ? err.message : 'Unknown Supabase error';
  }

  const isHealthy = redisOk && supabaseOk;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    service: '@pulso-ai/api',
    timestamp: new Date().toISOString(),
    checks: {
      redis: {
        connected: redisOk,
        error: redisError,
      },
      supabase: {
        connected: supabaseOk,
        error: supabaseError,
      },
      workers: {
        incomingMessages: incomingMessagesWorker.isRunning(),
        reminders: remindersWorker.isRunning(),
        followups: followupsWorker.isRunning(),
      },
    },
  });
});

// Rutas de Tasa BCV (/api/bcv y alias /api/bcv-rate)
app.use('/api/bcv', bcvRouter);
app.use('/api/bcv-rate', bcvRouter);

// Rutas protegidas del Dashboard Mini-CRM (Mensajes manuales, toggle de IA y verificación de pago)
app.use('/api/conversations', messagesRouter);

// Rutas protegidas de Métricas de ROI (/api/analytics/summary)
app.use('/api/analytics', analyticsRouter);

// Rutas protegidas de Super-Admin (/api/admin/clinics, /api/admin/clinics/onboard, /api/admin/clinics/:id/status)
app.use('/api/admin', adminRouter);

// Rutas del Webhook de Meta WhatsApp Cloud API (Exentas de rate limit de /api)
app.use('/webhook', webhookRouter);

// Rutas OAuth2 de Google Calendar por clínica (opcional)
app.use('/auth/google', googleAuthRouter);

// Arranque del servidor y programación de workers repetitivos
const server = app.listen(env.PORT, () => {
  console.info(`🚀 [PULSO AI API] Servidor corriendo en http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.info(`📡 [Webhook Meta] Escuchando en http://localhost:${env.PORT}/webhook`);
  console.info(`📊 [Analytics]    Disponible en http://localhost:${env.PORT}/api/analytics/summary`);
  console.info(`🛡️  [Super-Admin]  Disponible en http://localhost:${env.PORT}/api/admin/clinics`);
  console.info(`🩺 [Healthcheck]  Disponible en http://localhost:${env.PORT}/health`);

  void scheduleRecurringRemindersJob().catch((err: unknown) => {
    console.error('[RemindersWorker] Error registrando job repetitivo:', err);
  });

  void scheduleRecurringFollowupsJob().catch((err: unknown) => {
    console.error('[FollowupsWorker] Error registrando job repetitivo:', err);
  });
});

// Apagado elegante (Graceful Shutdown)
async function gracefulShutdown(signal: string): Promise<void> {
  console.info(`\n[PULSO AI API] Recibida señal ${signal}. Cerrando servidor y conexiones...`);
  server.close();
  await Promise.all([
    incomingMessagesWorker.close(),
    remindersWorker.close(),
    followupsWorker.close(),
  ]);
  await redisClient.quit();
  process.exit(0);
}

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
