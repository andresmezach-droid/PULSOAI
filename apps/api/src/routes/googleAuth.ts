import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { isGoogleCalendarConfigured } from '../config/env';
import {
  generateGoogleAuthUrl,
  handleGoogleOAuthCallback,
} from '../services/calendar';

export const googleAuthRouter = Router();

const clinicIdParamSchema = z.object({
  clinicId: z.string().uuid('clinicId debe ser un UUID válido'),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1, 'Código OAuth requerido'),
  state: z.string().uuid('El parámetro state (clinicId) debe ser un UUID válido'),
});

/**
 * GET /auth/google/callback
 * Recibe el código OAuth2 de Google, obtiene el google_refresh_token
 * y lo guarda en la tabla `clinics` de Supabase.
 */
googleAuthRouter.get('/callback', async (req: Request, res: Response): Promise<void> => {
  if (!isGoogleCalendarConfigured()) {
    res.status(501).json({
      status: 'not_implemented',
      message:
        'La integración de Google Calendar está desactivada. El sistema de agenda opera de forma 100% nativa con Supabase.',
    });
    return;
  }

  const parsedQuery = callbackQuerySchema.safeParse(req.query);

  if (!parsedQuery.success) {
    res.status(400).json({
      error: 'Parámetros de callback OAuth2 inválidos',
      details: parsedQuery.error.flatten(),
    });
    return;
  }

  try {
    const result = await handleGoogleOAuthCallback(
      parsedQuery.data.code,
      parsedQuery.data.state
    );

    res.status(200).json({
      status: 'connected',
      message: 'Google Calendar vinculado exitosamente con la clínica.',
      clinicId: result.clinicId,
      hasRefreshToken: result.hasRefreshToken,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error procesando callback de Google OAuth2';
    console.error('[GoogleAuth Callback Error]:', message);
    res.status(500).json({
      error: 'No se pudo completar la vinculación con Google Calendar',
      message,
    });
  }
});

/**
 * GET /auth/google/:clinicId
 * Redirige al administrador de la clínica a la pantalla de consentimiento de Google Calendar
 * con access_type: 'offline' y prompt: 'consent'.
 * Si las variables de Google no están configuradas, devuelve 501 Not Implemented.
 */
googleAuthRouter.get('/:clinicId', (req: Request, res: Response): void => {
  if (!isGoogleCalendarConfigured()) {
    res.status(501).json({
      status: 'not_implemented',
      message:
        'La integración de Google Calendar está desactivada. El sistema de agenda opera de forma 100% nativa con Supabase.',
    });
    return;
  }

  const parsedParams = clinicIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({
      error: 'clinicId inválido',
      details: parsedParams.error.flatten(),
    });
    return;
  }

  const authUrl = generateGoogleAuthUrl(parsedParams.data.clinicId);
  res.redirect(authUrl);
});
