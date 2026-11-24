import { RealtimeChannel } from '@supabase/supabase-js';
import { create } from 'zustand';
import { apiFetch } from '../lib/api';
import { supabase } from '../lib/supabase';
import {
  BcvRateInfo,
  ChatMessage,
  Clinic,
  ClinicUser,
  ConversationStatus,
  ConversationWithPatient,
  Patient,
} from '../types/domain';

interface RealtimeMessagePayload {
  id: string;
  clinic_id: string;
  conversation_id: string;
  wa_message_id: string | null;
  sender_type: ChatMessage['sender_type'];
  message_type: ChatMessage['message_type'];
  media_type?: ChatMessage['media_type'];
  media_id?: string | null;
  media_transcript?: string | null;
  content: string;
  media_url: string | null;
  metadata: Record<string, unknown>;
  processed_by_ai: boolean;
  created_at: string;
}

interface RealtimeConversationPayload {
  id: string;
  clinic_id: string;
  patient_id: string;
  status: ConversationStatus;
  ai_enabled: boolean;
  escalation_reason: string | null;
  followup_24h_sent?: boolean;
  payment_pending_verification?: boolean;
  unread_count: number;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatStoreState {
  activeClinic: Clinic | null;
  clinicMembership: ClinicUser | null;
  isPlatformAdmin: boolean;
  bcvRate: BcvRateInfo | null;

  conversations: ConversationWithPatient[];
  selectedConversationId: string | null;
  messagesByConversation: Record<string, ChatMessage[]>;
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  isSendingMessage: boolean;
  isTogglingAi: boolean;
  error: string | null;

  realtimeChannel: RealtimeChannel | null;

  setClinicContext: (
    clinic: Clinic | null,
    membership: ClinicUser | null,
    isPlatformAdmin?: boolean
  ) => void;
  fetchBcvRate: () => Promise<void>;
  fetchConversations: (clinicId: string) => Promise<void>;
  selectConversation: (conversationId: string | null) => Promise<void>;
  fetchMessages: (conversationId: string) => Promise<void>;
  sendManualMessage: (conversationId: string, text: string) => Promise<void>;
  toggleConversationAi: (conversationId: string, aiEnabled: boolean) => Promise<void>;
  verifyConversationPayment: (conversationId: string) => Promise<void>;
  subscribeToRealtime: (clinicId: string) => void;
  unsubscribeFromRealtime: () => void;
  refreshActiveClinic: () => Promise<void>;
}

function sortConversationsByLastMessage(
  list: ConversationWithPatient[]
): ConversationWithPatient[] {
  return [...list].sort(
    (a, b) =>
      new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
  );
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  activeClinic: null,
  clinicMembership: null,
  isPlatformAdmin: false,
  bcvRate: null,

  conversations: [],
  selectedConversationId: null,
  messagesByConversation: {},
  isLoadingConversations: false,
  isLoadingMessages: false,
  isSendingMessage: false,
  isTogglingAi: false,
  error: null,
  realtimeChannel: null,

  setClinicContext: (clinic, membership, isPlatformAdmin = false) => {
    set({
      activeClinic: clinic,
      clinicMembership: membership,
      isPlatformAdmin,
    });
  },

  refreshActiveClinic: async () => {
    const current = get().activeClinic;
    if (!current) return;

    const { data, error } = await supabase
      .from('clinics')
      .select('*')
      .eq('id', current.id)
      .single<Clinic>();

    if (!error && data) {
      set({ activeClinic: data });
    }
  },

  fetchBcvRate: async () => {
    try {
      const data = await apiFetch<BcvRateInfo>('/api/bcv', {
        requireAuth: false,
      });
      if (typeof data.rate === 'number') {
        set({ bcvRate: data });
      }
    } catch {
      // Silencioso mientras arranca el API
    }
  },

  fetchConversations: async (clinicId: string) => {
    set({ isLoadingConversations: true, error: null });

    const { data, error } = await supabase
      .from('conversations')
      .select(
        `
        id,
        clinic_id,
        patient_id,
        status,
        ai_enabled,
        escalation_reason,
        followup_24h_sent,
        payment_pending_verification,
        unread_count,
        last_message_at,
        last_message_preview,
        created_at,
        updated_at,
        patients (
          id,
          clinic_id,
          phone,
          full_name,
          cedula,
          email,
          notes,
          tags,
          status
        )
      `
      )
      .eq('clinic_id', clinicId)
      .order('last_message_at', { ascending: false })
      .returns<ConversationWithPatient[]>();

    if (error) {
      set({
        isLoadingConversations: false,
        error: `Error cargando conversaciones: ${error.message}`,
      });
      return;
    }

    const conversations = sortConversationsByLastMessage(data ?? []);
    const currentSelected = get().selectedConversationId;
    const firstConversationId = conversations[0]?.id ?? null;

    set({
      conversations,
      isLoadingConversations: false,
      selectedConversationId: currentSelected ?? firstConversationId,
    });

    const targetConvId = currentSelected ?? firstConversationId;
    if (targetConvId) {
      await get().fetchMessages(targetConvId);
    }
  },

  selectConversation: async (conversationId: string | null) => {
    set({ selectedConversationId: conversationId });
    if (!conversationId) return;

    const target = get().conversations.find((c) => c.id === conversationId);
    if (target && target.unread_count > 0) {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, unread_count: 0 } : c
        ),
      }));
      await supabase
        .from('conversations')
        .update({ unread_count: 0 })
        .eq('id', conversationId);
    }

    await get().fetchMessages(conversationId);
  },

  fetchMessages: async (conversationId: string) => {
    set({ isLoadingMessages: true });

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .returns<ChatMessage[]>();

    if (error) {
      set({
        isLoadingMessages: false,
        error: `Error cargando mensajes: ${error.message}`,
      });
      return;
    }

    set((state) => ({
      isLoadingMessages: false,
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: data ?? [],
      },
    }));
  },

  sendManualMessage: async (conversationId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    set({ isSendingMessage: true, error: null });

    try {
      const activeClinicId = get().activeClinic?.id;

      const payload = await apiFetch<{
        message?: ChatMessage;
        conversation?: RealtimeConversationPayload;
      }>(`/api/conversations/${encodeURIComponent(conversationId)}/send`, {
        method: 'POST',
        body: { text: trimmed },
        clinicId: activeClinicId,
      });

      const savedMessage = payload.message;
      if (savedMessage) {
        set((state) => {
          const existing = state.messagesByConversation[conversationId] ?? [];
          const alreadyExists = existing.some((m) => m.id === savedMessage.id);
          const nextMessages = alreadyExists ? existing : [...existing, savedMessage];

          const nextConversations = sortConversationsByLastMessage(
            state.conversations.map((conv) =>
              conv.id === conversationId
                ? {
                    ...conv,
                    ai_enabled: false,
                    status: 'human_handoff',
                    last_message_at: savedMessage.created_at,
                    last_message_preview: savedMessage.content.slice(0, 160),
                    unread_count: 0,
                  }
                : conv
            )
          );

          return {
            messagesByConversation: {
              ...state.messagesByConversation,
              [conversationId]: nextMessages,
            },
            conversations: nextConversations,
          };
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'No se pudo enviar el mensaje manual';
      set({ error: message });
      throw err;
    } finally {
      set({ isSendingMessage: false });
    }
  },

  toggleConversationAi: async (conversationId: string, aiEnabled: boolean) => {
    set({ isTogglingAi: true, error: null });

    try {
      const activeClinicId = get().activeClinic?.id;

      await apiFetch<{
        conversation?: RealtimeConversationPayload;
      }>(`/api/conversations/${encodeURIComponent(conversationId)}/ai-toggle`, {
        method: 'PATCH',
        body: { ai_enabled: aiEnabled },
        clinicId: activeClinicId,
      });

      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId
            ? {
                ...conv,
                ai_enabled: aiEnabled,
                status: aiEnabled ? 'open' : 'human_handoff',
                escalation_reason: aiEnabled ? null : conv.escalation_reason,
              }
            : conv
        ),
      }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error cambiando estado de la IA';
      set({ error: message });
    } finally {
      set({ isTogglingAi: false });
    }
  },

  verifyConversationPayment: async (conversationId: string) => {
    try {
      const activeClinicId = get().activeClinic?.id;

      await apiFetch<{
        conversation?: RealtimeConversationPayload;
      }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/verify-payment`,
        {
          method: 'PATCH',
          clinicId: activeClinicId,
        }
      );

      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id === conversationId
            ? {
                ...conv,
                payment_pending_verification: false,
              }
            : conv
        ),
      }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error verificando pago';
      set({ error: message });
    }
  },

  subscribeToRealtime: (clinicId: string) => {
    const existingChannel = get().realtimeChannel;
    if (existingChannel) {
      void supabase.removeChannel(existingChannel);
    }

    const channel = supabase
      .channel(`pulso-clinic-realtime-${clinicId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `clinic_id=eq.${clinicId}`,
        },
        (payload) => {
          const newMsg = payload.new as RealtimeMessagePayload;
          if (!newMsg || !newMsg.conversation_id) return;

          set((state) => {
            const convId = newMsg.conversation_id;
            const currentList = state.messagesByConversation[convId] ?? [];
            const alreadyInList = currentList.some((m) => m.id === newMsg.id);

            const updatedMessages = alreadyInList
              ? currentList
              : [...currentList, newMsg];

            const updatedConversations = sortConversationsByLastMessage(
              state.conversations.map((c) =>
                c.id === convId
                  ? {
                      ...c,
                      last_message_at: newMsg.created_at,
                      last_message_preview: newMsg.content.slice(0, 160),
                    }
                  : c
              )
            );

            return {
              messagesByConversation: {
                ...state.messagesByConversation,
                [convId]: updatedMessages,
              },
              conversations: updatedConversations,
            };
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'conversations',
          filter: `clinic_id=eq.${clinicId}`,
        },
        async (payload) => {
          const updatedConv = payload.new as RealtimeConversationPayload;
          if (!updatedConv || !updatedConv.id) return;

          const exists = get().conversations.some((c) => c.id === updatedConv.id);

          if (exists) {
            set((state) => ({
              conversations: sortConversationsByLastMessage(
                state.conversations.map((c) =>
                  c.id === updatedConv.id
                    ? {
                        ...c,
                        status: updatedConv.status,
                        ai_enabled: updatedConv.ai_enabled,
                        escalation_reason: updatedConv.escalation_reason,
                        followup_24h_sent: updatedConv.followup_24h_sent,
                        payment_pending_verification:
                          updatedConv.payment_pending_verification,
                        unread_count:
                          state.selectedConversationId === updatedConv.id
                            ? 0
                            : updatedConv.unread_count,
                        last_message_at: updatedConv.last_message_at,
                        last_message_preview: updatedConv.last_message_preview,
                        updated_at: updatedConv.updated_at,
                      }
                    : c
                )
              ),
            }));
          } else {
            const { data: patientData } = await supabase
              .from('patients')
              .select('*')
              .eq('id', updatedConv.patient_id)
              .maybeSingle<Patient>();

            const hydratedConv: ConversationWithPatient = {
              ...updatedConv,
              patients: patientData ?? null,
            };

            set((state) => ({
              conversations: sortConversationsByLastMessage([
                hydratedConv,
                ...state.conversations,
              ]),
            }));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'conversations',
          filter: `clinic_id=eq.${clinicId}`,
        },
        async (payload) => {
          const insertedConv = payload.new as RealtimeConversationPayload;
          if (!insertedConv || !insertedConv.id) return;

          const { data: patientData } = await supabase
            .from('patients')
            .select('*')
            .eq('id', insertedConv.patient_id)
            .maybeSingle<Patient>();

          const hydratedConv: ConversationWithPatient = {
            ...insertedConv,
            patients: patientData ?? null,
          };

          set((state) => {
            const exists = state.conversations.some((c) => c.id === insertedConv.id);
            if (exists) return state;
            return {
              conversations: sortConversationsByLastMessage([
                hydratedConv,
                ...state.conversations,
              ]),
            };
          });
        }
      )
      .subscribe();

    set({ realtimeChannel: channel });
  },

  unsubscribeFromRealtime: () => {
    const channel = get().realtimeChannel;
    if (channel) {
      void supabase.removeChannel(channel);
      set({ realtimeChannel: null });
    }
  },
}));
