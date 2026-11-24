import React from 'react';
import { Navigate } from 'react-router-dom';
import { Session } from '@supabase/supabase-js';

interface ProtectedRouteProps {
  session: Session | null;
  children: React.ReactNode;
}

/**
 * Protege las rutas privadas del Dashboard Mini-CRM redirigiendo a /login
 * cuando no existe sesión activa en Supabase Auth.
 */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  session,
  children,
}) => {
  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};
