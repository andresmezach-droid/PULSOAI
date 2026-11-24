import { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { ClinicUserRole, ClinicUserRow } from '../types/database';

export interface AuthContext {
  userId: string;
  clinicId: string;
  role: ClinicUserRole;
  email?: string;
  fullName?: string | null;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/**
 * Middleware de autenticación JWT de Supabase.
 * 1. Valida el header `Authorization: Bearer <token>` usando Supabase Auth.
 * 2. Verifica en la tabla `clinic_users` a qué `clinic_id` pertenece el usuario autenticado.
 * 3. Inyecta `{ userId, clinicId, role }` en `req.auth`.
 */
export async function requireClinicAuth(
  req: AuthenticatedRequest,
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

    const requestedClinicId = req.header('X-Clinic-Id');

    let query = supabaseAdmin
      .from('clinic_users')
      .select('id, clinic_id, user_id, role, full_name, is_active')
      .eq('user_id', user.id)
      .eq('is_active', true);

    if (requestedClinicId) {
      query = query.eq('clinic_id', requestedClinicId);
    }

    const { data: memberships, error: membershipErr } = await query
      .limit(1)
      .returns<
        Array<
          Pick<
            ClinicUserRow,
            'id' | 'clinic_id' | 'user_id' | 'role' | 'full_name' | 'is_active'
          >
        >
      >();

    if (membershipErr || !memberships || memberships.length === 0) {
      res.status(403).json({
        error:
          'Acceso denegado: El usuario no está vinculado a ninguna clínica activa en clinic_users.',
      });
      return;
    }

    const membership = memberships[0];
    if (!membership) {
      res.status(403).json({
        error: 'Acceso denegado: Membresía de clínica no encontrada.',
      });
      return;
    }

    req.auth = {
      userId: user.id,
      clinicId: membership.clinic_id,
      role: membership.role,
      email: user.email,
      fullName: membership.full_name,
    };

    next();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error verificando autenticación';
    console.error('[AuthMiddleware Error]:', message);
    res.status(500).json({
      error: 'Error interno al verificar credenciales.',
    });
  }
}
