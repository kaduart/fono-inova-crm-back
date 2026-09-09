import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { applyFinancialProtection } from '../appointment/policies/appointmentFinancialPolicy.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import PatientBalance from '../../models/PatientBalance.js';
import { transitionPaymentStatus } from '../paymentStatusService.js';

function settlementError(message, code = 'PACKAGE_SETTLEMENT_INVALID', meta) {
  return Object.assign(new Error(message), { statusCode: 400, code, meta });
}

// The caller owns the transaction. Used by creation and legacy settlement retries.
export async function incorporatePackagePayments(pkg, paymentIds, { mongoSession, paymentMethod, paymentDate, userId, requireCompleted = false } = {}) {
    const packageId = pkg._id;
    const patientId = pkg.patient?.toString?.() || pkg.patientId;

    // A retroativa pode ter sido quitada entre a criação e esta segunda chamada.
    // Nesse caso, incorporar o recebimento existente sem cobrar ou datar novamente.
    const Payment = mongoose.model('Payment');
    const payments = await Payment.find({
      _id: { $in: paymentIds },
      patient: patientId,
      status: { $in: ['pending', 'paid'] }
    }).session(mongoSession);

    if (payments.length !== new Set(paymentIds.map(String)).size) {
      throw settlementError('Um ou mais pagamentos selecionados não pertencem ao paciente ou não podem ser vinculados ao pacote');
    }

    if (payments.some(p => (p.package && String(p.package) !== String(pkg._id)) ||
        p.isFromPackage || p.kind === 'package_consumed' ||
        ['convenio', 'liminar'].includes(p.billingType) || !p.appointment || !p.session)) {
      throw settlementError('Selecione pagamentos de sessões avulsas sem vínculo com outro pacote');
    }
    const pendingPayments = payments.filter(p => p.status === 'pending');
    const totalToSettle = pendingPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const amountToIncorporate = payments.reduce((sum, p) =>
      sum + (p.status === 'paid' && String(p.package) === String(pkg._id) ? 0 : Number(p.amount || 0)), 0);
    if (Number(pkg.totalPaid || 0) + amountToIncorporate > Number(pkg.totalValue || 0) + 0.009) {
      throw settlementError('Os pagamentos selecionados ultrapassam o valor contratado do pacote');
    }
    const linkedAppointments = await Appointment.find({ _id: { $in: payments.map(p => p.appointment) } }).session(mongoSession);
    const SessionModel = mongoose.model('Session');
    const linkedSessions = await SessionModel.find({ _id: { $in: payments.map(p => p.session) } }).session(mongoSession);
    const hasInvalidLink = payments.some(p => {
      const appt = linkedAppointments.find(a => String(a._id) === String(p.appointment));
      const sess = linkedSessions.find(s => String(s._id) === String(p.session));
      return !appt || !sess || String(appt.patient) !== patientId || String(sess.patient) !== patientId ||
        (requireCompleted && (sess.status !== 'completed' || appt.operationalStatus !== 'completed')) ||
        ['convenio', 'liminar'].includes(appt.billingType) ||
        (appt.package && String(appt.package) !== String(pkg._id)) ||
        (sess.package && String(sess.package) !== String(pkg._id)) ||
        String(sess.appointmentId) !== String(appt._id);
    });
    if (hasInvalidLink) {
      throw settlementError('O vínculo entre pagamento, sessão e agendamento é inconsistente ou pertence a outro pacote');
    }
    if (new Set(payments.map(p => String(p.session))).size !== payments.length) {
      throw settlementError('Selecione somente um pagamento por sessão retroativa');
    }
    const effectiveDate = paymentDate
      ? moment.tz(String(paymentDate).split('T')[0], 'YYYY-MM-DD', true, 'America/Sao_Paulo')
      : null;
    if (effectiveDate && !effectiveDate.isValid()) throw settlementError('Data do pagamento retroativo inválida');
    const packageSessionIds = new Set([
      ...(pkg.sessions || []).map(String), ...payments.map(p => String(p.session))
    ]);
    if (packageSessionIds.size > pkg.totalSessions) {
      throw settlementError('As sessões selecionadas ultrapassam a quantidade contratada do pacote');
    }

    // 🛡️ FLOW GUARD: valida se cada payment permite quitação manual
    const { default: FinancialGuard } = await import('../financialGuard/index.js');
    try {
      if (pendingPayments.length > 0) await FinancialGuard.execute({
        context: 'SETTLE_PAYMENT',
        billingType: 'settle',
        payload: { paymentIds: pendingPayments.map(p => p._id), packageId },
        session: mongoSession
      });
    } catch (flowErr) {
      throw settlementError(flowErr.message, flowErr.code || "PAYMENT_FLOW_BLOCKED", flowErr.meta);
    }

    // Atualiza payments para vinculados ao pacote
    for (const payment of payments) {
      if (payment.status === 'paid') {
        await Payment.updateOne({ _id: payment._id }, { $set: { package: pkg._id } }, { session: mongoSession });
        continue;
      }
      payment.package = pkg._id;
      if (paymentMethod) payment.paymentMethod = paymentMethod;
      await payment.save({ session: mongoSession });

      // 🎯 STATUS TRANSITION: usa paymentStatusService
      await transitionPaymentStatus(payment._id, 'paid', {
        session: mongoSession,
        paymentMethod: paymentMethod || payment.paymentMethod,
        financialDate: effectiveDate?.toDate() || new Date(),
        paidAt: effectiveDate?.toDate() || new Date(),
        reason: 'package_settlement'
      });
    }

    // Atualiza PatientBalance (crédito de quitação)
    const patientBalance = await PatientBalance.findOne({ patient: patientId }).session(mongoSession);
    if (patientBalance && totalToSettle > 0) {
      patientBalance.transactions.push({
        type: 'credit',
        amount: totalToSettle,
        description: `Quitação via pacote #${pkg._id.toString().slice(-6)}`,
        specialty: pkg.sessionType,
        settledByPackageId: pkg._id,
        registeredBy: userId,
        transactionDate: new Date()
      });
      patientBalance.currentBalance -= totalToSettle;
      patientBalance.totalCredited += totalToSettle;
      patientBalance.lastTransactionAt = new Date();
      await patientBalance.save({ session: mongoSession });
    }

    // Atualiza appointments vinculados
    // 🔗 FIX: além do status financeiro, vincula appointment.package — sem isso a sessão
    // absorvida conta em Package.totalSessions/sessionsDone mas nenhuma query que resolva
    // "sessões deste pacote" via Appointment.package a encontra (mesma classe de gap
    // documentada em finance-integrity-audit/).
    const appointmentIds = payments
      .filter(p => p.appointment)
      .map(p => p.appointment.toString());

    if (appointmentIds.length > 0) {
      for (const appointment of linkedAppointments) {
        await Appointment.updateOne({ _id: appointment._id }, {
          $set: applyFinancialProtection(appointment, { paymentStatus: 'paid', isPaid: true, package: pkg._id })
        }, { session: mongoSession });
      }
    }

    // Atualiza sessions vinculadas (SINCRONIZAÇÃO CRÍTICA — antes faltava)
    // 🔗 FIX: idem — vincula session.package pelo mesmo motivo do appointment acima.
    const sessionIds = payments.filter(p => p.session).map(p => p.session.toString());
    if (sessionIds.length > 0) {
      const Session = mongoose.model('Session');
      await Session.updateMany(
        { _id: { $in: sessionIds } },
        { $set: { isPaid: true, paymentStatus: 'paid', package: pkg._id } },
        { session: mongoSession }
      );
    }

    // Recalcula saldo do pacote
    const totalPaid = Number(pkg.totalPaid || 0) + amountToIncorporate;
    const balance = (pkg.totalValue || 0) - totalPaid;
    let financialStatus = 'unpaid';
    if (balance <= 0 && totalPaid > 0) financialStatus = 'paid';
    else if (totalPaid > 0) financialStatus = 'partially_paid';
    const packageUpdate = {
      $set: { totalPaid, balance, financialStatus, updatedAt: new Date() }
    };
    const packageLinks = {};
    packageLinks.payments = { $each: payments.map(p => p._id) };
    // 🔗 FIX: registra as sessões/agendamentos absorvidos em Package.sessions[]/appointments[] —
    // sem isso, buildPackageView() e qualquer auditoria por Package.sessions nunca "veem"
    // a sessão retroativa que acabou de ser quitada aqui.
    if (sessionIds.length > 0) packageLinks.sessions = { $each: sessionIds };
    if (appointmentIds.length > 0) packageLinks.appointments = { $each: appointmentIds };
    if (Object.keys(packageLinks).length > 0) packageUpdate.$addToSet = packageLinks;

    await Package.findByIdAndUpdate(packageId, packageUpdate, { session: mongoSession });

    return { paymentsCount: payments.length, settledCount: pendingPayments.length, totalSettled: totalToSettle, newBalance: balance, totalPaid };
}
