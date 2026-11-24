import { API_BASE_URL, supabase } from './supabase';

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  clinicId?: string;
  requireAuth?: boolean;
}

/**
 * Cliente HTTP centralizado para comunicarse con @pulso-ai/api.
 * Adjunta automáticamente el Bearer Token (JWT de Supabase Auth) de la sesión activa.
 */
export async function apiFetch<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const { method = 'GET', body, clinicId, requireAuth = true } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requireAuth) {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new Error('Sesión no encontrada o expirada. Inicia sesión nuevamente.');
    }

    headers['Authorization'] = `Bearer ${session.access_token}`;
  }

  if (clinicId) {
    headers['X-Clinic-Id'] = clinicId;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const response = await fetch(`${API_BASE_URL}${normalizedPath}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    const errorMessage =
      typeof payload['error'] === 'string'
        ? payload['error']
        : `Error HTTP ${response.status} al invocar ${normalizedPath}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}
