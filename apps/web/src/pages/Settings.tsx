import React, { useEffect, useState } from 'react';
import {
  Clock,
  CreditCard,
  Save,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useChatStore } from '../store/useChatStore';
import { DayBusinessHours, WeeklyBusinessHours } from '../types/domain';

const DEFAULT_HOURS: WeeklyBusinessHours = {
  monday: { enabled: true, start: '08:00', end: '17:00' },
  tuesday: { enabled: true, start: '08:00', end: '17:00' },
  wednesday: { enabled: true, start: '08:00', end: '17:00' },
  thursday: { enabled: true, start: '08:00', end: '17:00' },
  friday: { enabled: true, start: '08:00', end: '17:00' },
  saturday: { enabled: true, start: '09:00', end: '13:00' },
  sunday: { enabled: false, start: '09:00', end: '13:00' },
};

const DAY_LABELS: Array<{ key: keyof WeeklyBusinessHours; label: string }> = [
  { key: 'monday', label: 'Lunes' },
  { key: 'tuesday', label: 'Martes' },
  { key: 'wednesday', label: 'Miércoles' },
  { key: 'thursday', label: 'Jueves' },
  { key: 'friday', label: 'Viernes' },
  { key: 'saturday', label: 'Sábado' },
  { key: 'sunday', label: 'Domingo' },
];

export const Settings: React.FC = () => {
  const activeClinic = useChatStore((state) => state.activeClinic);
  const refreshActiveClinic = useChatStore((state) => state.refreshActiveClinic);

  const [businessHours, setBusinessHours] =
    useState<WeeklyBusinessHours>(DEFAULT_HOURS);
  const [paymentMethodsText, setPaymentMethodsText] = useState(
    'Pago Móvil (Tasa BCV), Zelle, Efectivo USD, Punto de Venta, Cashea'
  );
  const [systemPromptExtra, setSystemPromptExtra] = useState('');
  const [whatsappAccessToken, setWhatsappAccessToken] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!activeClinic) return;

    if (activeClinic.business_hours) {
      setBusinessHours({
        ...DEFAULT_HOURS,
        ...activeClinic.business_hours,
      });
    }

    if (
      activeClinic.payment_methods &&
      activeClinic.payment_methods.length > 0
    ) {
      setPaymentMethodsText(activeClinic.payment_methods.join(', '));
    }

    setSystemPromptExtra(activeClinic.system_prompt_extra ?? '');
  }, [activeClinic]);

  const handleDayChange = (
    dayKey: keyof WeeklyBusinessHours,
    field: keyof DayBusinessHours,
    value: boolean | string
  ) => {
    setBusinessHours((prev) => ({
      ...prev,
      [dayKey]: {
        ...prev[dayKey],
        [field]: value,
      },
    }));
  };

  const handleSaveSettings = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeClinic) return;

    setIsSaving(true);
    setFeedbackMsg(null);

    const paymentMethodsArray = paymentMethodsText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const updatePayload: Record<string, unknown> = {
      business_hours: businessHours,
      payment_methods: paymentMethodsArray,
      system_prompt_extra: systemPromptExtra.trim() || null,
    };

    if (whatsappAccessToken.trim().length > 10) {
      updatePayload['whatsapp_access_token'] = whatsappAccessToken.trim();
    }

    const { error } = await supabase
      .from('clinics')
      .update(updatePayload)
      .eq('id', activeClinic.id);

    if (error) {
      setFeedbackMsg({
        type: 'error',
        text: `Error guardando configuración: ${error.message}`,
      });
    } else {
      await refreshActiveClinic();
      setFeedbackMsg({
        type: 'success',
        text: 'Configuración de la clínica actualizada exitosamente.',
      });
    }

    setIsSaving(false);
  };

  return (
    <div className="p-6 max-w-5xl space-y-6">
      {/* Encabezado */}
      <div>
        <h1 className="text-xl font-bold text-[#0F172A] flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-[#06B6D4]" />
          Configuración de la Clínica & Motor IA
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          Personaliza los horarios de atención por día (business_hours), métodos de pago en Venezuela y las instrucciones adicionales para PULSO AI.
        </p>
      </div>

      {feedbackMsg && (
        <div
          className={`p-4 rounded-xl border text-xs font-semibold ${
            feedbackMsg.type === 'success'
              ? 'bg-[#10B981]/10 border-[#10B981]/30 text-[#0F172A]'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {feedbackMsg.text}
        </div>
      )}

      {/* Formulario Principal */}
      <form onSubmit={handleSaveSettings} className="space-y-6">
        {/* Tarjeta 1: Métodos de Pago, Token de WhatsApp y System Prompt Extra */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-5">
          <div>
            <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#0F172A] mb-2">
              Token de Acceso de Meta WhatsApp (Opcional: sobrescribe el token del servidor)
            </label>
            <input
              type="password"
              value={whatsappAccessToken}
              onChange={(e) => setWhatsappAccessToken(e.target.value)}
              placeholder="Pega aquí tu nuevo Token de acceso de Meta (EAAg5...) si el anterior caducó"
              className="w-full px-4 py-2.5 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#0F172A] mb-2">
              <CreditCard className="w-4 h-4 text-[#06B6D4]" />
              Métodos de Pago Aceptados (Pago Móvil, Zelle, Cashea, Efectivo USD, etc.)
            </label>
            <input
              type="text"
              value={paymentMethodsText}
              onChange={(e) => setPaymentMethodsText(e.target.value)}
              placeholder="Pago Móvil (Tasa BCV), Zelle, Efectivo USD, Punto de Venta, Cashea"
              className="w-full px-4 py-2.5 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#0F172A] mb-2">
              <Sparkles className="w-4 h-4 text-[#06B6D4]" />
              Ubicación, Políticas e Instrucciones Especiales para la IA (system_prompt_extra)
            </label>
            <textarea
              rows={4}
              value={systemPromptExtra}
              onChange={(e) => setSystemPromptExtra(e.target.value)}
              placeholder="Ej. Estamos ubicados en el C.C. San Ignacio, Torre Copérnico, Piso 3, Chacao, Caracas. Contamos con estacionamiento privado. La Dra. Valentina atiende valoraciones estéticas de lunes a viernes..."
              className="w-full px-4 py-2.5 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
            />
          </div>
        </div>

        {/* Tarjeta 2: Horarios de Atención (business_hours) */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
            <Clock className="w-4 h-4 text-[#06B6D4]" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#0F172A]">
              Horarios de Atención por Día (America/Caracas)
            </h2>
          </div>

          <div className="divide-y divide-slate-100">
            {DAY_LABELS.map(({ key, label }) => {
              const dayCfg = businessHours[key];
              return (
                <div
                  key={key}
                  className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <label className="inline-flex items-center gap-2.5 text-sm font-bold text-[#0F172A] cursor-pointer w-40">
                    <input
                      type="checkbox"
                      checked={dayCfg.enabled}
                      onChange={(e) =>
                        handleDayChange(key, 'enabled', e.target.checked)
                      }
                      className="rounded border-slate-300 text-[#06B6D4] focus:ring-[#06B6D4]"
                    />
                    {label}
                  </label>

                  {dayCfg.enabled ? (
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-500">
                          Apertura:
                        </span>
                        <input
                          type="time"
                          value={dayCfg.start}
                          onChange={(e) =>
                            handleDayChange(key, 'start', e.target.value)
                          }
                          className="px-3 py-1.5 text-xs font-semibold bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-500">
                          Cierre:
                        </span>
                        <input
                          type="time"
                          value={dayCfg.end}
                          onChange={(e) =>
                            handleDayChange(key, 'end', e.target.value)
                          }
                          className="px-3 py-1.5 text-xs font-semibold bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Cerrado
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isSaving}
            className="px-6 py-2.5 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4 text-[#10B981]" />
            {isSaving ? 'Guardando cambios...' : 'Guardar Configuración'}
          </button>
        </div>
      </form>
    </div>
  );
};
