// back/domain/appointment/cancelRequester.js
/**
 * Quem SOLICITOU o cancelamento (relatório de compromisso/recorrência).
 *
 * Diferente de:
 *  - Appointment.canceledBy    → usuário do CRM que REGISTROU (ex.: secretária)
 *  - Appointment.cancelSource  → qual rotina do sistema cancelou (guide_closure, migration…)
 *
 * `null` = "Não informado" (histórico antigo e fluxos automáticos). Nunca inferir.
 */

export const CANCEL_REQUESTERS = Object.freeze(['patient', 'professional', 'clinic']);

export const CANCEL_REQUESTER_LABELS = Object.freeze({
  patient: 'Paciente/responsável',
  professional: 'Profissional',
  clinic: 'Clínica',
});

// cancelSource que indicam cancelamento automático/sistêmico (não é pedido de ninguém)
export const SYSTEM_CANCEL_SOURCES = Object.freeze([
  'system_billing',
  'guide_closure',
  'migration',
  'converted_to_package',
  'liminar_plan_update', // dia da semana removido do plano da liminar
  'unconfirmed_auto',    // job das 18h: não confirmou
  'package_exhausted',   // pacote esgotado: sessões futuras liberadas
]);

// Canais SEM solicitante informado, mantidos visíveis no relatório (não é "inferência").
export const CANCEL_CHANNELS = Object.freeze(['agenda_service', 'amanda', 'legacy_client']);

// Transição de deploy: telas do CRM já abertas (versão antiga) não enviam o
// solicitante. INSTANTE EXATO (fuso de São Paulo, UTC-3, sem horário de verão desde 2019):
//   - aceita sem solicitante enquanto agora < 2026-12-01T00:00:00-03:00
//     (ou seja, o dia 30/11/2026 inteiro ainda é aceito, até 23:59:59.999);
//   - a partir de 2026-12-01T00:00:00-03:00 passa a ser OBRIGATÓRIO (400 MISSING_CANCEL_REQUESTER).
// Quando aceito, marca como 'legacy_client' e aparece no relatório. Ajustável nos testes.
// Só vale para o canal "usuário do CRM" (parseCancelRequester com required=true); os canais
// de serviço (agenda externa, sync legado) enviam o solicitante opcionalmente — ver
// docs/CANCEL_REQUESTER_INTEGRATION_CONTRACT.md.
export const LEGACY_GRACE_ENDS_AT_ISO = '2026-12-01T00:00:00-03:00';
let legacyGraceUntil = new Date(LEGACY_GRACE_ENDS_AT_ISO);
export function setLegacyGraceUntilForTests(d) { legacyGraceUntil = d; }

function buildError(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.statusCode = 400;
  err.code = code;
  return err;
}

/**
 * Valida e normaliza o solicitante vindo de um request manual.
 *
 * @param {Object} input
 * @param {string} [input.cancelRequester]
 * @param {string|Date} [input.cancelRequestedAt] quando o pedido realmente chegou (opcional)
 * @param {Object} [opts]
 * @param {boolean} [opts.required=true]
 * @returns {{ cancelRequester: string|null, cancelRequestedAt: Date|null }}
 */
export function parseCancelRequester(input = {}, { required = true } = {}) {
  const raw = input?.cancelRequester;
  const requester = typeof raw === 'string' ? raw.trim() : raw;

  if (requester === undefined || requester === null || requester === '') {
    if (required && Date.now() < legacyGraceUntil.getTime()) {
      return { cancelRequester: null, cancelRequestedAt: null, cancelChannel: 'legacy_client' };
    }
    if (required) {
      throw buildError(
        'Informe quem solicitou o cancelamento (paciente, profissional ou clínica)',
        'MISSING_CANCEL_REQUESTER'
      );
    }
    return { cancelRequester: null, cancelRequestedAt: null };
  }

  if (!CANCEL_REQUESTERS.includes(requester)) {
    throw buildError(
      `Solicitante de cancelamento inválido: ${requester}`,
      'INVALID_CANCEL_REQUESTER'
    );
  }

  let cancelRequestedAt = null;
  if (input.cancelRequestedAt) {
    const d = new Date(input.cancelRequestedAt);
    if (Number.isNaN(d.getTime())) {
      throw buildError('Data/hora do pedido de cancelamento inválida', 'INVALID_CANCEL_REQUESTED_AT');
    }
    // Pedido não pode estar no futuro (tolerância de 5 min p/ relógio do cliente)
    if (d.getTime() > Date.now() + 5 * 60 * 1000) {
      throw buildError('A data/hora do pedido não pode estar no futuro', 'INVALID_CANCEL_REQUESTED_AT');
    }
    cancelRequestedAt = d;
  }

  return { cancelRequester: requester, cancelRequestedAt };
}

export default { CANCEL_REQUESTERS, CANCEL_REQUESTER_LABELS, SYSTEM_CANCEL_SOURCES, parseCancelRequester };
