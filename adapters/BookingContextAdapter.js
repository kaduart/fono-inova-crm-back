// adapters/BookingContextAdapter.js
// Transforma dados entre WhatsAppOrchestrator ↔ BookingHandler

/**
 * Adapta contexto do WhatsAppOrchestrator para formato do BookingHandler
 * @param {Object} params
 * @param {Object} params.lead - Lead do banco
 * @param {Object|String} params.message - Mensagem do usuário
 * @param {Object} params.context - Contexto do Orchestrator (therapy, age, period, etc.)
 * @param {Object} params.slots - Slots de agendamento encontrados
 * @param {Object} params.chosenSlot - Slot escolhido pelo usuário
 * @returns {Object} Contexto no formato esperado pelo BookingHandler
 */
export function buildDecisionContext({ lead, message, context, slots, chosenSlot }) {
  // Normaliza message (pode ser objeto ou string)
  const messageText = typeof message === 'string'
    ? message
    : message?.content || message?.text || '';

  return {
    message: {
      text: messageText,
      ...(typeof message === 'object' ? message : {})
    },
    lead,
    memory: {
      // Mapeia campos do Orchestrator para BookingHandler
      patientName: context.patientName,
      patientBirthDate: context.patientBirthDate || lead?.patientInfo?.birthDate,
      therapyArea: context.therapy,
      complaint: context.complaint,
      preferredPeriod: context.period,
      age: context.age,
      tipo_paciente: context.tipo_paciente,

      // Preserva todo o contexto adicional
      ...context
    },
    missing: {
      needsSlot: !slots && context.therapy && context.age && context.period,
      needsSlotSelection: !!slots && !chosenSlot,
      needsName: !!chosenSlot && !context.patientName,
      needsBirthdate: !!context.patientName && !context.patientBirthDate
    },
    booking: {
      slots: slots || lead?.pendingSchedulingSlots,
      chosenSlot: chosenSlot || lead?.pendingChosenSlot,
      slotGone: false,
      noSlotsAvailable: slots?.primary?.length === 0 && slots?.secondary?.length === 0
    },
    analysis: {
      extractedInfo: {
        age: context.age,
        relationship: context.tipo_paciente
      },
      detectedTherapy: context.therapy
    }
  };
}

/**
 * Mapeia resposta do BookingHandler de volta para formato do Orchestrator
 * @param {Object} bookingResponse - Resposta do BookingHandler
 * @returns {Object} Resposta no formato do Orchestrator
 */
export function mapBookingResponseToOrchestratorFormat(bookingResponse) {
  return {
    text: bookingResponse.text,
    extractedInfo: bookingResponse.extractedInfo || {},
    shouldUpdateContext: true,
    command: bookingResponse.command || 'SEND_MESSAGE'
  };
}

/**
 * Extrai informações atualizadas do BookingHandler para o contexto do Orchestrator
 * @param {Object} bookingResponse - Resposta do BookingHandler
 * @param {Object} currentContext - Contexto atual do Orchestrator
 * @returns {Object} Contexto atualizado
 */
export function mergeBookingDataToContext(bookingResponse, currentContext) {
  const updates = {};

  if (bookingResponse.extractedInfo) {
    const { extractedInfo } = bookingResponse;

    // Mapeia campos do BookingHandler de volta para Orchestrator
    if (extractedInfo.patientName) updates.patientName = extractedInfo.patientName;
    if (extractedInfo.patientBirthDate) updates.patientBirthDate = extractedInfo.patientBirthDate;
    if (extractedInfo.age) updates.age = extractedInfo.age;
    if (extractedInfo.chosenSlot) updates.chosenSlot = extractedInfo.chosenSlot;
  }

  return {
    ...currentContext,
    ...updates
  };
}
