import React, { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Session } from '@supabase/supabase-js';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { supabase } from './lib/supabase';
import { Analytics } from './pages/Analytics';
import { Calendar } from './pages/Calendar';
import { Inbox } from './pages/Inbox';
import { Login } from './pages/Login';
import { Services } from './pages/Services';
import { Settings } from './pages/Settings';
import { SuperAdmin } from './pages/SuperAdmin';
import { useChatStore } from './store/useChatStore';
import { Clinic, ClinicUser } from './types/domain';

interface MembershipWithClinic extends ClinicUser {
  clinics: Clinic | null;
}

export const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [tenantError, setTenantError] = useState<string | null>(null);

  const setClinicContext = useChatStore((state) => state.setClinicContext);
  const fetchBcvRate = useChatStore((state) => state.fetchBcvRate);
  const fetchConversations = useChatStore((state) => state.fetchConversations);
  const subscribeToRealtime = useChatStore((state) => state.subscribeToRealtime);
  const unsubscribeFromRealtime = useChatStore(
    (state) => state.unsubscribeFromRealtime
  );

  useEffect(() => {
    let mounted = true;

    async function hydrateTenantContext(activeSession: Session | null) {
      if (!activeSession?.user) {
        setClinicContext(null, null, false);
        unsubscribeFromRealtime();
        if (mounted) {
          setIsInitializing(false);
        }
        return;
      }

      setTenantError(null);

      // Consultar membresía de clínica y si el usuario pertenece a platform_admins en paralelo
      const [membershipRes, platformAdminRes] = await Promise.all([
        supabase
          .from('clinic_users')
          .select(
            `
            id,
            clinic_id,
            user_id,
            role,
            full_name,
            is_active,
            clinics (*)
          `
          )
          .eq('user_id', activeSession.user.id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle<MembershipWithClinic>(),
        supabase
          .from('platform_admins')
          .select('user_id')
          .eq('user_id', activeSession.user.id)
          .maybeSingle<{ user_id: string }>(),
      ]);

      const membershipData = membershipRes.data;
      const membershipError = membershipRes.error;
      const isPlatformAdmin = Boolean(platformAdminRes.data?.user_id);

      if (membershipError || !membershipData || !membershipData.clinics) {
        if (mounted) {
          setTenantError(
            membershipError?.message ||
              'Tu usuario de Supabase Auth no está asignado a ninguna clínica activa en la tabla clinic_users.'
          );
          setIsInitializing(false);
        }
        return;
      }

      const clinic = membershipData.clinics;
      const membership: ClinicUser = {
        id: membershipData.id,
        clinic_id: membershipData.clinic_id,
        user_id: membershipData.user_id,
        role: membershipData.role,
        full_name: membershipData.full_name,
        is_active: membershipData.is_active,
      };

      setClinicContext(clinic, membership, isPlatformAdmin);
      void fetchBcvRate();
      await fetchConversations(clinic.id);
      subscribeToRealtime(clinic.id);

      if (mounted) {
        setIsInitializing(false);
      }
    }

    void supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      if (!mounted) return;
      setSession(initialSession);
      void hydrateTenantContext(initialSession);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      void hydrateTenantContext(nextSession);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
      unsubscribeFromRealtime();
    };
  }, [
    fetchBcvRate,
    fetchConversations,
    setClinicContext,
    subscribeToRealtime,
    unsubscribeFromRealtime,
  ]);

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-[#0F172A] text-white flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-8 h-8 rounded-lg bg-[#06B6D4] mx-auto animate-pulse" />
          <p className="text-xs font-bold uppercase tracking-widest text-slate-300">
            Iniciando PULSO AI...
          </p>
        </div>
      </div>
    );
  }

  if (session && tenantError) {
    return (
      <div className="min-h-screen bg-[#0F172A] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white text-[#0F172A] rounded-xl p-6 space-y-4 shadow-xl">
          <h2 className="text-base font-bold text-red-600">
            Usuario sin Clínica Asignada
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed">{tenantError}</p>
          <button
            type="button"
            onClick={() => void supabase.auth.signOut()}
            className="w-full py-2.5 rounded-lg bg-[#0F172A] text-white text-xs font-bold uppercase tracking-wider"
          >
            Cerrar Sesión
          </button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={session ? <Navigate to="/inbox" replace /> : <Login />}
        />
        <Route
          path="/"
          element={
            <ProtectedRoute session={session}>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/inbox" replace />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="services" element={<Services />} />
          <Route path="settings" element={<Settings />} />
          <Route path="super-admin" element={<SuperAdmin />} />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
};
