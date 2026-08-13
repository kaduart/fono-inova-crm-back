// back/services/billing/commands/packageUpdatePolicy.js
/**
 * Política de edição de Package (PUT /api/v2/packages/:id)
 *
 * REGRA CENTRAL: o PUT comum é um endpoint cadastral, não financeiro.
 * Ele nunca reescreve venda, recebimento, quantidade contratada, valor de
 * sessão, especialidade, paciente ou profissional — esses fatos são
 * históricos ou exigem propagação para Appointment/Session/Payment.
 *
 * Cada um deles tem (ou terá) um fluxo próprio:
 * - profissional/horário das futuras → PATCH /:id/appointments/bulk
 * - encerrar pacote                  → POST  /:id/inactivate
 * - converter sessões p/ outra       → POST  /:id/transfer (Fase 3)
 *
 * Semântica de campo bloqueado:
 * - enviado com o MESMO valor atual → ignorado em silêncio (payload legado)
 * - enviado com valor DIFERENTE     → 422, com motivo e caminho correto
 *
 * Nunca descartar mudança em silêncio e responder 200: era exatamente esse
 * o defeito que fazia o modal exibir "atualizado com sucesso" sem gravar nada.
 */

/** Campos realmente editáveis pelo PUT comum. */
export const EDITABLE_FIELDS = ['notes'];

const TRANSFER_HINT = 'Use "Transferir sessões para outro pacote".';
const BULK_HINT = 'Use "Trocar terapeuta das sessões futuras" (atualiza agendamento, sessão e pagamento juntos).';
const HISTORY_MSG = 'é um fato histórico do pacote e não pode ser reescrito pela edição comum';

/**
 * Campos bloqueados → motivo exibido ao usuário.
 * `compareWith` aponta o campo do documento quando o nome do payload difere.
 */
const BLOCKED_FIELDS = {
  // ── Financeiro: fatos consumados ──────────────────────────────────────────
  payments: { reason: `O histórico de pagamentos ${HISTORY_MSG}.`, always: true },
  totalValue: { reason: `O valor total contratado ${HISTORY_MSG}.`, hint: TRANSFER_HINT },
  totalPaid: { reason: `O valor recebido ${HISTORY_MSG}.` },
  sessionValue: { reason: `O valor por sessão ${HISTORY_MSG}.`, hint: TRANSFER_HINT },
  totalSessions: { reason: `A quantidade de sessões contratada ${HISTORY_MSG}.`, hint: TRANSFER_HINT },
  balance: { reason: 'Saldo é calculado pelo backend, nunca informado pelo cliente.' },
  financialBalance: { reason: 'Saldo é calculado pelo backend, nunca informado pelo cliente.' },
  consumptionBalance: { reason: 'Saldo é calculado pelo backend, nunca informado pelo cliente.' },
  consumedValue: { reason: 'Valor consumido é derivado das sessões realizadas.' },
  financialStatus: { reason: 'Status financeiro é derivado de totalPaid × totalValue.' },
  paidSessions: { reason: 'Contador derivado do settlement das sessões.' },
  sessionsDone: { reason: 'Contador derivado das sessões realizadas.' },
  canceledSessions: { reason: 'Contador derivado das sessões canceladas.' },
  preConsumedCount: { reason: `Retroativas absorvidas na criação ${HISTORY_MSG}.` },

  // ── Identidade clínica ────────────────────────────────────────────────────
  patient: { reason: 'O paciente do pacote não pode ser trocado após a criação.' },
  patientId: { reason: 'O paciente do pacote não pode ser trocado após a criação.', compareWith: 'patient' },
  specialty: { reason: 'A especialidade não pode ser trocada em pacote já iniciado.', hint: TRANSFER_HINT },
  sessionType: { reason: 'A especialidade não pode ser trocada em pacote já iniciado.', hint: TRANSFER_HINT },
  doctor: { reason: 'Trocar o profissional aqui não atualizaria os agendamentos.', hint: BULK_HINT },
  doctorId: { reason: 'Trocar o profissional aqui não atualizaria os agendamentos.', hint: BULK_HINT, compareWith: 'doctor' },

  // ── Estrutura definida na criação ─────────────────────────────────────────
  type: { reason: 'O tipo do pacote é definido na criação.' },
  model: { reason: 'O modelo de cobrança (pré-pago × por sessão) é definido na criação.' },
  paymentType: { reason: 'A forma de pagamento é definida na criação.' },
  frequencyInterval: { reason: 'A frequência é definida na criação do pacote.' },
  durationMonths: { reason: 'A duração é definida na criação do pacote.' },
  sessionsPerWeek: { reason: 'A frequência semanal é definida na criação do pacote.' },
  calculationMode: { reason: 'O modo de cálculo é definido na criação do pacote.' },
  date: { reason: 'A data de início é definida na criação do pacote.' },
  time: { reason: 'O horário base é definido na criação do pacote.', hint: BULK_HINT },
  status: { reason: 'O status do pacote muda por ação própria.', hint: 'Use "Inativar pacote".' },

  // ── Estrutura interna ─────────────────────────────────────────────────────
  sessions: { reason: 'Vínculos de sessão são mantidos pelo domínio.', always: true },
  appointments: { reason: 'Vínculos de agendamento são mantidos pelo domínio.', always: true },
  _id: { reason: 'Identificador não é editável.' },
  idempotencyKey: { reason: 'Chave de idempotência não é editável.' },
  txid: { reason: 'Identificador de transação não é editável.' },
};

/**
 * Traduz o dialeto da API para o do model.
 * O contrato público usa type='package'; o schema grava 'therapy'.
 * Sem isso, o Mongoose devolve ValidationError de enum como 500 opaco.
 */
export function normalizeApiDialect(updates = {}) {
  const normalized = { ...updates };
  if (normalized.type === 'package') normalized.type = 'therapy';
  return normalized;
}

function sameValue(incoming, current) {
  if (incoming === undefined || incoming === null) return current === undefined || current === null;
  if (current === undefined || current === null) return false;
  if (Array.isArray(incoming)) return false; // arrays nunca são comparáveis de forma confiável aqui
  if (current instanceof Date) return new Date(incoming).getTime() === current.getTime();
  if (typeof current === 'number') return Number(incoming) === current;
  return String(incoming) === String(current?._id ?? current);
}

/**
 * Classifica o payload contra o pacote atual.
 *
 * @returns {{ allowed: Object, blocked: Array, ignored: string[] }}
 *   allowed  - campos que podem ser gravados (já filtrados por mudança real)
 *   blocked  - tentativas de alterar campo protegido: [{ field, reason, hint }]
 *   ignored  - campos sem efeito (inexistentes no schema ou já com o valor enviado)
 */
export function classifyUpdates(updates, currentPackage) {
  const normalized = normalizeApiDialect(updates);
  const allowed = {};
  const blocked = [];
  const ignored = [];
  const hasCompletedSessions = (currentPackage?.sessionsDone || 0) > 0;

  for (const [field, value] of Object.entries(normalized)) {
    if (EDITABLE_FIELDS.includes(field)) {
      if (sameValue(value, currentPackage?.[field])) ignored.push(field);
      else allowed[field] = value;
      continue;
    }

    const rule = BLOCKED_FIELDS[field];
    if (!rule) {
      // Campo fora do schema (name, modality, …): o Mongoose descartaria em
      // silêncio. Reportamos para o cliente saber que não teve efeito.
      ignored.push(field);
      continue;
    }

    const isNoop = !rule.always && sameValue(value, currentPackage?.[rule.compareWith || field]);
    if (isNoop) {
      ignored.push(field);
      continue;
    }
    if (rule.always && (value === undefined || (Array.isArray(value) && value.length === 0))) {
      ignored.push(field);
      continue;
    }

    blocked.push({
      field,
      reason: rule.reason,
      hint: rule.hint || (hasCompletedSessions ? TRANSFER_HINT : undefined),
    });
  }

  return { allowed, blocked, ignored };
}

/**
 * Mensagem única para o usuário quando há campo bloqueado.
 * Prioriza a explicação de negócio sobre o nome técnico do campo.
 */
export function buildBlockedMessage(blocked, currentPackage) {
  const hasCompletedSessions = (currentPackage?.sessionsDone || 0) > 0;

  if (hasCompletedSessions) {
    return 'Este pacote já possui sessões realizadas. A especialidade, a quantidade contratada e os valores históricos não podem ser alterados pela edição comum. ' + TRANSFER_HINT;
  }

  const first = blocked[0];
  const extras = blocked.length > 1 ? ` (e mais ${blocked.length - 1} campo(s) protegido(s))` : '';
  return `${first.reason}${first.hint ? ' ' + first.hint : ''}${extras}`;
}

export default { EDITABLE_FIELDS, normalizeApiDialect, classifyUpdates, buildBlockedMessage };
