import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Bot,
  CalendarCheck2,
  DollarSign,
  Magnet,
  RefreshCw,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useChatStore } from '../store/useChatStore';
import { AnalyticsSummaryResponse } from '../types/domain';

function formatShortDay(ymd: string): string {
  const parts = ymd.split('-');
  const month = parts[1] ?? '';
  const day = parts[2] ?? '';
  return `${day}/${month}`;
}

export const Analytics: React.FC = () => {
  const activeClinic = useChatStore((state) => state.activeClinic);

  const [periodDays, setPeriodDays] = useState<7 | 30 | 90>(30);
  const [summary, setSummary] = useState<AnalyticsSummaryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadAnalytics = useCallback(async () => {
    if (!activeClinic) return;
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const data = await apiFetch<AnalyticsSummaryResponse>(
        `/api/analytics/summary?days=${periodDays}`,
        {
          clinicId: activeClinic.id,
        }
      );
      setSummary(data);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudieron cargar las métricas de ROI'
      );
    } finally {
      setIsLoading(false);
    }
  }, [activeClinic, periodDays]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  const dailySeries = summary?.daily_appointments ?? [];
  const maxDailyCount = Math.max(
    1,
    ...dailySeries.map((point) => point.count)
  );

  return (
    <div className="p-6 space-y-6">
      {/* Encabezado y Selector de Período */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[#0F172A] flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-[#06B6D4]" />
            Métricas de Impacto & ROI (PULSO AI)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Rendimiento comercial de la clínica, citas agendadas y automatización 24/7 por WhatsApp.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg bg-white border border-slate-200 p-1">
            {([7, 30, 90] as const).map((daysOption) => (
              <button
                key={daysOption}
                type="button"
                onClick={() => setPeriodDays(daysOption)}
                className={`px-3.5 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition-colors ${
                  periodDays === daysOption
                    ? 'bg-[#0F172A] text-white'
                    : 'text-slate-600 hover:text-[#0F172A]'
                }`}
              >
                {daysOption} días
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void loadAnalytics()}
            title="Actualizar métricas"
            className="p-2 rounded-lg bg-white border border-slate-200 text-slate-600 hover:text-[#0F172A]"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
          {errorMsg}
        </div>
      )}

      {/* 4 Tarjetas KPI Principales */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* KPI 1: Ingresos Estimados (USD + Bs BCV) */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Ingresos Estimados ({periodDays}d)
            </span>
            <div className="w-8 h-8 rounded-lg bg-[#10B981]/15 flex items-center justify-center text-[#10B981]">
              <DollarSign className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>
          <div className="mt-4">
            <p className="text-2xl font-extrabold text-[#0F172A]">
              ${(summary?.estimated_revenue_usd ?? 0).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              <span className="text-xs font-bold text-slate-500">USD</span>
            </p>
            <p className="text-xs font-bold text-[#10B981] mt-1">
              ≈ Bs.{' '}
              {(summary?.estimated_revenue_bs ?? 0).toLocaleString('es-VE', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              (BCV)
            </p>
          </div>
        </div>

        {/* KPI 2: Citas Agendadas */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Citas Agendadas
            </span>
            <div className="w-8 h-8 rounded-lg bg-[#06B6D4]/15 flex items-center justify-center text-[#06B6D4]">
              <CalendarCheck2 className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>
          <div className="mt-4">
            <p className="text-2xl font-extrabold text-[#0F172A]">
              {summary?.appointments_booked.total ?? 0}
            </p>
            <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-500 mt-1 flex-wrap">
              <span className="text-[#0F172A]">
                Confirmadas: {summary?.appointments_booked.confirmed ?? 0}
              </span>
              <span>•</span>
              <span className="text-[#10B981]">
                Completadas: {summary?.appointments_booked.completed ?? 0}
              </span>
            </div>
          </div>
        </div>

        {/* KPI 3: Mensajes Respondidos por IA (24/7) */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Mensajes Respondidos por IA (24/7)
            </span>
            <div className="w-8 h-8 rounded-lg bg-[#0F172A] flex items-center justify-center text-[#06B6D4]">
              <Bot className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>
          <div className="mt-4">
            <p className="text-2xl font-extrabold text-[#0F172A]">
              {summary?.ai_messages_sent ?? 0}
            </p>
            <p className="text-[11px] font-semibold text-slate-500 mt-1">
              En {summary?.total_conversations ?? 0} conversaciones activas
            </p>
          </div>
        </div>

        {/* KPI 4: Leads Fríos Contactados */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Leads Fríos Contactados (24h)
            </span>
            <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center text-amber-700">
              <Magnet className="w-4 h-4 stroke-[2.5]" />
            </div>
          </div>
          <div className="mt-4">
            <p className="text-2xl font-extrabold text-[#0F172A]">
              {summary?.leads_followed_up ?? 0}
            </p>
            <p className="text-[11px] font-semibold text-slate-500 mt-1">
              Seguimiento automático en ventana gratuita
            </p>
          </div>
        </div>
      </div>

      {/* Gráfico de Barras: Tendencia diaria de citas agendadas (Últimos 14 días) */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#0F172A]">
              Tendencia Diaria de Citas Agendadas (Últimos 14 días)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Volumen diario de citas registradas en zona horaria America/Caracas.
            </p>
          </div>

          <div className="flex items-center gap-4 text-xs font-semibold text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#06B6D4]" />
              Citas por día
            </span>
          </div>
        </div>

        {isLoading && !summary ? (
          <div className="h-56 flex items-center justify-center text-xs text-slate-500">
            Calculando tendencia de citas...
          </div>
        ) : (
          <div className="h-60 pt-6 flex items-end justify-between gap-2 sm:gap-3 px-2">
            {dailySeries.map((point) => {
              const heightPercent = Math.round(
                (point.count / maxDailyCount) * 100
              );
              const barHeight = point.count > 0 ? Math.max(heightPercent, 14) : 4;

              return (
                <div
                  key={point.date}
                  className="flex-1 flex flex-col items-center justify-end h-full group"
                >
                  <span className="text-[11px] font-bold text-[#0F172A] mb-1.5">
                    {point.count}
                  </span>
                  <div className="w-full max-w-[38px] h-40 bg-slate-100 rounded-t-lg flex items-end overflow-hidden">
                    <div
                      style={{ height: `${barHeight}%` }}
                      className={`w-full rounded-t-lg transition-all duration-300 ${
                        point.count > 0
                          ? 'bg-[#06B6D4] group-hover:bg-[#0F172A]'
                          : 'bg-slate-200'
                      }`}
                    />
                  </div>
                  <span className="text-[10px] font-semibold text-slate-500 mt-2">
                    {formatShortDay(point.date)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
