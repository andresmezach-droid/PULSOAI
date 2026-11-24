import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Carga variables desde apps/api/.env (resuelto respecto a este archivo) o desde process.cwd()
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Normaliza strings vacíos a undefined para variables opcionales
const optionalNonEmptyString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().min(1).optional()
);

const optionalUrlString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().url().optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL debe ser una URL válida'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY es requerido'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY es requerido'),

  // Redis
  REDIS_URL: z.string().url('REDIS_URL debe ser una URL válida (ej. redis://127.0.0.1:6379)'),

  // Meta WhatsApp Cloud API
  META_API_VERSION: z.string().default('v21.0'),
  META_VERIFY_TOKEN: z.string().min(8, 'META_VERIFY_TOKEN debe tener al menos 8 caracteres'),
  META_APP_SECRET: z.string().min(8, 'META_APP_SECRET es obligatorio para validar X-Hub-Signature-256'),
  META_SYSTEM_ACCESS_TOKEN: z.string().min(1, 'META_SYSTEM_ACCESS_TOKEN es requerido'),

  // BCV API
  BCV_API_URL: z.string().url().default('https://ve.dolarapi.com/v1/dolares/oficial'),

  // Google Gemini AI (Fase 2)
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY es requerido para el motor de IA'),

  // Google Calendar OAuth2 (Opcionales: el sistema de agenda funciona 100% nativo con Supabase)
  GOOGLE_CLIENT_ID: optionalNonEmptyString,
  GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
  GOOGLE_REDIRECT_URI: optionalUrlString,

  // Encriptación AES-256-GCM en Reposo (Fase 4: hex de 32 bytes / 64 caracteres)
  ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'ENCRYPTION_KEY debe ser una cadena hexadecimal de 64 caracteres (32 bytes para AES-256-GCM)'
    ),
});

export type EnvConfig = z.infer<typeof envSchema>;

function validateEnv(): EnvConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('❌ Error crítico de configuración: Variables de entorno inválidas o faltantes:');
    for (const issue of parsed.error.issues) {
      console.error(`  - [${issue.path.join('.')}]: ${issue.message}`);
    }
    process.exit(1);
  }

  return parsed.data;
}

export const env: EnvConfig = validateEnv();

/**
 * Helper que indica si las credenciales OAuth2 de Google Calendar están configuradas en el entorno.
 */
export function isGoogleCalendarConfigured(): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI
  );
}
