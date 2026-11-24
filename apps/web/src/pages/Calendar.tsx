import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  Bot,
  Calendar as CalendarIcon,
  Check,
  Clock,
  Filter,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  UserCheck,
  X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useChatStore } from '../store/useChatStore';
import {
  AppointmentPaymentStatus,
  AppointmentSource,
  AppointmentStatus,
  AppointmentWithRelations,
  Patient,
  ServiceItem,
} from '../types/domain';

function formatCaracasDateTime(isoString: string): {
  dateStr: string;
  timeStr: string;
  ymdCaracas: string;
} {
  const d = new Date(isoString);
  const dateStr = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);

  const timeStr = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d);

  const caracasMs = d.getTime() - 4 * 60 * 60 * 1000;
  const ymdCaracas = new Date(caracasMs).toISOString().slice(0, 10);

  return { dateStr, timeStr, ymdCaracas };
}

function getTodayCaracasYmd(): string {
  const caracasMs = Date.now() - 4 * 60 * 60 * 1000;
  return new Date(caracasMs).toISOString().slice(0, 10);
}

function getStatusBadgeStyle(status: AppointmentStatus): string {
  switch (status) {
    case 'confirmed':
      return 'bg-[#06B6D4]/15 text-[#0F172A] border border-[#06B6D4]/40';
    case 'completed':
      return 'bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/40';
    case 'cancelled':
      return 'bg-red-50 text-red-700 border border-red-200';
    case 'no_show':
      return 'bg-amber-50 text-amber-800 border border-amber-200';
    default:
      return 'bg-slate-100 text-slate-700 border border-slate-200';
  }
}

function getStatusLabel(status: AppointmentStatus): string {
  switch (status) {
    case 'confirmed':
      return 'Confirmada';
    case 'completed':
      return 'Completada';
    case 'cancelled':
      return 'Cancelada';
    case 'no_show':
      return 'No Show';
    default:
      return 'Agendada';
  }
}

function getPaymentSelectStyle(paymentStatus: AppointmentPaymentStatus): string {
  switch (paymentStatus) {
    case 'paid':
      return 'bg-[#10B981]/15 text-[#0F172A] border-[#10B981]/40';
    case 'partial':
      return 'bg-amber-50 text-amber-900 border-amber-300';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-300';
  }
}

export const Calendar: React.FC = () => {
  const navigate = useNavigate();
  const activeClinic = useChatStore((state) => state.activeClinic);
  const bcvRate = useChatStore((state) => state.bcvRate);
  const conversations = useChatStore((state) => state.conversations);
  const selectConversation = useChatStore((state) => state.selectConversation);

  const [appointments, setAppointments] = useState<AppointmentWithRelations[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [filterTab, setFilterTab] = useState<'today' | 'upcoming' | 'all'>('upcoming');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | AppointmentStatus>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updatingPaymentId, setUpdatingPaymentId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Estado del modal "Nueva Cita Manual"
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [selectedPatientId, setSelectedPatientId] = useState<string>('new');
  const [newPatientName, setNewPatientName] = useState('');
  const [newPatientPhone, setNewPatientPhone] = useState('');
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [bookingDate, setBookingDate] = useState(getTodayCaracasYmd());
  const [bookingTime, setBookingTime] = useState('10:00');
  const [bookingPaymentStatus, setBookingPaymentStatus] =
    useState<AppointmentPaymentStatus>('pending');
  const [bookingNotes, setBookingNotes] = useState('');
  const [isCreatingBooking, setIsCreatingBooking] = useState(false);

  const loadCalendarData = useCallback(async () => {
    if (!activeClinic) return;
    setIsLoading(true);
    setErrorMsg(null);

    const [apptsRes, patientsRes, servicesRes] = await Promise.all([
      supabase
        .from('appointments')
        .select(
          `
          *,
          patients ( id, full_name, phone ),
          services ( id, name, duration_minutes, price_usd )
        `
        )
        .eq('clinic_id', activeClinic.id)
        .order('starts_at', { ascending: true })
        .returns<AppointmentWithRelations[]>(),
      supabase
        .from('patients')
        .select('*')
        .eq('clinic_id', activeClinic.id)
        .order('full_name', { ascending: true })
        .returns<Patient[]>(),
      supabase
        .from('services')
        .select('*')
        .eq('clinic_id', activeClinic.id)
        .eq('is_active', true)
        .order('name', { ascending: true })
        .returns<ServiceItem[]>(),
    ]);

    if (apptsRes.error) {
      setErrorMsg(apptsRes.error.message);
      setIsLoading(false);
      return;
    }

    setAppointments(apptsRes.data ?? []);
    setPatients(patientsRes.data ?? []);
    const activeServices = servicesRes.data ?? [];
    setServices(activeServices);
    if (activeServices[0] && !selectedServiceId) {
      setSelectedServiceId(activeServices[0].id);
    }

    setIsLoading(false);
  }, [activeClinic, selectedServiceId]);

  useEffect(() => {
    void loadCalendarData();
  }, [loadCalendarData]);

  const handleStatusChange = async (
    appointmentId: string,
    newStatus: AppointmentStatus
  ) => {
    if (!activeClinic) return;
    setUpdatingId(appointmentId);
    setErrorMsg(null);

    const { error } = await supabase
      .from('appointments')
      .update({ status: newStatus })
      .eq('id', appointmentId)
      .eq('clinic_id', activeClinic.id);

    if (error) {
      setErrorMsg(`No se pudo actualizar la cita: ${error.message}`);
    } else {
      setAppointments((prev) =>
        prev.map((a) => (a.id === appointmentId ? { ...a, status: newStatus } : a))
      );
    }

    setUpdatingId(null);
  };

  const handlePaymentStatusChange = async (
    appointmentId: string,
    newPaymentStatus: AppointmentPaymentStatus
  ) => {
    if (!activeClinic) return;
    setUpdatingPaymentId(appointmentId);
    setErrorMsg(null);

    const { error } = await supabase
      .from('appointments')
      .update({ payment_status: newPaymentStatus })
      .eq('id', appointmentId)
      .eq('clinic_id', activeClinic.id);

    if (error) {
      setErrorMsg(`No se pudo actualizar el estado de pago: ${error.message}`);
    } else {
      setAppointments((prev) =>
        prev.map((a) =>
          a.id === appointmentId ? { ...a, payment_status: newPaymentStatus } : a
        )
      );
    }

    setUpdatingPaymentId(null);
  };

  const handleGoToChat = async (appt: AppointmentWithRelations) => {
    if (!activeClinic) return;

    // 1. Si la cita ya tiene conversation_id o la conversación ya está en memoria del store
    const cachedConv = conversations.find(
      (c) =>
        c.id === appt.conversation_id || c.patient_id === appt.patient_id
    );

    if (cachedConv) {
      await selectConversation(cachedConv.id);
      navigate('/inbox');
      return;
    }

    // 2. Si aún no existe conversación para ese paciente (ej. paciente creado manualmente), hacemos upsert
    const { data: ensuredConv, error } = await supabase
      .from('conversations')
      .upsert(
        {
          clinic_id: activeClinic.id,
          patient_id: appt.patient_id,
        },
        { onConflict: 'clinic_id,patient_id' }
      )
      .select('id')
      .single<{ id: string }>();

    if (error || !ensuredConv) {
      setErrorMsg(
        `No se pudo abrir la conversación del paciente: ${error?.message ?? 'Error'}`
      );
      return;
    }

    await selectConversation(ensuredConv.id);
    navigate('/inbox');
  };

  const handleCreateManualAppointment = async (
    e: React.FormEvent<HTMLFormElement>
  ) => {
    e.preventDefault();
    if (!activeClinic) return;

    setIsCreatingBooking(true);
    setErrorMsg(null);

    try {
      let targetPatientId = selectedPatientId;

      if (selectedPatientId === 'new') {
        const cleanPhone = newPatientPhone.trim();
        const cleanName = newPatientName.trim();

        if (!cleanPhone || !cleanName) {
          throw new Error('Ingresa el nombre y teléfono del paciente.');
        }

        const { data: upsertedPatient, error: patientErr } = await supabase
          .from('patients')
          .upsert(
            {
              clinic_id: activeClinic.id,
              phone: cleanPhone,
              full_name: cleanName,
              status: 'booked',
            },
            { onConflict: 'clinic_id,phone' }
          )
          .select('id')
          .single<{ id: string }>();

        if (patientErr || !upsertedPatient) {
          throw new Error(
            `Error registrando paciente: ${patientErr?.message ?? 'Desconocido'}`
          );
        }

        targetPatientId = upsertedPatient.id;
      } else {
        await supabase
          .from('patients')
          .update({ status: 'booked' })
          .eq('id', targetPatientId)
          .eq('clinic_id', activeClinic.id);
      }

      const chosenService = services.find((s) => s.id === selectedServiceId);
      const durationMin = chosenService?.duration_minutes ?? 30;
      const priceUsd = chosenService ? Number(chosenService.price_usd) : 0;

      const startsAtDate = new Date(`${bookingDate}T${bookingTime}:00-04:00`);
      if (Number.isNaN(startsAtDate.getTime())) {
        throw new Error('Fecha u hora inválida.');
      }

      const endsAtDate = new Date(
        startsAtDate.getTime() + durationMin * 60 * 1000
      );

      // Asegurar conversación vinculada al paciente para navegación fluida al chat
      const { data: convData } = await supabase
        .from('conversations')
        .upsert(
          {
            clinic_id: activeClinic.id,
            patient_id: targetPatientId,
          },
          { onConflict: 'clinic_id,patient_id' }
        )
        .select('id')
        .maybeSingle<{ id: string }>();

      const { error: insertErr } = await supabase.from('appointments').insert({
        clinic_id: activeClinic.id,
        patient_id: targetPatientId,
        service_id: chosenService?.id ?? null,
        conversation_id: convData?.id ?? null,
        starts_at: startsAtDate.toISOString(),
        ends_at: endsAtDate.toISOString(),
        status: 'confirmed',
        source: 'manual',
        payment_status: bookingPaymentStatus,
        price_usd: priceUsd,
        bcv_rate_snapshot: bcvRate?.rate ?? 1,
        google_event_id: null,
        reminder_24h_sent: false,
        reminder_2h_sent: false,
        notes: bookingNotes.trim() || 'Agendada manualmente desde Recepción',
      });

      if (insertErr) {
        throw new Error(`Error creando la cita: ${insertErr.message}`);
      }

      setShowBookingModal(false);
      setNewPatientName('');
      setNewPatientPhone('');
      setBookingPaymentStatus('pending');
      setBookingNotes('');
      await loadCalendarData();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'No se pudo crear la cita manual'
      );
    } finally {
      setIsCreatingBooking(false);
    }
  };

  const clearAllFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setFilterTab('all');
  };

  const nowMs = Date.now();
  const todayCaracas = getTodayCaracasYmd();
  const hasActiveFilters =
    searchQuery.trim() !== '' || statusFilter !== 'all' || filterTab !== 'all';

  const filteredAppointments = appointments.filter((appt) => {
    const startMs = new Date(appt.starts_at).getTime();
    const { ymdCaracas } = formatCaracasDateTime(appt.starts_at);

    if (filterTab === 'today' && ymdCaracas !== todayCaracas) return false;
    if (filterTab === 'upcoming' && startMs < nowMs) return false;

    if (statusFilter !== 'all' && appt.status !== statusFilter) return false;

    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      const patientName = appt.patients?.full_name?.toLowerCase() ?? '';
      const patientPhone = appt.patients?.phone?.toLowerCase() ?? '';
      const serviceName = appt.services?.name?.toLowerCase() ?? '';
      if (
        !patientName.includes(q) &&
        !patientPhone.includes(q) &&
        !serviceName.includes(q)
      ) {
        return false;
      }
    }

    return true;
  });

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[#0F172A] flex items-center gap-2">
            <CalendarIcon className="w-5 h-5 text-[#06B6D4]" />
            Agenda Nativa de Citas (America/Caracas)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Gestión de citas en tiempo real, control de pagos y monitoreo de recordatorios automáticos por WhatsApp (24h y 2h).
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg bg-white border border-slate-200 p-1">
            {(['today', 'upcoming', 'all'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilterTab(tab)}
                className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition-colors ${
                  filterTab === tab
                    ? 'bg-[#0F172A] text-white'
                    : 'text-slate-600 hover:text-[#0F172A]'
                }`}
              >
                {tab === 'today'
                  ? 'Hoy'
                  : tab === 'upcoming'
                    ? 'Próximas'
                    : 'Todas'}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void loadCalendarData()}
            className="p-2 rounded-lg bg-white border border-slate-200 text-slate-600 hover:text-[#0F172A]"
            title="Recargar agenda"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => setShowBookingModal(true)}
            className="px-4 py-2 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors"
          >
            <Plus className="w-4 h-4 text-[#06B6D4]" />
            <span>Nueva Cita Manual</span>
          </button>
        </div>
      </div>

      {/* Barra de Búsqueda por Paciente/Teléfono y Filtro por Estado */}
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por nombre del paciente, teléfono o tratamiento..."
            className="w-full pl-9 pr-3 py-2 text-xs bg-[#F8FAFC] border border-slate-200 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
            <Filter className="w-3.5 h-3.5 text-[#06B6D4]" />
            <span>Estado:</span>
          </div>
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as 'all' | AppointmentStatus)
            }
            className="px-3 py-1.5 text-xs font-bold bg-[#F8FAFC] border border-slate-200 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
          >
            <option value="all">Todos</option>
            <option value="confirmed">Confirmada</option>
            <option value="completed">Completada</option>
            <option value="cancelled">Cancelada</option>
            <option value="no_show">No Show</option>
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="px-2.5 py-1.5 text-xs font-bold text-slate-500 hover:text-[#0F172A] underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
          {errorMsg}
        </div>
      )}

      {/* Modal "Nueva Cita Manual" */}
      {showBookingModal && (
        <div className="fixed inset-0 z-50 bg-[#0F172A]/60 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full shadow-2xl overflow-hidden">
            <div className="bg-[#0F172A] px-6 py-4 flex items-center justify-between text-white">
              <h2 className="text-sm font-bold uppercase tracking-wider">
                Agendar Nueva Cita Manual (Recepción)
              </h2>
              <button
                type="button"
                onClick={() => setShowBookingModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={handleCreateManualAppointment}
              className="p-6 space-y-4 text-xs"
            >
              <div>
                <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                  Seleccionar Paciente *
                </label>
                <select
                  value={selectedPatientId}
                  onChange={(e) => setSelectedPatientId(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
                >
                  <option value="new">+ Registrar nuevo paciente</option>
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name || 'Sin nombre'} ({p.phone})
                    </option>
                  ))}
                </select>
              </div>

              {selectedPatientId === 'new' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <div>
                    <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                      Nombre Completo *
                    </label>
                    <input
                      type="text"
                      required
                      value={newPatientName}
                      onChange={(e) => setNewPatientName(e.target.value)}
                      placeholder="Ej. Ana María Pérez"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-[#0F172A]"
                    />
                  </div>
                  <div>
                    <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                      Teléfono WhatsApp *
                    </label>
                    <input
                      type="text"
                      required
                      value={newPatientPhone}
                      onChange={(e) => setNewPatientPhone(e.target.value)}
                      placeholder="Ej. 584141234567"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-[#0F172A]"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                  Tratamiento / Servicio *
                </label>
                <select
                  required
                  value={selectedServiceId}
                  onChange={(e) => setSelectedServiceId(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
                >
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — ${Number(s.price_usd).toFixed(2)} USD ({s.duration_minutes} min)
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                    Fecha (Caracas) *
                  </label>
                  <input
                    type="date"
                    required
                    value={bookingDate}
                    onChange={(e) => setBookingDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                  />
                </div>
                <div>
                  <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                    Hora (Caracas) *
                  </label>
                  <input
                    type="time"
                    required
                    value={bookingTime}
                    onChange={(e) => setBookingTime(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                  />
                </div>
                <div>
                  <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                    Estado de Pago
                  </label>
                  <select
                    value={bookingPaymentStatus}
                    onChange={(e) =>
                      setBookingPaymentStatus(
                        e.target.value as AppointmentPaymentStatus
                      )
                    }
                    className="w-full px-3 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                  >
                    <option value="pending">Pendiente</option>
                    <option value="partial">Abono</option>
                    <option value="paid">Pagado</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold uppercase tracking-wider text-slate-700 mb-1">
                  Notas de la Cita
                </label>
                <input
                  type="text"
                  value={bookingNotes}
                  onChange={(e) => setBookingNotes(e.target.value)}
                  placeholder="Observaciones opcionales..."
                  className="w-full px-3.5 py-2 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A]"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowBookingModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 font-bold text-slate-600 hover:bg-slate-100"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isCreatingBooking}
                  className="px-5 py-2 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white font-bold uppercase tracking-wider flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Check className="w-4 h-4 text-[#10B981]" />
                  {isCreatingBooking ? 'Agendando...' : 'Confirmar Cita'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabla de Citas */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#0F172A] text-white text-[11px] font-bold uppercase tracking-wider">
                <th className="py-3.5 px-4">Fecha / Hora (Caracas)</th>
                <th className="py-3.5 px-4">Paciente</th>
                <th className="py-3.5 px-4">Tratamiento / Origen</th>
                <th className="py-3.5 px-4">Monto & Pago</th>
                <th className="py-3.5 px-4">Recordatorios</th>
                <th className="py-3.5 px-4">Estado Cita</th>
                <th className="py-3.5 px-4 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    Cargando citas...
                  </td>
                </tr>
              ) : filteredAppointments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 px-4 text-center">
                    <div className="max-w-sm mx-auto space-y-3">
                      <p className="text-sm font-bold text-[#0F172A]">
                        No se encontraron citas en esta vista
                      </p>
                      <p className="text-xs text-slate-500">
                        Puedes agendar una cita manualmente desde recepción o mostrar todas las citas registradas.
                      </p>
                      <div className="flex items-center justify-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => setShowBookingModal(true)}
                          className="px-3.5 py-2 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider inline-flex items-center gap-1.5"
                        >
                          <Plus className="w-3.5 h-3.5 text-[#06B6D4]" />
                          <span>Nueva Cita Manual</span>
                        </button>
                        {hasActiveFilters && (
                          <button
                            type="button"
                            onClick={clearAllFilters}
                            className="px-3.5 py-2 rounded-lg border border-slate-300 hover:bg-slate-100 text-xs font-bold text-slate-700"
                          >
                            Ver Todas / Limpiar Filtros
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredAppointments.map((appt) => {
                  const { dateStr, timeStr } = formatCaracasDateTime(appt.starts_at);
                  const priceUsd =
                    appt.price_usd ?? appt.services?.price_usd ?? 0;
                  const effectiveRate =
                    appt.bcv_rate_snapshot ?? bcvRate?.rate ?? 1;
                  const priceVes = (Number(priceUsd) * Number(effectiveRate)).toFixed(2);
                  const source: AppointmentSource = appt.source ?? 'ai';
                  const paymentStatus: AppointmentPaymentStatus =
                    appt.payment_status ?? 'pending';

                  return (
                    <tr key={appt.id} className="hover:bg-slate-50/80">
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="font-bold text-[#0F172A]">{dateStr}</div>
                        <div className="text-slate-500 flex items-center gap-1 mt-0.5">
                          <Clock className="w-3 h-3 text-[#06B6D4]" />
                          {timeStr}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-bold text-[#0F172A]">
                          {appt.patients?.full_name || 'Paciente sin nombre'}
                        </div>
                        <div className="text-slate-500">
                          {appt.patients?.phone ?? '—'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-[#0F172A]">
                          {appt.services?.name || 'Consulta General'}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                          {source === 'ai' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-[#06B6D4]/15 text-[#0F172A]">
                              <Bot className="w-3 h-3 text-[#06B6D4]" />
                              IA WhatsApp
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700">
                              <UserCheck className="w-3 h-3 text-slate-600" />
                              Manual
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="font-bold text-[#0F172A]">
                          ${Number(priceUsd).toFixed(2)} USD
                        </div>
                        <div className="text-[11px] text-slate-500 mb-1.5">
                          Bs. {priceVes}
                        </div>
                        <select
                          value={paymentStatus}
                          disabled={updatingPaymentId === appt.id}
                          onChange={(e) =>
                            void handlePaymentStatusChange(
                              appt.id,
                              e.target.value as AppointmentPaymentStatus
                            )
                          }
                          className={`px-2 py-1 text-[11px] font-bold border rounded-md focus:outline-none focus:ring-2 focus:ring-[#06B6D4] ${getPaymentSelectStyle(
                            paymentStatus
                          )}`}
                        >
                          <option value="pending">Pendiente</option>
                          <option value="partial">Abono</option>
                          <option value="paid">Pagado</option>
                        </select>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex flex-col gap-1">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase w-fit ${
                              appt.reminder_24h_sent
                                ? 'bg-[#10B981]/15 text-[#10B981]'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            <Bell className="w-3 h-3" />
                            24h: {appt.reminder_24h_sent ? 'Enviado' : 'Pendiente'}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase w-fit ${
                              appt.reminder_2h_sent
                                ? 'bg-[#10B981]/15 text-[#10B981]'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            <Bell className="w-3 h-3" />
                            2h: {appt.reminder_2h_sent ? 'Enviado' : 'Pendiente'}
                          </span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <span
                          className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider inline-block mb-1.5 ${getStatusBadgeStyle(
                            appt.status
                          )}`}
                        >
                          {getStatusLabel(appt.status)}
                        </span>
                        <div>
                          <select
                            value={appt.status}
                            disabled={updatingId === appt.id}
                            onChange={(e) =>
                              void handleStatusChange(
                                appt.id,
                                e.target.value as AppointmentStatus
                              )
                            }
                            className="px-2 py-1 text-[11px] font-semibold bg-[#F8FAFC] border border-slate-300 rounded-md text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
                          >
                            <option value="confirmed">Confirmada</option>
                            <option value="completed">Completada</option>
                            <option value="cancelled">Cancelada</option>
                            <option value="no_show">No Show</option>
                          </select>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void handleGoToChat(appt)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold transition-colors"
                        >
                          <MessageSquare className="w-3.5 h-3.5 text-[#06B6D4]" />
                          Ir al chat
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
