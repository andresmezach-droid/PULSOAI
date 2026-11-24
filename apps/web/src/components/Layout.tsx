import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  BarChart3,
  Building2,
  CalendarDays,
  DollarSign,
  LogOut,
  MessageSquare,
  RefreshCw,
  Settings,
  ShieldAlert,
  Stethoscope,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useChatStore } from '../store/useChatStore';

export const Layout: React.FC = () => {
  const activeClinic = useChatStore((state) => state.activeClinic);
  const clinicMembership = useChatStore((state) => state.clinicMembership);
  const isPlatformAdmin = useChatStore((state) => state.isPlatformAdmin);
  const bcvRate = useChatStore((state) => state.bcvRate);
  const conversations = useChatStore((state) => state.conversations);
  const fetchBcvRate = useChatStore((state) => state.fetchBcvRate);

  const totalUnread = conversations.reduce((acc, c) => acc + (c.unread_count || 0), 0);
  const escalatedCount = conversations.filter(
    (c) => !c.ai_enabled || Boolean(c.escalation_reason)
  ).length;

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const navItems: Array<{
    to: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
    alertBadge?: number;
  }> = [
    {
      to: '/inbox',
      label: 'Inbox (Chats)',
      icon: MessageSquare,
      badge: totalUnread > 0 ? totalUnread : undefined,
      alertBadge: escalatedCount > 0 ? escalatedCount : undefined,
    },
    {
      to: '/analytics',
      label: 'Métricas (ROI)',
      icon: BarChart3,
    },
    {
      to: '/calendar',
      label: 'Agenda (Citas)',
      icon: CalendarDays,
    },
    {
      to: '/services',
      label: 'Servicios y Precios',
      icon: Stethoscope,
    },
    {
      to: '/settings',
      label: 'Configuración',
      icon: Settings,
    },
    ...(isPlatformAdmin
      ? [
          {
            to: '/super-admin',
            label: 'Super-Admin',
            icon: ShieldAlert,
          },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex">
      {/* Sidebar fijo izquierda (#0F172A) */}
      <aside className="w-64 bg-[#0F172A] text-white flex flex-col fixed inset-y-0 left-0 z-30 border-r border-slate-800">
        {/* Logotipo tipográfico PULSO AI */}
        <div className="h-16 px-4 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-2.5 w-full">
            <img
              src="/favicon.jpg"
              alt="PULSO AI Isotipo"
              className="w-9 h-9 rounded-lg object-contain bg-white p-0.5 shrink-0 shadow-sm"
            />
            <div className="min-w-0">
              <div className="flex items-center tracking-tight text-lg font-extrabold leading-none">
                <span className="text-white">PULSO</span>
                <span className="text-[#06B6D4]">AI</span>
              </div>
              <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400 block mt-1 truncate">
                SMART MEDICAL SCHEDULING
              </span>
            </div>
          </div>
        </div>

        {/* Tarjeta resumen de Clínica Activa */}
        <div className="px-4 py-4 border-b border-slate-800/80">
          <div className="p-3 rounded-lg bg-slate-900/90 border border-slate-800">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Building2 className="w-3.5 h-3.5 text-[#06B6D4] shrink-0" />
              <span className="truncate">
                {activeClinic?.name ?? 'Sin clínica asignada'}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
              <span className="uppercase font-medium">
                Rol: {clinicMembership?.role ?? 'staff'}
              </span>
              <span className="inline-flex items-center gap-1 text-[#10B981] font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />
                Realtime
              </span>
            </div>
          </div>
        </div>

        {/* Navegación principal */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-[#06B6D4] text-[#0F172A] font-bold shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                  }`
                }
              >
                <div className="flex items-center gap-3">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {item.alertBadge !== undefined && (
                    <span
                      title="Conversaciones con IA pausada o escaladas a humano"
                      className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-500 text-[#0F172A]"
                    >
                      {item.alertBadge}
                    </span>
                  )}
                  {item.badge !== undefined && (
                    <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-[#10B981] text-[#0F172A]">
                      {item.badge}
                    </span>
                  )}
                </div>
              </NavLink>
            );
          })}
        </nav>

        {/* Footer Usuario en Sidebar */}
        <div className="p-4 border-t border-slate-800">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white truncate">
              {clinicMembership?.full_name ?? 'Especialista / Recepción'}
            </p>
            <p className="text-[11px] text-slate-400 truncate">
              Zona: {activeClinic?.timezone ?? 'America/Caracas'}
            </p>
          </div>
        </div>
      </aside>

      {/* Contenedor derecho */}
      <div className="flex-1 pl-64 flex flex-col min-h-screen">
        {/* Header superior mostrando clínica activa, Tasa BCV del día y botón de cerrar sesión */}
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded bg-[#0F172A] text-[#06B6D4]">
              Clínica Activa
            </span>
            <h2 className="text-sm font-bold text-[#0F172A]">
              {activeClinic?.name ?? 'Cargando clínica...'}
            </h2>
            {activeClinic?.whatsapp_display_phone && (
              <span className="text-xs font-medium text-slate-500">
                • WhatsApp: {activeClinic.whatsapp_display_phone}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Indicador Tasa BCV del día */}
            <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-[#0F172A] text-white text-xs">
              <DollarSign className="w-3.5 h-3.5 text-[#10B981]" />
              <span className="font-medium text-slate-300">Tasa BCV del día:</span>
              <span className="font-bold text-[#10B981]">
                {bcvRate ? `Bs. ${bcvRate.rate.toFixed(2)} / USD` : 'Consultando...'}
              </span>
              <button
                type="button"
                onClick={() => void fetchBcvRate()}
                title="Actualizar tasa BCV"
                className="ml-1 text-slate-400 hover:text-[#06B6D4] transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Botón de Cerrar Sesión en el Header */}
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-xs font-bold text-[#0F172A] flex items-center gap-1.5 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5 text-slate-500" />
              Cerrar Sesión
            </button>
          </div>
        </header>

        {/* Contenido de la vista activa */}
        <main className="flex-1 flex flex-col">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
