import { google } from 'googleapis';
import { env, isGoogleCalendarConfigured } from '../config/env';
import { supabaseAdmin } from '../config/supabase';
import {
  AppointmentRow,
  ClinicRow,
  DayBusinessHours,
  PatientRow,
  ServiceRow,
  WeeklyBusinessHours,
} from '../types/database';
import { decryptNullableToken, encrypt } from '../utils/crypto';
import { getBcvRate } from './bcv';

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const DEFAULT_WEEKLY_HOURS: Required<WeeklyBusinessHours> = {
  monday: { enabled: true, start: '08:00', end: '17:00' },
  tuesday: { enabled: true, start: '08:00', end: '17:00' },
  wednesday: { enabled: true, start: '08:00', end: '17:00' },
  thursday: { enabled: true, start: '08:00', end: '17:00' },
  friday: { enabled: true, start: '08:00', end: '17:00' },
  saturday: { enabled: true, start: '09:00', end: '13:00' },
  sunday: { enabled: false, start: '09:00', end: '13:00' },
};

/**
 * Crea un cliente OAuth2 configurado con las credenciales de entorno de Google.
 * Solo debe invocarse cuando isGoogleCalendarConfigured() === true.
 */
export function createGoogleOAuth2Client() {
  if (!isGoogleCalendarConfigured()) {
    throw new Error(
      'La integración con Google Calendar no está configurada en las variables de entorno.'
    );
  }

  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Genera la URL de autorización OAuth2 de Google Calendar para una clínica específica.
 * Solicita access_type: 'offline' y prompt: 'consent' para garantizar la entrega del refresh_token.
 */
export function generateGoogleAuthUrl(clinicId: string): string {
  const oauth2Client = createGoogleOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_CALENDAR_SCOPES,
    state: clinicId,
  });
}

/**
 * Intercambia el código de autorización por tokens y guarda el google_refresh_token
 * cifrado en reposo con AES-256-GCM en la tabla `clinics`.
 */
export async function handleGoogleOAuthCallback(
  code: string,
  clinicId: string
): Promise<{ clinicId: string; hasRefreshToken: boolean }> {
  const oauth2Client = createGoogleOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'Google OAuth no devolvió un refresh_token. Asegúrate de revocar permisos previos o usar prompt=consent.'
    );
  }

  const encryptedRefreshToken = encrypt(tokens.refresh_token);

  const { error } = await supabaseAdmin
    .from('clinics')
    .update({
      google_refresh_token: encryptedRefreshToken,
    })
    .eq('id', clinicId);

  if (error) {
    throw new Error(`Error guardando google_refresh_token en Supabase: ${error.message}`);
  }

  return {
    clinicId,
    hasRefreshToken: true,
  };
}

function parseTimeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  const hours = Number(parts[0] ?? 0);
  const minutes = Number(parts[1] ?? 0);
  return hours * 60 + minutes;
}

function formatMinutesToTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function getDayBusinessHours(
  dateYmd: string,
  businessHours: WeeklyBusinessHours | null
): DayBusinessHours {
  const middayCaracas = new Date(`${dateYmd}T12:00:00-04:00`);
  const dayIndex = middayCaracas.getUTCDay();

  const merged: Required<WeeklyBusinessHours> = {
    ...DEFAULT_WEEKLY_HOURS,
    ...(businessHours ?? {}),
  };

  switch (dayIndex) {
    case 0:
      return merged.sunday;
    case 1:
      return merged.monday;
    case 2:
      return merged.tuesday;
    case 3:
      return merged.wednesday;
    case 4:
      return merged.thursday;
    case 5:
      return merged.friday;
    case 6:
      return merged.saturday;
    default:
      return merged.monday;
  }
}

interface BusyInterval {
  startMs: number;
  endMs: number;
}

/**
 * Consulta la disponibilidad de una clínica para una fecha ("YYYY-MM-DD") y duración en minutos:
 * 1. Calcula los bloques disponibles usando `clinics.business_hours` (en `America/Caracas`).
 * 2. Resta las citas existentes en la tabla `appointments` de Supabase con `status = 'confirmed'`.
 *    (Permite excluir un `excludeAppointmentId` cuando se está reprogramando una cita existente).
 * 3. Solo consulta Google Calendar si la clínica tiene `google_refresh_token` Y las variables de Google están configuradas.
 */
export async function checkAvailability(
  clinicId: string,
  date: string,
  durationMinutes: number,
  excludeAppointmentId?: string
): Promise<string[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('El parámetro date debe tener el formato YYYY-MM-DD');
  }

  const safeDuration = durationMinutes > 0 ? durationMinutes : 30;

  const { data: clinic, error: clinicErr } = await supabaseAdmin
    .from('clinics')
    .select(
      'id, name, timezone, business_hours, google_calendar_id, google_refresh_token'
    )
    .eq('id', clinicId)
    .single<
      Pick<
        ClinicRow,
        | 'id'
        | 'name'
        | 'timezone'
        | 'business_hours'
        | 'google_calendar_id'
        | 'google_refresh_token'
      >
    >();

  if (clinicErr || !clinic) {
    throw new Error(`No se encontró la clínica ${clinicId}: ${clinicErr?.message ?? 'Null'}`);
  }

  const dayConfig = getDayBusinessHours(date, clinic.business_hours);
  if (!dayConfig.enabled) {
    return [];
  }

  const dayStartIso = `${date}T00:00:00-04:00`;
  const dayEndIso = `${date}T23:59:59-04:00`;

  const busyIntervals: BusyInterval[] = [];

  // 1. Fuente primaria nativa: citas con status = 'confirmed' en la tabla appointments de Supabase
  let apptQuery = supabaseAdmin
    .from('appointments')
    .select('id, starts_at, ends_at, status')
    .eq('clinic_id', clinicId)
    .eq('status', 'confirmed')
    .gte('starts_at', dayStartIso)
    .lte('starts_at', dayEndIso);

  if (excludeAppointmentId) {
    apptQuery = apptQuery.neq('id', excludeAppointmentId);
  }

  const { data: confirmedAppointments, error: apptErr } = await apptQuery.returns<
    Array<Pick<AppointmentRow, 'id' | 'starts_at' | 'ends_at' | 'status'>>
  >();

  if (apptErr) {
    throw new Error(`Error consultando citas confirmadas en Supabase: ${apptErr.message}`);
  }

  if (confirmedAppointments) {
    for (const appt of confirmedAppointments) {
      busyIntervals.push({
        startMs: new Date(appt.starts_at).getTime(),
        endMs: new Date(appt.ends_at).getTime(),
      });
    }
  }

  // 2. Opcional: Solo consultar Google Calendar si la clínica tiene google_refresh_token Y las variables de Google existen
  const decryptedRefreshToken = decryptNullableToken(clinic.google_refresh_token);

  if (decryptedRefreshToken && isGoogleCalendarConfigured()) {
    try {
      const oauth2Client = createGoogleOAuth2Client();
      oauth2Client.setCredentials({
        refresh_token: decryptedRefreshToken,
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const calendarId = clinic.google_calendar_id ?? 'primary';

      const freeBusyResponse = await calendar.freebusy.query({
        requestBody: {
          timeMin: new Date(dayStartIso).toISOString(),
          timeMax: new Date(dayEndIso).toISOString(),
          timeZone: clinic.timezone || 'America/Caracas',
          items: [{ id: calendarId }],
        },
      });

      const calendarBusyList =
        freeBusyResponse.data.calendars?.[calendarId]?.busy ?? [];

      for (const period of calendarBusyList) {
        if (period.start && period.end) {
          busyIntervals.push({
            startMs: new Date(period.start).getTime(),
            endMs: new Date(period.end).getTime(),
          });
        }
      }
    } catch (googleErr) {
      console.warn(
        `[CalendarService] Advertencia consultando Google Calendar freebusy (continuando con agenda nativa de Supabase):`,
        googleErr instanceof Error ? googleErr.message : googleErr
      );
    }
  }

  // 3. Generar bloques candidatos dentro del horario laboral en America/Caracas
  const openMinutes = parseTimeToMinutes(dayConfig.start);
  const closeMinutes = parseTimeToMinutes(dayConfig.end);
  const stepMinutes = 30;
  const nowMs = Date.now();

  const availableSlots: string[] = [];

  for (
    let slotStartMin = openMinutes;
    slotStartMin + safeDuration <= closeMinutes;
    slotStartMin += stepMinutes
  ) {
    const slotTimeStr = formatMinutesToTime(slotStartMin);
    const slotStartMs = new Date(`${date}T${slotTimeStr}:00-04:00`).getTime();
    const slotEndMs = slotStartMs + safeDuration * 60 * 1000;

    if (slotStartMs <= nowMs) {
      continue;
    }

    const hasOverlap = busyIntervals.some(
      (busy) => slotStartMs < busy.endMs && slotEndMs > busy.startMs
    );

    if (!hasOverlap) {
      availableSlots.push(slotTimeStr);
    }
  }

  return availableSlots;
}

export interface MultiDayAvailabilitySlot {
  date: string;
  dayNameEs: string;
  availableSlots: string[];
}

/**
 * Consulta la disponibilidad de los próximos `daysCount` días (ej. próximos 3 días hábiles) en una sola llamada
 * para responder rápido cuando el paciente pregunta "¿qué días u horarios tienen disponibles?".
 */
export async function checkNextDaysAvailability(
  clinicId: string,
  startDateYmd: string,
  durationMinutes: number,
  daysCount = 3
): Promise<MultiDayAvailabilitySlot[]> {
  const results: MultiDayAvailabilitySlot[] = [];
  const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(startDateYmd)
    ? new Date(`${startDateYmd}T12:00:00-04:00`)
    : new Date();

  const dayFormatter = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  });

  for (let offset = 0; offset < 6 && results.length < daysCount; offset++) {
    const targetDate = new Date(baseDate.getTime() + offset * 24 * 60 * 60 * 1000);
    const caracasMs = targetDate.getTime() - 4 * 60 * 60 * 1000;
    const ymd = new Date(caracasMs).toISOString().slice(0, 10);

    const slots = await checkAvailability(clinicId, ymd, durationMinutes);
    if (slots.length > 0) {
      results.push({
        date: ymd,
        dayNameEs: dayFormatter.format(targetDate),
        availableSlots: slots,
      });
    }
  }

  return results;
}

export interface BookAppointmentResult {
  appointmentId: string;
  googleEventId: string | null;
  serviceName: string;
  startsAtIso: string;
  endsAtIso: string;
  priceUsd: number;
  bcvRateSnapshot: number;
}

/**
 * Agenda una cita de forma 100% nativa en Supabase (y sincroniza opcionalmente con Google Calendar)
 */
export async function bookAppointment(
  clinicId: string,
  patientId: string,
  patientName: string,
  serviceId: string,
  startTimeIso: string
): Promise<BookAppointmentResult> {
  const [clinicRes, serviceRes, patientRes] = await Promise.all([
    supabaseAdmin
      .from('clinics')
      .select(
        'id, name, timezone, business_hours, google_calendar_id, google_refresh_token'
      )
      .eq('id', clinicId)
      .single<
        Pick<
          ClinicRow,
          | 'id'
          | 'name'
          | 'timezone'
          | 'business_hours'
          | 'google_calendar_id'
          | 'google_refresh_token'
        >
      >(),
    supabaseAdmin
      .from('services')
      .select('id, clinic_id, name, price_usd, duration_minutes, is_active')
      .eq('id', serviceId)
      .eq('clinic_id', clinicId)
      .single<
        Pick<
          ServiceRow,
          'id' | 'clinic_id' | 'name' | 'price_usd' | 'duration_minutes' | 'is_active'
        >
      >(),
    supabaseAdmin
      .from('patients')
      .select('id, clinic_id, phone, full_name, status')
      .eq('id', patientId)
      .eq('clinic_id', clinicId)
      .single<
        Pick<PatientRow, 'id' | 'clinic_id' | 'phone' | 'full_name' | 'status'>
      >(),
  ]);

  if (clinicRes.error || !clinicRes.data) {
    throw new Error(`Clínica no encontrada (${clinicId}): ${clinicRes.error?.message ?? ''}`);
  }
  if (serviceRes.error || !serviceRes.data || !serviceRes.data.is_active) {
    throw new Error(`Servicio inválido o inactivo (${serviceId})`);
  }
  if (patientRes.error || !patientRes.data) {
    throw new Error(`Paciente no encontrado (${patientId})`);
  }

  const clinic = clinicRes.data;
  const service = serviceRes.data;
  const patient = patientRes.data;

  const hasTimezoneOffset = /([+-]\d{2}:\d{2}|Z)$/i.test(startTimeIso.trim());
  const normalizedStartIso = hasTimezoneOffset
    ? startTimeIso.trim()
    : `${startTimeIso.trim()}-04:00`;

  const startDateObj = new Date(normalizedStartIso);
  if (Number.isNaN(startDateObj.getTime())) {
    throw new Error(`Fecha/hora de inicio inválida: ${startTimeIso}`);
  }

  const durationMinutes = service.duration_minutes > 0 ? service.duration_minutes : 30;
  const endDateObj = new Date(startDateObj.getTime() + durationMinutes * 60 * 1000);

  const caracasTimeMs = startDateObj.getTime() - 4 * 60 * 60 * 1000;
  const caracasDate = new Date(caracasTimeMs);
  const dateYmd = caracasDate.toISOString().slice(0, 10);
  const timeHm = caracasDate.toISOString().slice(11, 16);

  // Validación anti-colisión directa contra la tabla `appointments` de Supabase (`status = 'confirmed'`)
  const { data: collidingAppointments, error: collisionErr } = await supabaseAdmin
    .from('appointments')
    .select('id, starts_at, ends_at')
    .eq('clinic_id', clinicId)
    .eq('status', 'confirmed')
    .lt('starts_at', endDateObj.toISOString())
    .gt('ends_at', startDateObj.toISOString())
    .returns<Array<Pick<AppointmentRow, 'id' | 'starts_at' | 'ends_at'>>>();

  if (collisionErr) {
    throw new Error(`Error verificando disponibilidad en Supabase: ${collisionErr.message}`);
  }

  if (collidingAppointments && collidingAppointments.length > 0) {
    const availableSlots = await checkAvailability(clinicId, dateYmd, durationMinutes);
    throw new Error(
      `El horario ${timeHm} del ${dateYmd} ya está ocupado por otra cita confirmada. Horarios disponibles: ${
        availableSlots.length > 0 ? availableSlots.join(', ') : 'ninguno'
      }`
    );
  }

  const availableSlots = await checkAvailability(clinicId, dateYmd, durationMinutes);
  if (!availableSlots.includes(timeHm)) {
    throw new Error(
      `El horario ${timeHm} del ${dateYmd} está fuera del horario de atención o no está disponible. Horarios libres actuales: ${
        availableSlots.length > 0 ? availableSlots.join(', ') : 'ninguno'
      }`
    );
  }

  let googleEventId: string | null = null;
  const decryptedRefreshToken = decryptNullableToken(clinic.google_refresh_token);

  if (decryptedRefreshToken && isGoogleCalendarConfigured()) {
    try {
      const oauth2Client = createGoogleOAuth2Client();
      oauth2Client.setCredentials({
        refresh_token: decryptedRefreshToken,
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const calendarId = clinic.google_calendar_id ?? 'primary';

      const effectivePatientName =
        patient.full_name?.trim() || patientName.trim() || `Paciente ${patient.phone}`;

      const eventResponse = await calendar.events.insert({
        calendarId,
        requestBody: {
          summary: `${service.name} - ${effectivePatientName}`,
          description: `Cita agendada por PULSO AI\nClínica: ${clinic.name}\nPaciente: ${effectivePatientName}\nTeléfono WhatsApp: ${patient.phone}\nTratamiento: ${service.name}`,
          start: {
            dateTime: startDateObj.toISOString(),
            timeZone: clinic.timezone || 'America/Caracas',
          },
          end: {
            dateTime: endDateObj.toISOString(),
            timeZone: clinic.timezone || 'America/Caracas',
          },
        },
      });

      googleEventId = eventResponse.data.id ?? null;
    } catch (googleErr) {
      console.warn(
        '[CalendarService] No se pudo sincronizar evento con Google Calendar (guardando cita nativa en Supabase con google_event_id: null):',
        googleErr instanceof Error ? googleErr.message : googleErr
      );
      googleEventId = null;
    }
  }

  let bcvRateSnapshot = 1;
  try {
    const bcv = await getBcvRate();
    bcvRateSnapshot = bcv.rate;
  } catch {
    bcvRateSnapshot = 1;
  }

  const { data: activeConv } = await supabaseAdmin
    .from('conversations')
    .select('id')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .maybeSingle<{ id: string }>();

  const { data: createdAppointment, error: insertApptErr } = await supabaseAdmin
    .from('appointments')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      service_id: service.id,
      conversation_id: activeConv?.id ?? null,
      starts_at: startDateObj.toISOString(),
      ends_at: endDateObj.toISOString(),
      status: 'confirmed',
      price_usd: Number(service.price_usd),
      bcv_rate_snapshot: bcvRateSnapshot,
      google_calendar_event_id: googleEventId,
      google_event_id: googleEventId,
      reminder_24h_sent: false,
      reminder_2h_sent: false,
      notes: `Agendado vía PULSO AI (${service.name})`,
    })
    .select('id')
    .single<{ id: string }>();

  if (insertApptErr || !createdAppointment) {
    throw new Error(
      `Error guardando la cita en Supabase: ${insertApptErr?.message ?? 'Unknown error'}`
    );
  }

  const patientUpdatePayload: { status: 'booked'; full_name?: string } = {
    status: 'booked',
  };

  if ((!patient.full_name || patient.full_name.trim() === '') && patientName.trim() !== '') {
    patientUpdatePayload.full_name = patientName.trim();
  }

  await supabaseAdmin
    .from('patients')
    .update(patientUpdatePayload)
    .eq('id', patientId)
    .eq('clinic_id', clinicId);

  return {
    appointmentId: createdAppointment.id,
    googleEventId,
    serviceName: service.name,
    startsAtIso: startDateObj.toISOString(),
    endsAtIso: endDateObj.toISOString(),
    priceUsd: Number(service.price_usd),
    bcvRateSnapshot,
  };
}

export interface PatientAppointmentSummary {
  appointmentId: string;
  serviceId: string | null;
  serviceName: string;
  durationMinutes: number;
  startsAtIso: string;
  endsAtIso: string;
  status: string;
}

/**
 * Obtiene las citas activas (`confirmed` o `scheduled`) futuras del paciente en la clínica,
 * para que el agente de IA pueda identificar el `appointment_id` antes de reprogramar o cancelar.
 */
export async function getPatientActiveAppointments(
  clinicId: string,
  patientId: string
): Promise<PatientAppointmentSummary[]> {
  interface AppointmentWithServiceRow {
    id: string;
    service_id: string | null;
    starts_at: string;
    ends_at: string;
    status: string;
    services: {
      name: string;
      duration_minutes: number;
    } | null;
  }

  const { data, error } = await supabaseAdmin
    .from('appointments')
    .select(
      `
      id,
      service_id,
      starts_at,
      ends_at,
      status,
      services ( name, duration_minutes )
    `
    )
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .in('status', ['confirmed', 'scheduled'])
    .gte('starts_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order('starts_at', { ascending: true })
    .returns<AppointmentWithServiceRow[]>();

  if (error) {
    throw new Error(`Error consultando citas del paciente: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    appointmentId: row.id,
    serviceId: row.service_id,
    serviceName: row.services?.name ?? 'Consulta',
    durationMinutes: row.services?.duration_minutes ?? 30,
    startsAtIso: row.starts_at,
    endsAtIso: row.ends_at,
    status: row.status,
  }));
}

export interface RescheduleOrCancelResult {
  appointmentId: string;
  action: 'cancel' | 'reschedule';
  status: 'cancelled' | 'confirmed';
  startsAtIso: string;
  endsAtIso: string;
}

/**
 * Cancela o reprograma una cita existente del paciente:
 * - Si `action === 'cancel'`: actualiza `appointments.status = 'cancelled'`.
 * - Si `action === 'reschedule'`: valida disponibilidad anti-colisión en el nuevo horario,
 *   actualiza `starts_at` y `ends_at`, y reinicia `reminder_24h_sent = false` y `reminder_2h_sent = false`.
 */
export async function rescheduleOrCancelAppointment(params: {
  clinicId: string;
  patientId: string;
  appointmentId: string;
  action: 'cancel' | 'reschedule';
  newStartTimeIso?: string;
}): Promise<RescheduleOrCancelResult> {
  const { clinicId, patientId, appointmentId, action, newStartTimeIso } = params;

  interface ExistingApptWithService {
    id: string;
    clinic_id: string;
    patient_id: string;
    service_id: string | null;
    starts_at: string;
    ends_at: string;
    status: string;
    services: {
      name: string;
      duration_minutes: number;
    } | null;
  }

  const { data: existingAppt, error: findErr } = await supabaseAdmin
    .from('appointments')
    .select(
      `
      id,
      clinic_id,
      patient_id,
      service_id,
      starts_at,
      ends_at,
      status,
      services ( name, duration_minutes )
    `
    )
    .eq('id', appointmentId)
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .maybeSingle<ExistingApptWithService>();

  if (findErr || !existingAppt) {
    throw new Error(
      `No se encontró la cita ${appointmentId} perteneciente al paciente actual.`
    );
  }

  if (action === 'cancel') {
    const { error: cancelErr } = await supabaseAdmin
      .from('appointments')
      .update({
        status: 'cancelled',
      })
      .eq('id', appointmentId)
      .eq('clinic_id', clinicId);

    if (cancelErr) {
      throw new Error(`Error cancelando la cita: ${cancelErr.message}`);
    }

    return {
      appointmentId,
      action: 'cancel',
      status: 'cancelled',
      startsAtIso: existingAppt.starts_at,
      endsAtIso: existingAppt.ends_at,
    };
  }

  // Acción: 'reschedule'
  if (!newStartTimeIso || newStartTimeIso.trim() === '') {
    throw new Error(
      'Para reprogramar (action="reschedule") es obligatorio proporcionar new_start_time_iso.'
    );
  }

  const hasTimezoneOffset = /([+-]\d{2}:\d{2}|Z)$/i.test(newStartTimeIso.trim());
  const normalizedStartIso = hasTimezoneOffset
    ? newStartTimeIso.trim()
    : `${newStartTimeIso.trim()}-04:00`;

  const newStartDate = new Date(normalizedStartIso);
  if (Number.isNaN(newStartDate.getTime())) {
    throw new Error(`Nueva fecha/hora inválida: ${newStartTimeIso}`);
  }

  const currentDurationMs =
    new Date(existingAppt.ends_at).getTime() -
    new Date(existingAppt.starts_at).getTime();
  const fallbackDurationMin =
    currentDurationMs > 0 ? Math.round(currentDurationMs / 60000) : 30;
  const durationMinutes =
    existingAppt.services?.duration_minutes ?? fallbackDurationMin;

  const newEndDate = new Date(
    newStartDate.getTime() + durationMinutes * 60 * 1000
  );

  const caracasTimeMs = newStartDate.getTime() - 4 * 60 * 60 * 1000;
  const caracasDate = new Date(caracasTimeMs);
  const dateYmd = caracasDate.toISOString().slice(0, 10);
  const timeHm = caracasDate.toISOString().slice(11, 16);

  // Validar disponibilidad en el nuevo horario excluyendo la propia cita que se está moviendo
  const availableSlots = await checkAvailability(
    clinicId,
    dateYmd,
    durationMinutes,
    appointmentId
  );

  if (!availableSlots.includes(timeHm)) {
    throw new Error(
      `El nuevo horario ${timeHm} del ${dateYmd} no está disponible. Horarios libres para ese día: ${
        availableSlots.length > 0 ? availableSlots.join(', ') : 'ninguno'
      }`
    );
  }

  const { error: updateErr } = await supabaseAdmin
    .from('appointments')
    .update({
      starts_at: newStartDate.toISOString(),
      ends_at: newEndDate.toISOString(),
      status: 'confirmed',
      reminder_24h_sent: false,
      reminder_2h_sent: false,
    })
    .eq('id', appointmentId)
    .eq('clinic_id', clinicId);

  if (updateErr) {
    throw new Error(`Error reprogramando la cita: ${updateErr.message}`);
  }

  return {
    appointmentId,
    action: 'reschedule',
    status: 'confirmed',
    startsAtIso: newStartDate.toISOString(),
    endsAtIso: newEndDate.toISOString(),
  };
}
