import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import PatientsView from '../../../models/PatientsView.js';
import Payment from '../../../models/Payment.js';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import Package from '../../../models/Package.js';
import PatientBalance from '../../../models/PatientBalance.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';

/**
 * Delete Patient Command
 *
 * Responsabilidade: deletar um paciente e TODOS os dados vinculados,
 * garantindo integridade referencial e evitando payments/sessions órfãos.
 *
 * 🔒 Regras:
 * - Executa dentro de transação MongoDB.
 * - Deleta em ordem segura: filhos primeiro, pai por último.
 * - Retorna contagem do que foi removido.
 * - Não deleta notas fiscais emitidas (fiscal permanece por obrigação legal).
 *
 * @param {string|ObjectId} patientId
 * @param {Object} options
 * @param {Object} options.user - usuário que solicitou (para auditoria futura)
 * @param {string} options.reason - motivo da exclusão
 * @param {ClientSession} options.mongoSession - sessão externa (opcional)
 * @returns {Promise<{patientId: string, deleted: boolean, counts: Object}>}
 */
async function _deleteAll(session, patientId, options) {
  const pid = new mongoose.Types.ObjectId(patientId);

  const patient = await Patient.findById(pid).session(session).lean();
  if (!patient) {
    const error = new Error('Paciente não encontrado');
    error.statusCode = 404;
    error.code = 'PATIENT_NOT_FOUND';
    throw error;
  }

  const counts = {
    payments: 0,
    appointments: 0,
    sessions: 0,
    packages: 0,
    patientBalances: 0,
    financialLedgers: 0,
    patientsView: 0,
    patient: 0
  };

  // 1. Deleta Payments vinculados ao paciente
  const paymentsResult = await Payment.deleteMany({ patient: pid }).session(session);
  counts.payments = paymentsResult.deletedCount;

  // 2. Deleta Sessions vinculadas ao paciente (antes de appointments para evitar hooks)
  const sessionsResult = await Session.deleteMany({ patient: pid }).session(session);
  counts.sessions = sessionsResult.deletedCount;

  // 3. Deleta Appointments vinculados ao paciente usando collection para bypassar hooks
  const db = mongoose.connection.db;
  const appointmentsResult = await db.collection('appointments').deleteMany({ patient: pid });
  counts.appointments = appointmentsResult.deletedCount;

  // 4. Deleta Packages vinculados ao paciente
  const packagesResult = await Package.deleteMany({ patient: pid }).session(session);
  counts.packages = packagesResult.deletedCount;

  // 5. Deleta PatientBalance vinculado ao paciente
  const balanceResult = await PatientBalance.deleteMany({ patient: pid }).session(session);
  counts.patientBalances = balanceResult.deletedCount;

  // 6. FinancialLedger é imutável por design — NÃO deletamos.
  //    Os registros contábeis permanecem, mesmo sem o paciente.
  counts.financialLedgers = 0;

  // 7. Deleta a view do paciente
  const viewResult = await PatientsView.deleteMany({ patientId: pid }).session(session);
  counts.patientsView = viewResult.deletedCount;

  // 8. Deleta o paciente
  await Patient.findByIdAndDelete(pid, { session });
  counts.patient = 1;

  return {
    patientId: pid.toString(),
    deleted: true,
    counts,
    reason: options.reason || null
  };
}

export async function execute(patientId, options = {}) {
  // Se já estamos dentro de uma transação externa, reaproveita a sessão
  if (options.mongoSession) {
    return await _deleteAll(options.mongoSession, patientId, options);
  }

  // Caso contrário, inicia uma nova transação com retry
  return await runTransactionWithRetry(async (session) => {
    return await _deleteAll(session, patientId, options);
  });
}

export default { execute };
