import { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';

export interface SuperAdminContext {
  userId: string;
  email?: string;
}

export interface SuperAdminRequest extends Request {
  superAdmin?: SuperAdminContext;
}

/**
 * Middleware de seguridad para rutas de Super-Admin (`/api/admin/*`).
 * 1. Valida el JWT de Supabase enviado en `Authorization: Bearer <token>`.
 * 2. Verifica en la tabla `platform_admins` (usando `service_role`) que exista el `user.id`.
 * 3. Si no pertenece a `platform_admins`, devuelve `403 Forbidden`.
 */
export async function requireSuperAdmin(
  req: SuperAdminRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'No autorizado: Header Authorization Bearer token ausente.',
    });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({
      error: 'No autorizado: Token vacío.',
    });
    return;
  }

  try {
    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      res.status(401).json({
        error: 'Sesión inválida o expirada en Supabase Auth.',
      });
      return;
    }

    const { data: adminRecord, error: adminErr } = await supabaseAdmin
      .from('platform_admins')
      .select('user_id, created_at')
      .eq('user_id', user.id)
      .maybeSingle<{ user_id: string; created_at: string }>();

    if (adminErr || !adminRecord) {
      res.status(403).json({
        error:
          'Acceso denegado (403 Forbidden): Tu cuenta no posee privilegios de Super-Admin en platform_admins.',
      });
      return;
    }

    req.superAdmin = {
      userId: user.id,
      email: user.email,
    };

    next();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error verificando Super-Admin';
    console.error('[SuperAdminMiddleware Error]:', message);
    res.status(500).json({
      error: 'Error interno al verificar permisos de Super-Admin.',
    });
  }
}
