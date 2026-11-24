export type ClinicSpecialty = 'odontologia' | 'medicina_estetica' | 'ambas';
export type CurrencyMode = 'USD_BCV' | 'USD_ONLY' | 'VES_ONLY';
export type ClinicUserRole = 'admin' | 'receptionist';
export type PatientStatus = 'lead' | 'booked' | 'active' | 'inactive';
export type ConversationStatus = 'open' | 'human_handoff' | 'resolved' | 'archived';
export type MessageSenderType = 'patient' | 'ai' | 'human' | 'staff' | 'system';
export type MessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'document'
  | 'interactive'
  | 'template'
  | 'unknown';
export type MessageMediaType = 'text' | 'audio' | 'image';
export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'no_show';
export type AppointmentSource = 'ai' | 'manual';
export type AppointmentPaymentStatus = 'pending' | 'partial' | 'paid';

export interface DayBusinessHours {
  enabled: boolean;
  start: string; // Formato "HH:mm", ej. "08:00"
  end: string;   // Formato "HH:mm", ej. "17:00"
}

export interface WeeklyBusinessHours {
  monday?: DayBusinessHours;
  tuesday?: DayBusinessHours;
  wednesday?: DayBusinessHours;
  thursday?: DayBusinessHours;
  friday?: DayBusinessHours;
  saturday?: DayBusinessHours;
  sunday?: DayBusinessHours;
}

export interface ClinicRow {
  id: string;
  name: string;
  slug: string;
  specialty: ClinicSpecialty;
  whatsapp_phone_id: string;
  whatsapp_waba_id: string | null;
  whatsapp_display_phone: string | null;
  whatsapp_access_token: string | null;
  ai_system_prompt: string | null;
  system_prompt_extra: string | null;
  timezone: string;
  currency_mode: CurrencyMode;
  google_calendar_id: string | null;
  google_refresh_token: string | null;
  business_hours: WeeklyBusinessHours | null;
  payment_methods: string[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClinicUserRow {
  id: string;
  clinic_id: string;
  user_id: string;
  role: ClinicUserRole;
  full_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ServiceRow {
  id: string;
  clinic_id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_usd: number;
  duration_minutes: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PatientRow {
  id: string;
  clinic_id: string;
  phone: string;
  full_name: string | null;
  cedula: string | null;
  email: string | null;
  notes: string | null;
  tags: string[];
  status: PatientStatus;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  clinic_id: string;
  patient_id: string;
  status: ConversationStatus;
  ai_enabled: boolean;
  escalation_reason: string | null;
  followup_24h_sent: boolean;
  payment_pending_verification: boolean;
  unread_count: number;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  clinic_id: string;
  conversation_id: string;
  wa_message_id: string | null;
  sender_type: MessageSenderType;
  message_type: MessageType;
  media_type: MessageMediaType;
  media_id: string | null;
  media_transcript: string | null;
  content: string;
  media_url: string | null;
  metadata: Record<string, unknown>;
  processed_by_ai: boolean;
  created_at: string;
}

export interface AppointmentRow {
  id: string;
  clinic_id: string;
  patient_id: string;
  service_id: string | null;
  conversation_id: string | null;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  source?: AppointmentSource;
  payment_status?: AppointmentPaymentStatus;
  price_usd: number | null;
  bcv_rate_snapshot: number | null;
  google_calendar_event_id: string | null;
  google_event_id: string | null;
  reminder_24h_sent: boolean;
  reminder_2h_sent: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
