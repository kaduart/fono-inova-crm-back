// back/services/appointment/policies/appointmentSpecialtyPolicy.js
/**
 * Appointment Specialty Policy
 *
 * Política centralizada de integridade entre o médico selecionado e a
 * especialidade do agendamento. Responsabilidade: impedir a criação/edição
 * de um agendamento cuja `specialty` não corresponda à `Doctor.specialty`
 * do profissional vinculado.
 *
 * Motivação: auditoria de 2026-07-07 encontrou 311 appointments com esse
 * tipo de divergência na base (80 criados nos 30 dias anteriores à auditoria,
 * ~3/dia) — nenhum validador impedia isso na origem. Ver
 * back/docs/finance-integrity-audit/ pro contexto completo da investigação.
 *
 * Filosofia: diferente da AppointmentFinancialPolicy (que corrige
 * silenciosamente), aqui o comportamento é BLOQUEAR — não dá pra saber com
 * segurança se o erro está no médico ou na especialidade escolhida, então a
 * decisão correta é rejeitar a operação e deixar o usuário corrigir.
 */

import Doctor from '../../../models/Doctor.js';

function buildError(message, status = 400, code = 'DOCTOR_SPECIALTY_MISMATCH') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Valida se a especialidade do agendamento corresponde à especialidade do
 * médico. Não faz nada se `doctorId` ou `specialty` estiverem ausentes —
 * essa política não substitui validação de campos obrigatórios, só impede
 * a combinação inconsistente quando ambos existem.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.doctorId
 * @param {string} params.specialty
 * @param {import('mongoose').ClientSession} [mongoSession]
 * @throws {Error} status 400, code DOCTOR_SPECIALTY_MISMATCH
 */
export async function validateDoctorSpecialty({ doctorId, specialty }, mongoSession = null) {
  if (!doctorId || !specialty) return;

  const query = Doctor.findById(doctorId).select('specialty fullName');
  if (mongoSession) query.session(mongoSession);
  const doctor = await query.lean();

  // Médico não encontrado é responsabilidade de outro guard (ex: doctor obrigatório).
  if (!doctor || !doctor.specialty) return;

  if (doctor.specialty !== specialty) {
    throw buildError(
      `Especialidade do agendamento ('${specialty}') não corresponde à especialidade do ` +
        `profissional ${doctor.fullName ? `'${doctor.fullName}' ` : ''}('${doctor.specialty}').`,
      400,
      'DOCTOR_SPECIALTY_MISMATCH'
    );
  }
}

export default { validateDoctorSpecialty };
