// back/services/appointment/commands/_helpers.js
/**
 * Helpers compartilhados entre os commands de appointment.
 *
 * Regras:
 * - Não devem conter lógica de negócio específica de um command
 * - Apenas utilitários transversais: erros, permissões, sanitização
 */

/**
 * Constrói um erro padronizado para os commands.
 */
export function buildError(message, status = 500, code = 'INTERNAL_ERROR') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Verifica se um usuário com role 'doctor' pode manipular o agendamento.
 */
export function checkDoctorPermission(appointment, user) {
  if (!appointment || !user) return;
  if (user.role === 'doctor') {
    const appointmentDoctor = appointment.doctor?.toString?.() || appointment.doctor;
    const userId = user._id?.toString?.() || user.id?.toString?.() || user._id || user.id;
    if (appointmentDoctor && appointmentDoctor !== userId) {
      throw buildError('Você não pode editar este agendamento', 403, 'FORBIDDEN');
    }
  }
}

/**
 * Determina o tipo de ação para handlePackageSessionUpdate.
 */
export function determineActionType(updateData, previousData) {
  if (updateData.status === 'canceled') return 'cancel';
  if (updateData.date || updateData.time) return 'reschedule';
  return 'update';
}

/**
 * Remove campos que não devem ser atualizados diretamente no payload.
 */
export function sanitizeAppointmentPayload(payload) {
  const {
    _id: _bodyId,
    id: _bodyStringId,
    __v: _bodyV,
    isNewPatient: _isNewPatient,
    patientInfo: _patientInfo,
    ...safeBody
  } = payload || {};

  if (safeBody.package && typeof safeBody.package === 'object') {
    safeBody.package = safeBody.package._id || safeBody.package.id || null;
  }

  return safeBody;
}

/**
 * Normaliza ObjectId ou string para comparação.
 */
export function toObjectIdString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return value._id.toString?.() || value._id;
  return value.toString?.() || value;
}

/**
 * Máquina de estados operacional do Appointment.
 *
 * Regra de ouro: operationalStatus é o estado soberano do fluxo financeiro/operacional.
 * Qualquer mutação deve passar por um command ou por um serviço de transição explícito.
 *
 * As transições listadas aqui devem refletir APENAS caminhos de negócio válidos.
 * Novas transições só devem ser adicionadas após análise de impacto.
 */
const OPERATIONAL_STATE_MACHINE = {
  pre_agendado: ['scheduled', 'canceled', 'missed'],
  pending: ['validating', 'canceled', 'rejected'],
  validating: ['scheduled', 'rejected', 'pending'],
  scheduled: ['confirmed', 'canceled', 'missed', 'pre_agendado'],
  confirmed: ['completed', 'canceled', 'missed'],
  processing_create: ['scheduled', 'pending'],
  processing_cancel: ['canceled', 'scheduled'],
  processing_complete: ['completed', 'scheduled'],
  completed: ['canceled'], // reversão administrativa, rara
  canceled: ['scheduled', 'pre_agendado'], // reativação
  missed: ['scheduled', 'canceled'],
  rejected: ['pending', 'scheduled'],
};

/**
 * Valida se uma transição de operationalStatus é permitida.
 *
 * @param {string} from - Estado atual
 * @param {string} to - Estado desejado
 * @param {string} context - Nome do command/serviço (para log de erro)
 * @param {Object} [options]
 * @param {boolean} [options.allowSameState=true] - Permite transição para o mesmo estado (idempotência)
 * @throws {Error} Se a transição for inválida
 */
export function assertAppointmentTransition(from, to, context, options = {}) {
  const { allowSameState = true } = options;

  if (from === to && allowSameState) return;

  const allowed = OPERATIONAL_STATE_MACHINE[from] || [];
  if (!allowed.includes(to)) {
    throw buildError(
      `Transição de estado inválida em ${context}: '${from}' → '${to}'. ` +
        `Caminhos permitidos a partir de '${from}': ${(OPERATIONAL_STATE_MACHINE[from] || []).join(', ') || 'nenhum'}.`,
      409,
      'INVALID_STATE_TRANSITION'
    );
  }
}

export default {
  buildError,
  checkDoctorPermission,
  determineActionType,
  sanitizeAppointmentPayload,
  toObjectIdString,
  assertAppointmentTransition,
};
