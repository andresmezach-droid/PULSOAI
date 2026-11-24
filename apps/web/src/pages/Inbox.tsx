import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CreditCard,
  Image as ImageIcon,
  Mic,
  PauseCircle,
  Phone,
  PlayCircle,
  Search,
  Send,
  User,
  UserCheck,
} from 'lucide-react';
import { useChatStore } from '../store/useChatStore';
import { ChatMessage, ConversationWithPatient } from '../types/domain';

function formatCaracasTime(isoString: string): string {
  try {
    return new Intl.DateTimeFormat('es-VE', {
      timeZone: 'America/Caracas',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(isoString));
  } catch {
    return '';
  }
}

function isVoiceMessage(msg: ChatMessage): boolean {
  return (
    msg.media_type === 'audio' ||
    msg.message_type === 'audio' ||
    msg.content.startsWith('[Nota de voz')
  );
}

function isImageOrReceiptMessage(msg: ChatMessage): boolean {
  return (
    msg.media_type === 'image' ||
    msg.message_type === 'image' ||
    msg.content.startsWith('[Imagen') ||
    msg.content.startsWith('[Comprobante')
  );
}

export const Inbox: React.FC = () => {
  const conversations = useChatStore((state) => state.conversations);
  const selectedConversationId = useChatStore((state) => state.selectedConversationId);
  const messagesByConversation = useChatStore((state) => state.messagesByConversation);
  const isLoadingConversations = useChatStore((state) => state.isLoadingConversations);
  const isLoadingMessages = useChatStore((state) => state.isLoadingMessages);
  const isSendingMessage = useChatStore((state) => state.isSendingMessage);
  const isTogglingAi = useChatStore((state) => state.isTogglingAi);
  const error = useChatStore((state) => state.error);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const sendManualMessage = useChatStore((state) => state.sendManualMessage);
  const toggleConversationAi = useChatStore((state) => state.toggleConversationAi);
  const verifyConversationPayment = useChatStore(
    (state) => state.verifyConversationPayment
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [draftText, setDraftText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const selectedConversation: ConversationWithPatient | undefined = conversations.find(
    (c) => c.id === selectedConversationId
  );

  const activeMessages: ChatMessage[] = selectedConversationId
    ? messagesByConversation[selectedConversationId] ?? []
    : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMessages.length, selectedConversationId]);

  const filteredConversations = conversations.filter((conv) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const name = conv.patients?.full_name?.toLowerCase() ?? '';
    const phone = conv.patients?.phone?.toLowerCase() ?? '';
    const preview = conv.last_message_preview?.toLowerCase() ?? '';
    return name.includes(q) || phone.includes(q) || preview.includes(q);
  });

  const handleSendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedConversationId || !draftText.trim() || isSendingMessage) return;

    const textToSend = draftText;
    setDraftText('');
    try {
      await sendManualMessage(selectedConversationId, textToSend);
    } catch {
      setDraftText(textToSend);
    }
  };

  const handleToggleAi = async () => {
    if (!selectedConversation || isTogglingAi) return;
    await toggleConversationAi(
      selectedConversation.id,
      !selectedConversation.ai_enabled
    );
  };

  const handleVerifyPayment = async () => {
    if (!selectedConversation) return;
    await verifyConversationPayment(selectedConversation.id);
  };

  return (
    <div className="flex-1 flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Columna Izquierda: Lista de conversaciones */}
      <div className="w-96 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-base font-bold text-[#0F172A]">
              Inbox en Vivo (WhatsApp)
            </h1>
            <span className="text-xs font-bold px-2 py-0.5 rounded bg-slate-100 text-[#0F172A]">
              {conversations.length}
            </span>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar paciente o teléfono..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-[#F8FAFC] border border-slate-200 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {isLoadingConversations && conversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              Cargando conversaciones en vivo...
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No hay conversaciones registradas para esta búsqueda.
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isSelected = conv.id === selectedConversationId;
              const patientName =
                conv.patients?.full_name || conv.patients?.phone || 'Paciente WhatsApp';
              const patientPhone = conv.patients?.phone ?? '';
              const patientStatus = conv.patients?.status ?? 'lead';

              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => void selectConversation(conv.id)}
                  className={`w-full text-left p-4 transition-colors block ${
                    isSelected
                      ? 'bg-[#06B6D4]/10 border-l-4 border-l-[#06B6D4]'
                      : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-[#0F172A] truncate">
                        {patientName}
                      </p>
                      <p className="text-[11px] font-medium text-slate-500 flex items-center gap-1 mt-0.5">
                        <Phone className="w-3 h-3 text-slate-400" />
                        {patientPhone}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-[11px] text-slate-400 font-medium block">
                        {formatCaracasTime(conv.last_message_at)}
                      </span>
                      {conv.unread_count > 0 && (
                        <span className="inline-block mt-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-[#06B6D4] text-[#0F172A]">
                          {conv.unread_count}
                        </span>
                      )}
                    </div>
                  </div>

                  <p className="text-xs text-slate-600 truncate mt-2">
                    {conv.last_message_preview || 'Sin mensajes recientes'}
                  </p>

                  {/* Badges de Estado Paciente (lead | booked) + IA Activa / Pausada + Pago por verificar */}
                  <div className="mt-2.5 flex items-center flex-wrap gap-1.5">
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                        patientStatus === 'booked'
                          ? 'bg-[#10B981]/15 text-[#10B981]'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {patientStatus === 'booked' ? 'booked' : 'lead'}
                    </span>

                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                        conv.ai_enabled
                          ? 'bg-[#10B981]/15 text-[#10B981]'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      <Bot className="w-3 h-3" />
                      {conv.ai_enabled ? 'IA Activa' : 'IA Pausada'}
                    </span>

                    {conv.payment_pending_verification === true && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-300">
                        <CreditCard className="w-3 h-3" />
                        Pago por verificar
                      </span>
                    )}
                  </div>

                  {/* Alerta roja visible si existe escalation_reason */}
                  {conv.escalation_reason && (
                    <div className="mt-2 p-2 rounded bg-red-50 border border-red-200 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-red-600 shrink-0 mt-0.5" />
                      <span className="text-[11px] font-bold text-red-700 line-clamp-2">
                        Alerta: {conv.escalation_reason}
                      </span>
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Columna Derecha: Historial de Chat y Controles */}
      <div className="flex-1 flex flex-col bg-[#F8FAFC]">
        {!selectedConversation ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-12 h-12 rounded-xl bg-slate-200 flex items-center justify-center text-slate-500 mb-3">
              <Bot className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-bold text-[#0F172A]">
              Selecciona una conversación
            </h3>
            <p className="text-xs text-slate-500 mt-1 max-w-xs">
              Elige un paciente en la columna izquierda para supervisar a PULSO AI o responder desde Recepción.
            </p>
          </div>
        ) : (
          <>
            {/* Cabecera del chat con interruptor prominente Pausar IA / Reactivar IA y badge Pago por verificar */}
            <div className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-base font-bold text-[#0F172A] truncate">
                    {selectedConversation.patients?.full_name ||
                      selectedConversation.patients?.phone ||
                      'Paciente'}
                  </h2>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                      selectedConversation.patients?.status === 'booked'
                        ? 'bg-[#10B981]/15 text-[#10B981]'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {selectedConversation.patients?.status === 'booked'
                      ? 'booked'
                      : 'lead'}
                  </span>

                  {selectedConversation.payment_pending_verification === true && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-300">
                      <CreditCard className="w-3.5 h-3.5" />
                      Pago por verificar
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  WhatsApp: {selectedConversation.patients?.phone}
                </p>
              </div>

              <div className="flex items-center gap-2.5 shrink-0">
                {selectedConversation.payment_pending_verification === true && (
                  <button
                    type="button"
                    onClick={() => void handleVerifyPayment()}
                    className="px-3.5 py-2 rounded-lg bg-yellow-400 hover:bg-yellow-500 text-[#0F172A] text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors shadow-sm"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Marcar Pago Verificado
                  </button>
                )}

                <button
                  type="button"
                  disabled={isTogglingAi}
                  onClick={() => void handleToggleAi()}
                  className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-colors shadow-sm disabled:opacity-50 ${
                    selectedConversation.ai_enabled
                      ? 'bg-amber-500 hover:bg-amber-600 text-[#0F172A]'
                      : 'bg-[#10B981] hover:bg-emerald-600 text-[#0F172A]'
                  }`}
                >
                  {selectedConversation.ai_enabled ? (
                    <>
                      <PauseCircle className="w-4 h-4" />
                      Pausar IA
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-4 h-4" />
                      Reactivar IA
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Alerta roja en cabecera si existe escalation_reason */}
            {selectedConversation.escalation_reason && (
              <div className="bg-red-50 border-b border-red-200 px-6 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-red-800">
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                  <span>
                    Escalamiento a Recepción: {selectedConversation.escalation_reason}
                  </span>
                </div>
                <span className="text-[11px] font-bold uppercase text-red-700">
                  IA Pausada
                </span>
              </div>
            )}

            {error && (
              <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs font-medium text-amber-800">
                {error}
              </div>
            )}

            {/* Historial de chat diferenciando patient, ai y human, más íconos multimedia */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {isLoadingMessages && activeMessages.length === 0 ? (
                <div className="text-center text-xs text-slate-500 py-12">
                  Cargando historial de mensajes...
                </div>
              ) : activeMessages.length === 0 ? (
                <div className="text-center text-xs text-slate-500 py-12">
                  No hay mensajes registrados en esta conversación.
                </div>
              ) : (
                activeMessages.map((msg) => {
                  const isPatient = msg.sender_type === 'patient';
                  const isAi = msg.sender_type === 'ai';
                  const isVoice = isVoiceMessage(msg);
                  const isImage = isImageOrReceiptMessage(msg);

                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${
                        isPatient ? 'items-start' : 'items-end'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1 px-1">
                        {isPatient ? (
                          <>
                            <User className="w-3 h-3 text-slate-500" />
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-200 text-[#0F172A]">
                              Paciente
                            </span>
                          </>
                        ) : isAi ? (
                          <>
                            <Bot className="w-3 h-3 text-[#06B6D4]" />
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#06B6D4]/20 text-[#0F172A]">
                              IA
                            </span>
                          </>
                        ) : (
                          <>
                            <UserCheck className="w-3 h-3 text-[#10B981]" />
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#10B981]/20 text-[#0F172A]">
                              Recepción
                            </span>
                          </>
                        )}

                        {isVoice && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-[#06B6D4]/15 text-[#0F172A]">
                            <Mic className="w-3 h-3 text-[#06B6D4]" />
                            [Nota de voz]
                          </span>
                        )}

                        {isImage && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800">
                            <ImageIcon className="w-3 h-3 text-yellow-700" />
                            [Imagen / Comprobante]
                          </span>
                        )}

                        <span className="text-[10px] text-slate-400">
                          {formatCaracasTime(msg.created_at)}
                        </span>
                      </div>

                      <div
                        className={`max-w-xl rounded-xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                          isPatient
                            ? 'bg-white border border-slate-200 text-[#0F172A]'
                            : isAi
                              ? 'bg-[#0F172A] text-white border border-slate-800'
                              : 'bg-[#10B981] text-[#0F172A] font-medium'
                        }`}
                      >
                        {isVoice && (
                          <div className="flex items-center gap-2 pb-1.5 mb-1.5 border-b border-slate-100 text-xs font-bold text-[#06B6D4]">
                            <Mic className="w-4 h-4 shrink-0" />
                            <span>Nota de Voz Procesada por Gemini 2.5 Flash</span>
                          </div>
                        )}

                        {isImage && (
                          <div className="flex items-center gap-2 pb-1.5 mb-1.5 border-b border-slate-100 text-xs font-bold text-amber-600">
                            <ImageIcon className="w-4 h-4 shrink-0" />
                            <span>Imagen / Captura de Pago Analizada por IA</span>
                          </div>
                        )}

                        <p className="whitespace-pre-wrap break-words">{msg.content}</p>

                        {msg.media_transcript &&
                          !msg.content.includes(msg.media_transcript) && (
                            <p className="mt-2 pt-2 border-t border-slate-200/60 text-xs text-slate-500">
                              Transcripción IA: {msg.media_transcript}
                            </p>
                          )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input inferior para enviar respuestas manuales */}
            <form
              onSubmit={handleSendMessage}
              className="bg-white border-t border-slate-200 p-4"
            >
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  disabled={isSendingMessage}
                  placeholder="Escribe una respuesta manual desde Recepción (pausará automáticamente la IA)..."
                  className="flex-1 px-4 py-2.5 text-sm bg-[#F8FAFC] border border-slate-300 rounded-lg text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
                />
                <button
                  type="submit"
                  disabled={isSendingMessage || !draftText.trim()}
                  className="px-5 py-2.5 rounded-lg bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-colors disabled:opacity-50"
                >
                  <Send className="w-4 h-4 text-[#06B6D4]" />
                  {isSendingMessage ? 'Enviando...' : 'Enviar'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
