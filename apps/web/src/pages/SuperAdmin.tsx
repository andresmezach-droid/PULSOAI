import React, { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  Check,
  Plus,
  RefreshCw,
  ShieldAlert,
  ToggleLeft,
  ToggleRight,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { AdminClinicSummary, ClinicSpecialty } from '../types/domain';

interface OnboardFormState {
  name: string;
  specialty: ClinicSpecialty;
  whatsapp_phone_id: string;
  whatsapp_access_token: string;
  whatsapp_display_phone: string;
  admin_email: string;
  admin_password: string;
  admin_full_name: string;
}

const initialOnboardForm: OnboardFormState = {
  name: '',
  specialty: 'odontologia',
  whatsapp_phone_id: '',
  whatsapp_access_token: '',
  whatsapp_display_phone: '',
  admin_email: '',
  admin_password: '',
  admin_full_name: '',
};

export const SuperAdmin: React.FC = () => {
  const [clinics, setClinics] = useState<AdminClinicSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<OnboardFormState>(initialOnboardForm);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadClinics = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const data = await apiFetch<{ clinics: AdminClinicSummary[] }>(
        '/api/admin/clinics'
      );
      setClinics(data.clinics ?? []);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudo cargar la lista global de clínicas'
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadClinics();
  }, [loadClinics]);

  const handleToggleClinicStatus = async (clinic: AdminClinicSummary) => {
    setTogglingId(clinic.id);
    setErrorMsg(null);
    setSuccessMsg(null);

    const nextActive = !clinic.is_active;

    try {
      await apiFetch<{ clinic: AdminClinicSummary }>(
        `/api/admin/clinics/${encodeURIComponent(clinic.id)}/status`,
        {
          method: 'PATCH',
          body: { is_active: nextActive },
        }
      );

      setClinics((prev) =>
        prev.map((c) =>
          c.id === clinic.id ? { ...c, is_active: nextActive } : c
        )
      );
      setSuccessMsg(
        `Clínica "${clinic.name}" ${nextActive ? 'activada' : 'suspendida'} correctamente.`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Error actualizando el estado de la clínica'
      );
    } finally {
      setTogglingId(null);
    }
  };

  const handleOnboardSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsCreating(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const response = await apiFetch<{
        message: string;
        clinic: AdminClinicSummary;
      }>('/api/admin/clinics/onboard', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          specialty: form.specialty,
          whatsapp_phone_id: form.whatsapp_phone_id.trim(),
          whatsapp_access_token: form.whatsapp_access_token.trim(),
          whatsapp_display_phone:
            form.whatsapp_display_phone.trim() || undefined,
          admin_email: form.admin_email.trim(),
          admin_password: form.admin_password,
          admin_full_name: form.admin_full_name.trim() || undefined,
        },
      });

      setShowModal(false);
      setForm(initialOnboardForm);
      setSuccessMsg(
        response.message || 'Clínica creada y token cifrado con AES-256-GCM.'
      );
      await loadClinics();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudo completar el onboarding de la clínica'
      );
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header Super-Admin */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-[#06B6D4]" />
            <h1 className="text-xl font-bold text-[#0F172A]">
              Panel Super-Admin — Gestión Multi-Tenant & MRR
            </h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Onboarding en 1 clic con cifrado AES-256-GCM y control de suscripciones activas/suspendidas.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadClinics()}
            title="Recargar clínicas"
            className="p-2 rounded-lg bg-white border border-slate-200 text-slate-600 hover:text-[#0F172A]"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => {
              setErrorMsg(null);
              setShowModal(true);
            }}
            className="px-4 py-2.5 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-colors"
          >
            <Plus className="w-4 h-4 text-[#06B6D4]" />
            + Nueva Clínica
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
          {errorMsg}
        </div>
      )}

      {successMsg && (
        <div className="p-3.5 rounded-lg bg-[#10B981]/10 border border-[#10B981]/30 text-xs font-bold text-[#0F172A]">
          {successMsg}
        </div>
      )}

      {/* Modal "+ Nueva Clínica" (Onboarding Rápido) */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-[#0F172A]/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full shadow-2xl overflow-hidden">
            <div className="bg-[#0F172A] px-6 py-4 flex items-center justify-between text-white">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[#06B6D4]" />
                <h2 className="text-sm font-bold uppercase tracking-wider">
                  Onboarding Rápido de Nueva Clínica
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={handleOnboardSubmit}
              className="p-6 space-y-4 text-xs"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                    Nombre de la Clínica *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Ej. Clínica Estética Las Mercedes"
                    className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                  />
                </div>

                <div>
                  <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                    Especialidad *
                  </label>
                  <select
                    value={form.specialty}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        specialty: e.target.value as ClinicSpecialty,
                      })
                    }
                    className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                  >
                    <option value="odontologia">Odontología</option>
                    <option value="medicina_estetica">Medicina Estética</option>
                    <option value="ambas">Ambas (Odontología + Estética)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                    WhatsApp Phone Number ID (Meta) *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.whatsapp_phone_id}
                    onChange={(e) =>
                      setForm({ ...form, whatsapp_phone_id: e.target.value })
                    }
                    placeholder="Ej. 109876543210"
                    className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                  />
                </div>

                <div>
                  <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                    Teléfono Visible (Opcional)
                  </label>
                  <input
                    type="text"
                    value={form.whatsapp_display_phone}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        whatsapp_display_phone: e.target.value,
                      })
                    }
                    placeholder="Ej. +58 412-1234567"
                    className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                  WhatsApp Access Token (Se cifrará con AES-256-GCM) *
                </label>
                <input
                  type="password"
                  required
                  value={form.whatsapp_access_token}
                  onChange={(e) =>
                    setForm({ ...form, whatsapp_access_token: e.target.value })
                  }
                  placeholder="EAAG..."
                  className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                />
              </div>

              <div className="pt-2 border-t border-slate-200">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[#06B6D4] mb-3">
                  Cuenta del Administrador de la Clínica (Supabase Auth)
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                      Nombre Admin
                    </label>
                    <input
                      type="text"
                      value={form.admin_full_name}
                      onChange={(e) =>
                        setForm({ ...form, admin_full_name: e.target.value })
                      }
                      placeholder="Dra. Sofía Rojas"
                      className="w-full px-3 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                    />
                  </div>
                  <div>
                    <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                      Email Admin *
                    </label>
                    <input
                      type="email"
                      required
                      value={form.admin_email}
                      onChange={(e) =>
                        setForm({ ...form, admin_email: e.target.value })
                      }
                      placeholder="admin@clinica.com"
                      className="w-full px-3 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                    />
                  </div>
                  <div>
                    <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                      Contraseña Temporal *
                    </label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={form.admin_password}
                      onChange={(e) =>
                        setForm({ ...form, admin_password: e.target.value })
                      }
                      placeholder="Mínimo 8 caracteres"
                      className="w-full px-3 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 font-bold text-slate-600 hover:bg-slate-100"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="px-5 py-2 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white font-bold uppercase tracking-wider flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Check className="w-4 h-4 text-[#10B981]" />
                  {isCreating ? 'Creando Clínica...' : 'Crear Clínica y Usuario'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabla de Clínicas */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#0F172A] text-white text-[11px] font-bold uppercase tracking-wider">
                <th className="py-3.5 px-4">Clínica</th>
                <th className="py-3.5 px-4">Especialidad</th>
                <th className="py-3.5 px-4">WhatsApp Phone ID</th>
                <th className="py-3.5 px-4">Citas del Mes</th>
                <th className="py-3.5 px-4">Conversaciones</th>
                <th className="py-3.5 px-4">Fecha Alta</th>
                <th className="py-3.5 px-4">Estado Suscripción</th>
                <th className="py-3.5 px-4 text-right">Control MRR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-500">
                    Cargando clínicas registradas...
                  </td>
                </tr>
              ) : clinics.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-500">
                    No hay clínicas registradas.
                  </td>
                </tr>
              ) : (
                clinics.map((clinic) => (
                  <tr key={clinic.id} className="hover:bg-slate-50/80">
                    <td className="py-3.5 px-4">
                      <div className="font-bold text-[#0F172A]">
                        {clinic.name}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        slug: {clinic.slug}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 uppercase font-semibold text-slate-700">
                      {clinic.specialty}
                    </td>

                    <td className="py-3.5 px-4 font-mono text-slate-700">
                      {clinic.whatsapp_phone_id}
                    </td>

                    <td className="py-3.5 px-4 font-bold text-[#0F172A]">
                      {clinic.monthly_appointments_count}
                    </td>

                    <td className="py-3.5 px-4 font-bold text-[#0F172A]">
                      {clinic.conversations_count}
                    </td>

                    <td className="py-3.5 px-4 text-slate-500">
                      {new Date(clinic.created_at).toLocaleDateString('es-VE')}
                    </td>

                    <td className="py-3.5 px-4">
                      <span
                        className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                          clinic.is_active
                            ? 'bg-[#10B981]/15 text-[#10B981]'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {clinic.is_active ? 'Activa' : 'Suspendida'}
                      </span>
                    </td>

                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        disabled={togglingId === clinic.id}
                        onClick={() => void handleToggleClinicStatus(clinic)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 ${
                          clinic.is_active
                            ? 'bg-red-50 hover:bg-red-100 text-red-700 border border-red-200'
                            : 'bg-[#10B981]/15 hover:bg-[#10B981]/25 text-[#0F172A] border border-[#10B981]/30'
                        }`}
                      >
                        {clinic.is_active ? (
                          <>
                            <ToggleRight className="w-4 h-4" />
                            Suspender
                          </>
                        ) : (
                          <>
                            <ToggleLeft className="w-4 h-4" />
                            Activar
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
