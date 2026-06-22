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
    const userId = user._id?.toString?.() || user._id;
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

export default {
  buildError,
  checkDoctorPermission,
  determineActionType,
  sanitizeAppointmentPayload,
  toObjectIdString,
};
