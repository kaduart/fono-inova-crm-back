// back/services/appointment/commands/deleteAppointmentCommand.js
/**
 * Delete Appointment Command
 *
 * Responsabilidade: deletar um agendamento isolado (sem pacote)
 * e garantir que referências em Session, Payment e Patient sejam limpas.
 *
 * 🔒 Regras:
 * - Só pode deletar appointments SEM pacote
 * - Appointment, Payment e referências em Patient devem ser atualizados atomically
 * - Session não é deletada, mas tem appointmentId removido
 */

import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import Payment from '../../../models/Payment.js';
import Patient from '../../../models/Patient.js';
import { updatePatientAppointments } from '../../../utils/appointmentUpdater.js';
import { emitSocket } from '../helpers/socketHelper.js';
import { buildError, toObjectIdString } from './_helpers.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';
import { EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { recordAudit } from '../../auditLogService.js';
import { findActiveBatchLink } from '../../insuranceBatch/insuranceBatchGuard.js';
import { transitionPaymentStatus } from '../../paymentStatusService.js';

export async function execute(id, user) {
  const appointment = await Appointment.findById(id).populate('session payment');

  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
  }

  if (appointment.package) {
    throw buildError(
      'Não é possível excluir agendamentos vinculados a pacotes. Use CANCELAR para manter integridade financeira.',
      400,
      'PACKAGE_APPOINTMENT_DELETE_BLOCKED'
    );
  }

  const { patient, session, payment } = appointment;
  const beforeSnapshot = appointment.toObject({ virtuals: false, getters: false });

  // 🛡️ PR D.1: bloqueia deleção se Session/Payment estiver em lote de faturamento ativo
  const sessionId = session?._id || appointment.session;
  const paymentId = payment?._id || appointment.payment;
  const activeBatch = await findActiveBatchLink({ sessionId, paymentId });
  if (activeBatch) {
    throw buildError(
      `Não é possível excluir este atendimento porque ele pertence ao lote de faturamento ${activeBatch.batchNumber}. Remova-o do lote ou cancele o lote antes de excluir.`,
      409,
      'INSURANCE_BATCH_DELETE_BLOCKED'
    );
  }

  await runTransactionWithRetry(async (mongoSession) => {
    // 1. Remove referência do appointment na Session
    if (session) {
      await Session.findByIdAndUpdate(
        session._id,
        { $unset: { appointmentId: 1 }, updatedAt: new Date() },
        { session: mongoSession }
      );
    }

    // 2. Trata TODOS os Payments associados (se não forem de pacote) — não só
    // o referenciado por appointment.payment. Sob sinal+saldo (2026-09-04) uma
    // consulta particular pode ter 2 Payments (deposit + balance); tratar só
    // o referenciado deixava o outro órfão no banco, apontando pra um
    // Appointment já deletado.
    //
    // 🛡️ Payment financeiramente realizado (status='paid' — dinheiro já entrou,
    // ex: sinal recebido) NUNCA é hard-deleted aqui: isso apagaria o histórico e
    // deixaria FinancialLedger.payment apontando pra um documento inexistente
    // (o ledger é imutável por design — nunca pode ficar orfão). Segue o mesmo
    // invariante já usado em cancelAppointmentCommand.js: paid → 'canceled' via
    // transitionPaymentStatus(), que já lança a reversão do crédito no ledger
    // (reverseActiveCreditIfAny). Só Payment SEM dinheiro real por trás (nunca
    // chegou a 'paid' — ex: saldo ainda pendente) é seguro remover fisicamente.
    const linkedPayments = await Payment.find({
      $or: [
        { appointment: appointment._id },
        { appointmentId: appointment._id.toString() },
        ...(sessionId ? [{ session: sessionId }] : []),
      ],
    }).session(mongoSession);
    const treatablePayments = linkedPayments.filter((p) => p.kind !== 'package_receipt');
    const paidPayments = treatablePayments.filter((p) => p.status === 'paid');
    const nonPaidPayments = treatablePayments.filter((p) => p.status !== 'paid');

    if (nonPaidPayments.length) {
      await Payment.deleteMany(
        { _id: { $in: nonPaidPayments.map((p) => p._id) } },
        { session: mongoSession }
      );
    }
    for (const paid of paidPayments) {
      await transitionPaymentStatus(paid._id, 'canceled', {
        reason: 'appointment_deleted',
        userId: user?._id,
        session: mongoSession,
      });
    }
    const deletablePayments = nonPaidPayments; // mantém nome usado no payload abaixo

    // 3. Remove appointment do array do paciente
    if (patient) {
      await Patient.findByIdAndUpdate(
        patient,
        { $pull: { appointments: appointment._id } },
        { session: mongoSession }
      );
    }

    // 4. Deleta o appointment
    await Appointment.findByIdAndDelete(appointment._id, { session: mongoSession });

    // 5. Registra evento de domínio no Outbox
    await saveToOutbox({
      eventType: EventTypes.APPOINTMENT_DELETED,
      aggregateType: 'appointment',
      aggregateId: appointment._id.toString(),
      payload: {
        appointmentId: appointment._id.toString(),
        patientId: patient?._id?.toString() || patient?.toString() || null,
        doctorId: appointment.doctor?._id?.toString() || appointment.doctor?.toString() || null,
        sessionId: session?._id?.toString() || null,
        paymentId: payment?._id?.toString() || null,
        // Todos os Payments desta operação (deposit + balance quando aplicável)
        // — paymentId acima preserva compatibilidade com consumidores existentes
        // do evento, que só esperavam 1 payment por appointment.
        paymentIds: deletablePayments.map((p) => p._id.toString()),
        // Payments com dinheiro real (status='paid') nunca são hard-deleted —
        // viram 'canceled' preservando histórico e disparando a reversão do
        // ledger. Consumidores que precisam saber "isso ainda existe no banco,
        // só mudou de status" devem olhar aqui, não em paymentIds.
        canceledPaymentIds: paidPayments.map((p) => p._id.toString()),
        // 🚨 FIX (2026-08-12): packageProjectionWorker exige packageId no payload;
        // sem ele o APPOINTMENT_DELETED é descartado e a view fica com a sessão.
        packageId: toObjectIdString(appointment.package),
      },
      correlationId: `appt_del_${appointment._id}_${Date.now()}`
    }, mongoSession);
  });

  // Side effects pós-transação
  try {
    await emitSocket('appointmentDeleted', {
      _id: appointment._id,
      patient,
      doctor: appointment.doctor,
      date: appointment.date,
      time: appointment.time,
      source: 'crm_delete',
    });
  } catch (socketErr) {
    console.error('[deleteAppointmentCommand] Erro ao emitir socket:', socketErr.message);
  }

  await updatePatientAppointments(patient);

  await recordAudit({
    user,
    action: 'appointment_deleted',
    entityType: 'Appointment',
    entityId: appointment._id,
    before: beforeSnapshot,
    after: null,
    source: 'appointment_command:deleteAppointmentCommand',
    correlationId: appointment.correlationId,
  });

  return {
    data: { deletedId: id },
    message: 'Agendamento deletado com sucesso',
  };
}

export default { execute };
