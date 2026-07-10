// back/services/billing/commands/deletePackageCommand.js
/**
 * Delete Package Command
 *
 * Responsabilidade: deletar um pacote, seus relacionados (appointments, sessions, payments)
 * e ajustar o PatientBalance do paciente.
 *
 * 🔒 Regras:
 * - Reverte transações de crédito/débito do PatientBalance associadas ao pacote.
 * - Deleta appointments, sessions e payments vinculados ao pacote.
 * - Emite PACKAGE_DELETED no Outbox para atualização das projeções.
 */

import mongoose from 'mongoose';
import Package from '../../../models/Package.js';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import Payment from '../../../models/Payment.js';
import PatientBalance from '../../../models/PatientBalance.js';
import PackagesView from '../../../models/PackagesView.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';
import { EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { buildError } from '../../appointment/commands/_helpers.js';

export async function execute(packageId, user, mongoSession = null) {
  return await runTransactionWithRetry(async (session) => {
    const pkgObjectId = new mongoose.Types.ObjectId(packageId);

    // Resolve o packageId real se o ID passado for de uma view
    const view = await PackagesView.findById(pkgObjectId).session(session).lean();
    const realPackageId = view?.packageId
      ? new mongoose.Types.ObjectId(view.packageId)
      : pkgObjectId;

    const pkgResult = await Package.findById(realPackageId).session(session);

    if (!pkgResult) {
      throw buildError('Pacote não encontrado', 404, 'PACKAGE_NOT_FOUND');
    }

    // Coleta IDs de relacionados para ajuste do PatientBalance
    const appointmentIds = (await Appointment.find({ package: realPackageId })
      .select('_id')
      .session(session)
      .lean()).map(a => a._id.toString());
    const sessionIds = (await Session.find({ package: realPackageId })
      .select('_id')
      .session(session)
      .lean()).map(s => s._id.toString());

    // 🏦 REVERTE transações do PatientBalance associadas ao pacote
    const patientBalance = await PatientBalance.findOne({ patient: pkgResult.patient }).session(session);
    if (patientBalance) {
      const packageIdStr = realPackageId.toString();
      let balanceChanged = false;

      for (const tx of patientBalance.transactions) {
        const txPackageId = tx.settledByPackageId?.toString?.();
        const txAppointmentId = tx.appointmentId?.toString?.();
        const txSessionId = tx.sessionId?.toString?.();

        const belongsToPackage = txPackageId === packageIdStr;
        const belongsToRelated = appointmentIds.includes(txAppointmentId) || sessionIds.includes(txSessionId);

        if (!belongsToPackage && !belongsToRelated) continue;
        if (tx.isDeleted) continue;

        if (tx.type === 'credit') {
          patientBalance.currentBalance += tx.amount;
          patientBalance.totalCredited = Math.max(0, (patientBalance.totalCredited || 0) - tx.amount);
          tx.isDeleted = true;
          tx.deletedAt = new Date();
          tx.deleteReason = `Pacote ${packageIdStr} deletado`;
          balanceChanged = true;
        } else if (tx.type === 'debit' && tx.isPaid) {
          tx.isPaid = false;
          tx.paidAmount = 0;
          tx.settledByPackageId = null;
          patientBalance.currentBalance += tx.amount;
          balanceChanged = true;
        } else if (tx.type === 'debit' && !tx.isPaid) {
          tx.isDeleted = true;
          tx.deletedAt = new Date();
          tx.deleteReason = `Pacote ${packageIdStr} deletado`;
          patientBalance.currentBalance = Math.max(0, patientBalance.currentBalance - tx.amount);
          patientBalance.totalDebited = Math.max(0, (patientBalance.totalDebited || 0) - tx.amount);
          balanceChanged = true;
        }
      }

      if (balanceChanged) {
        patientBalance.lastTransactionAt = new Date();
        await patientBalance.save({ session });
      }
    }

    // Deleta relacionados
    await Appointment.deleteMany({ package: realPackageId }).session(session);
    await Session.deleteMany({ package: realPackageId }).session(session);
    await Payment.deleteMany({ package: realPackageId }).session(session);
    await Package.deleteOne({ _id: realPackageId }).session(session);

    // Remove a view pelo _id real da view (se encontrada) e pelo packageId (garantia)
    if (view) {
      await PackagesView.findByIdAndDelete(view._id).session(session);
    }
    await PackagesView.findOneAndDelete({ packageId: realPackageId }).session(session);

    // Registra evento de domínio no Outbox
    await saveToOutbox({
      eventType: EventTypes.PACKAGE_DELETED,
      aggregateType: 'package',
      aggregateId: realPackageId.toString(),
      payload: {
        packageId: realPackageId.toString(),
        patientId: pkgResult.patient?.toString() || null,
        appointmentIds,
        sessionIds,
      },
      correlationId: `pkg_del_${realPackageId}_${Date.now()}`
    }, session);

    return {
      data: {
        packageId: realPackageId.toString(),
        deleted: true,
        patientBalanceAdjusted: !!patientBalance,
      },
      message: 'Pacote deletado com sucesso'
    };
  }, mongoSession);
}

export default { execute };
