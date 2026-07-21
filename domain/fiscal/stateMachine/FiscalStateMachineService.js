// domain/fiscal/stateMachine/FiscalStateMachineService.js
// Único serviço autorizado a alterar FiscalInvoice.status (Fase 2 v3, invariante #6).
// Reconstrói o estado a partir do histórico de OfficialFiscalEvent — nunca aceita um novo evento
// sem antes revalidar contra a matriz oficial (constants/fiscalEventTransitions.js).

import { FiscalInvoiceStatus } from '../../../constants/fiscalEnums.js';
import { TipoEvento } from '../../../constants/fiscalEvents.js';
import {
  NO_CANCELLATION_EVENT_YET,
  CANCELLATION_FAMILY_TRANSITIONS,
  isCancellationFamilyEvent,
  isManifestationEvent,
  isBlockOrUnblockEvent,
  isTerminalCancellationEvent,
  BLOQUEAVEIS_TIPOS_EVENTO
} from '../../../constants/fiscalEventTransitions.js';
import { officialFiscalEventRepository } from '../../../infrastructure/persistence/OfficialFiscalEventRepository.js';
import { fiscalInvoiceRepository } from '../../../infrastructure/persistence/FiscalInvoiceRepository.js';

/**
 * Reconstrói o estado derivado (status, último evento da família de cancelamento, tipos
 * bloqueados, manifestações) a partir de uma lista de OfficialFiscalEvent EM ORDEM CRONOLÓGICA.
 * Função pura — não lê nem escreve no banco.
 */
export function reconstructState(events) {
  let lastCancellationFamilyEvent = NO_CANCELLATION_EVENT_YET;
  const blockedEventTypes = new Set();
  const manifestations = [];

  for (const event of events) {
    const { tipoEvento, targetTipoEvento } = event;

    if (isCancellationFamilyEvent(tipoEvento)) {
      lastCancellationFamilyEvent = tipoEvento;
      continue;
    }

    if (isManifestationEvent(tipoEvento)) {
      manifestations.push(event);
      continue;
    }

    if (isBlockOrUnblockEvent(tipoEvento)) {
      if (tipoEvento === TipoEvento.BLOQUEIO_POR_OFICIO) {
        blockedEventTypes.add(targetTipoEvento);
      } else {
        blockedEventTypes.delete(targetTipoEvento);
      }
    }
  }

  const status = deriveStatusFromCancellationFamily(lastCancellationFamilyEvent);

  return {
    status,
    lastCancellationFamilyEvent,
    blockedEventTypes,
    manifestations
  };
}

function deriveStatusFromCancellationFamily(lastCancellationFamilyEvent) {
  switch (lastCancellationFamilyEvent) {
    case NO_CANCELLATION_EVENT_YET:
      return FiscalInvoiceStatus.AUTHORIZED;
    case TipoEvento.CANCELAMENTO:
    case TipoEvento.CANCELAMENTO_DEFERIDO_ANALISE_FISCAL:
    case TipoEvento.CANCELAMENTO_POR_OFICIO:
      return FiscalInvoiceStatus.CANCELLED;
    case TipoEvento.CANCELAMENTO_POR_SUBSTITUICAO:
      return FiscalInvoiceStatus.CANCELLED_SUBSTITUTED;
    case TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO:
      return FiscalInvoiceStatus.PENDING_FISCAL_ANALYSIS;
    case TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL:
      // Não terminal — nota permanece válida (event_matrix.md Seção 3.3/3, achado Fase 1.5)
      return FiscalInvoiceStatus.AUTHORIZED;
    default:
      return FiscalInvoiceStatus.AUTHORIZED;
  }
}

/**
 * Valida se um tipoEvento recebido/solicitado pode ser aplicado dado o estado atual.
 * Não persiste nada — só decide.
 */
export function validateIncomingEvent(currentState, { tipoEvento, targetTipoEvento }) {
  if (
    currentState.status === FiscalInvoiceStatus.CANCELLED ||
    currentState.status === FiscalInvoiceStatus.CANCELLED_SUBSTITUTED
  ) {
    return { allowed: false, reason: 'FISCAL_INVOICE_TERMINAL_STATE' };
  }

  if (isManifestationEvent(tipoEvento)) {
    return { allowed: true };
  }

  if (isBlockOrUnblockEvent(tipoEvento)) {
    if (tipoEvento === TipoEvento.BLOQUEIO_POR_OFICIO) {
      if (!BLOQUEAVEIS_TIPOS_EVENTO.includes(targetTipoEvento)) {
        return { allowed: false, reason: 'TARGET_TIPO_EVENTO_NAO_BLOQUEAVEL' };
      }
      if (currentState.blockedEventTypes.has(targetTipoEvento)) {
        return { allowed: false, reason: 'TARGET_JA_BLOQUEADO' };
      }
      return { allowed: true };
    }
    // Desbloqueio
    if (!currentState.blockedEventTypes.has(targetTipoEvento)) {
      return { allowed: false, reason: 'NAO_HA_BLOQUEIO_PENDENTE_PARA_ESSE_ALVO' };
    }
    return { allowed: true };
  }

  if (isCancellationFamilyEvent(tipoEvento)) {
    if (currentState.blockedEventTypes.has(tipoEvento)) {
      return { allowed: false, reason: 'TIPO_EVENTO_BLOQUEADO_POR_OFICIO' };
    }
    const allowedNext = CANCELLATION_FAMILY_TRANSITIONS[currentState.lastCancellationFamilyEvent] || [];
    if (!allowedNext.includes(tipoEvento)) {
      return { allowed: false, reason: 'TRANSICAO_NAO_PERMITIDA_PELA_MATRIZ_OFICIAL' };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: 'TIPO_EVENTO_NAO_CATALOGADO' };
}

/**
 * Transições PRÉ-autorização (não derivadas de OfficialFiscalEvent — a nota nem existe perante o
 * Fisco ainda). Continuam centralizadas aqui para manter a invariante #6 ("nada além deste
 * serviço altera status") sem exceção.
 */

export async function transitionToPendingSubmission(fiscalInvoiceId, { session } = {}) {
  return fiscalInvoiceRepository._setStatus(fiscalInvoiceId, FiscalInvoiceStatus.PENDING_SUBMISSION, {}, { session });
}

/**
 * PENDING_SUBMISSION → AUTHORIZED. Recebe os campos oficiais já resolvidos pela chamada real
 * (PR3) — este serviço só persiste, nunca decide o conteúdo.
 */
export async function transitionToAuthorized(fiscalInvoiceId, officialFields, { session } = {}) {
  return fiscalInvoiceRepository._setStatus(
    fiscalInvoiceId,
    FiscalInvoiceStatus.AUTHORIZED,
    officialFields,
    { session }
  );
}

/**
 * PENDING_SUBMISSION → REJECTED. Terminal para ESTA FiscalInvoice (não existe retry no mesmo
 * registro — uma nova tentativa depois de rejeição de negócio exige nova FiscalInvoice/DPS,
 * já que a numeração da DPS não deve ser reaproveitada ambiguamente). Diferente de
 * network_error/timeout, que não chamam esta função e mantêm a nota em PENDING_SUBMISSION
 * para retry via nova FiscalSubmission.
 */
export async function transitionToRejected(fiscalInvoiceId, { rejectionReason }, { session } = {}) {
  return fiscalInvoiceRepository._setStatus(
    fiscalInvoiceId,
    FiscalInvoiceStatus.REJECTED,
    { rejectionReason },
    { session }
  );
}

/**
 * Aplica um novo evento oficial: valida contra o histórico, persiste o OfficialFiscalEvent
 * (append-only) e atualiza FiscalInvoice.status/blockedEventTypes/manifestations no mesmo
 * commit. Único caminho autorizado a mudar `status` (invariante #6).
 *
 * @throws {Error} FISCAL_EVENT_TRANSITION_REJECTED se a transição não for permitida
 */
export async function applyOfficialFiscalEvent(fiscalInvoiceId, eventData, { session } = {}) {
  const priorEvents = await officialFiscalEventRepository.findByFiscalInvoice(fiscalInvoiceId);
  const currentState = reconstructState(priorEvents);

  const validation = validateIncomingEvent(currentState, {
    tipoEvento: eventData.tipoEvento,
    targetTipoEvento: eventData.targetTipoEvento
  });

  if (!validation.allowed) {
    const error = new Error(`FISCAL_EVENT_TRANSITION_REJECTED: ${validation.reason}`);
    error.code = validation.reason;
    throw error;
  }

  const savedEvent = await officialFiscalEventRepository.create(
    { ...eventData, fiscalInvoice: fiscalInvoiceId },
    { session }
  );

  const newState = reconstructState([...priorEvents, savedEvent]);

  await fiscalInvoiceRepository._setStatus(
    fiscalInvoiceId,
    newState.status,
    {
      blockedEventTypes: Array.from(newState.blockedEventTypes),
      manifestations: newState.manifestations.map((m) => m._id || m.id)
    },
    { session }
  );

  return { event: savedEvent, state: newState };
}
