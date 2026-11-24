import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Edit3,
  Plus,
  Stethoscope,
  ToggleLeft,
  ToggleRight,
  X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useChatStore } from '../store/useChatStore';
import { ServiceItem } from '../types/domain';

interface ServiceFormState {
  name: string;
  category: string;
  description: string;
  price_usd: string;
  duration_minutes: string;
  is_active: boolean;
}

const initialFormState: ServiceFormState = {
  name: '',
  category: 'Odontología General',
  description: '',
  price_usd: '35.00',
  duration_minutes: '45',
  is_active: true,
};

export const Services: React.FC = () => {
  const activeClinic = useChatStore((state) => state.activeClinic);
  const bcvRate = useChatStore((state) => state.bcvRate);

  const [services, setServices] = useState<ServiceItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ServiceFormState>(initialFormState);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadServices = useCallback(async () => {
    if (!activeClinic) return;
    setIsLoading(true);
    setErrorMsg(null);

    const { data, error } = await supabase
      .from('services')
      .select('*')
      .eq('clinic_id', activeClinic.id)
      .order('name', { ascending: true })
      .returns<ServiceItem[]>();

    if (error) {
      setErrorMsg(error.message);
      setIsLoading(false);
      return;
    }

    setServices(data ?? []);
    setIsLoading(false);
  }, [activeClinic]);

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  const openCreateModal = () => {
    setEditingServiceId(null);
    setForm(initialFormState);
    setShowForm(true);
  };

  const openEditModal = (item: ServiceItem) => {
    setEditingServiceId(item.id);
    setForm({
      name: item.name,
      category: item.category ?? '',
      description: item.description ?? '',
      price_usd: String(item.price_usd),
      duration_minutes: String(item.duration_minutes),
      is_active: item.is_active,
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeClinic) return;

    const priceUsd = Number(form.price_usd);
    const durationMinutes = Number(form.duration_minutes);

    if (Number.isNaN(priceUsd) || priceUsd < 0) {
      setErrorMsg('El precio en USD debe ser un número válido mayor o igual a 0.');
      return;
    }

    if (Number.isNaN(durationMinutes) || durationMinutes <= 0) {
      setErrorMsg('La duración en minutos debe ser mayor a 0.');
      return;
    }

    setIsSaving(true);
    setErrorMsg(null);

    const payload = {
      clinic_id: activeClinic.id,
      name: form.name.trim(),
      category: form.category.trim() || null,
      description: form.description.trim() || null,
      price_usd: priceUsd,
      duration_minutes: durationMinutes,
      is_active: form.is_active,
    };

    if (editingServiceId) {
      const { error } = await supabase
        .from('services')
        .update(payload)
        .eq('id', editingServiceId)
        .eq('clinic_id', activeClinic.id);

      if (error) {
        setErrorMsg(`Error actualizando servicio: ${error.message}`);
        setIsSaving(false);
        return;
      }
    } else {
      const { error } = await supabase.from('services').insert(payload);

      if (error) {
        setErrorMsg(`Error creando servicio: ${error.message}`);
        setIsSaving(false);
        return;
      }
    }

    setIsSaving(false);
    setShowForm(false);
    setEditingServiceId(null);
    await loadServices();
  };

  const handleToggleActive = async (item: ServiceItem) => {
    if (!activeClinic) return;
    const nextState = !item.is_active;

    const { error } = await supabase
      .from('services')
      .update({ is_active: nextState })
      .eq('id', item.id)
      .eq('clinic_id', activeClinic.id);

    if (error) {
      setErrorMsg(`No se pudo cambiar el estado del servicio: ${error.message}`);
      return;
    }

    setServices((prev) =>
      prev.map((s) => (s.id === item.id ? { ...s, is_active: nextState } : s))
    );
  };

  const rate = bcvRate?.rate ?? 1;

  return (
    <div className="p-6 space-y-6">
      {/* Encabezado */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[#0F172A] flex items-center gap-2">
            <Stethoscope className="w-5 h-5 text-[#06B6D4]" />
            Catálogo de Servicios y Precios
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            PULSO AI consulta este catálogo en tiempo real mediante Function Calling y convierte automáticamente a Bs. según la tasa BCV.
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className="px-4 py-2.5 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-colors self-start"
        >
          <Plus className="w-4 h-4 text-[#06B6D4]" />
          Nuevo Servicio
        </button>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
          {errorMsg}
        </div>
      )}

      {/* Formulario Crear / Editar */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-white border-2 border-[#06B6D4] rounded-xl p-6 shadow-md space-y-4"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#0F172A]">
              {editingServiceId ? 'Editar Servicio' : 'Crear Nuevo Servicio'}
            </h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1">
                Nombre del Tratamiento *
              </label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Ej. Limpieza Dental Ultrasónica"
                className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1">
                Precio (USD) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={form.price_usd}
                onChange={(e) => setForm({ ...form, price_usd: e.target.value })}
                className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
              />
              <p className="text-[11px] font-bold text-[#10B981] mt-1">
                ≈ Bs. {((Number(form.price_usd) || 0) * rate).toFixed(2)} (Tasa BCV)
              </p>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1">
                Duración (Minutos) *
              </label>
              <input
                type="number"
                step="5"
                min="10"
                required
                value={form.duration_minutes}
                onChange={(e) =>
                  setForm({ ...form, duration_minutes: e.target.value })
                }
                className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1">
                Categoría
              </label>
              <input
                type="text"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="Ej. Estética Dental / Facial"
                className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1">
                Descripción para la IA
              </label>
              <input
                type="text"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="Detalles que la IA puede explicar al paciente por WhatsApp..."
                className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <label className="inline-flex items-center gap-2 text-xs font-bold text-[#0F172A] cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) =>
                  setForm({ ...form, is_active: e.target.checked })
                }
                className="rounded border-slate-300 text-[#06B6D4] focus:ring-[#06B6D4]"
              />
              Servicio activo y disponible para agendamiento por IA
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 rounded-lg border border-slate-300 text-xs font-bold text-slate-600 hover:bg-slate-100"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-5 py-2 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 disabled:opacity-50"
              >
                <Check className="w-4 h-4 text-[#10B981]" />
                {isSaving ? 'Guardando...' : 'Guardar Servicio'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Tabla de Servicios */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#0F172A] text-white text-[11px] font-bold uppercase tracking-wider">
                <th className="py-3.5 px-4">Tratamiento / Servicio</th>
                <th className="py-3.5 px-4">Categoría</th>
                <th className="py-3.5 px-4">Duración</th>
                <th className="py-3.5 px-4">Precio USD</th>
                <th className="py-3.5 px-4">Equivalente Bs. (BCV)</th>
                <th className="py-3.5 px-4">Estado</th>
                <th className="py-3.5 px-4 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    Cargando catálogo de servicios...
                  </td>
                </tr>
              ) : services.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    No hay servicios creados todavía. Haz clic en "Nuevo Servicio".
                  </td>
                </tr>
              ) : (
                services.map((item) => {
                  const vesAmount = (Number(item.price_usd) * rate).toFixed(2);
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/80">
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-[#0F172A]">{item.name}</div>
                        {item.description && (
                          <div className="text-slate-500 mt-0.5 max-w-md truncate">
                            {item.description}
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-slate-600 font-medium">
                        {item.category || 'General'}
                      </td>

                      <td className="py-3.5 px-4 font-semibold text-[#0F172A]">
                        {item.duration_minutes} min
                      </td>

                      <td className="py-3.5 px-4 font-bold text-[#0F172A]">
                        ${Number(item.price_usd).toFixed(2)}
                      </td>

                      <td className="py-3.5 px-4 font-bold text-[#10B981]">
                        Bs. {vesAmount}
                      </td>

                      <td className="py-3.5 px-4">
                        <button
                          type="button"
                          onClick={() => void handleToggleActive(item)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                            item.is_active
                              ? 'bg-[#10B981]/15 text-[#10B981]'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {item.is_active ? (
                            <>
                              <ToggleRight className="w-4 h-4" />
                              Activo
                            </>
                          ) : (
                            <>
                              <ToggleLeft className="w-4 h-4" />
                              Inactivo
                            </>
                          )}
                        </button>
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => openEditModal(item)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-[#0F172A] font-semibold"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-[#06B6D4]" />
                          Editar
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
