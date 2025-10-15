import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { updateAppointmentFromSession } from '../utils/appointmentUpdater.js';

/**
 * Distribui o valor pago de um pacote entre as sessões correspondentes,
 * gerando os pagamentos individuais e atualizando status financeiros e visuais.
 *
 * @param {String} packageId - ID do pacote
 * @param {Number} amount - Valor recebido
 * @param {mongoose.ClientSession} mongoSession - sessão do mongoose
 * @param {String|null} parentPaymentId - ID do pagamento principal (recibo)
 * @returns {Promise<Package>} - Pacote atualizado
 */
export const distributePayments = async (packageId, amount, mongoSession, parentPaymentId = null) => {
  const pkg = await Package.findById(packageId)
    .populate('sessions')
    .session(mongoSession);

  if (!pkg) throw new Error('Pacote não encontrado.');

  const paymentMethod = pkg.paymentMethod || 'pix';
  const sessionValue = pkg.sessionValue;
  let remainingAmount = amount;
  let paidCount = 0;

  // 🔹 Distribui o valor entre as sessões ativas
  for (const s of pkg.sessions) {
    if (remainingAmount <= 0) break;

    const sessionDoc = await Session.findById(s._id).session(mongoSession);
    if (!sessionDoc) continue;

    // Ignorar canceladas
    if (sessionDoc.status === 'canceled' || sessionDoc.operationalStatus === 'cancelado') continue;

    const due = sessionValue - (sessionDoc.partialAmount || 0);
    const payNow = Math.min(remainingAmount, due);

    if (payNow > 0) {
      // 🔹 Cria o pagamento individual vinculado à sessão
      const sessionPayment = new Payment({
        package: pkg._id,
        session: sessionDoc._id,
        patient: pkg.patient,
        doctor: pkg.doctor,
        amount: payNow,
        paymentMethod,
        status: 'paid',
        kind: 'session_payment',
        parentPayment: parentPaymentId || null,
      });
      await sessionPayment.save({ session: mongoSession });
      pkg.payments.push(sessionPayment._id);

      // 🔹 Atualiza status financeiro da sessão
      sessionDoc.partialAmount = (sessionDoc.partialAmount || 0) + payNow;
      if (sessionDoc.partialAmount >= sessionValue) {
        sessionDoc.isPaid = true;
        sessionDoc.paymentStatus = 'paid';
        sessionDoc.visualFlag = 'ok';
        paidCount++;
      } else if (sessionDoc.partialAmount > 0) {
        sessionDoc.isPaid = false;
        sessionDoc.paymentStatus = 'partial';
        sessionDoc.visualFlag = 'pending';
      } else {
        sessionDoc.isPaid = false;
        sessionDoc.paymentStatus = 'pending';
        sessionDoc.visualFlag = 'blocked';
      }

      await sessionDoc.save({ session: mongoSession });
      await updateAppointmentFromSession(sessionDoc, mongoSession);

      // 🔹 Sincroniza o Appointment vinculado (mantém a agenda coerente)
      /*  const linkedAppointment = await Appointment.findOne({ session: sessionDoc._id }).session(mongoSession);
       if (linkedAppointment) {
         linkedAppointment.paymentStatus = sessionDoc.paymentStatus;
         linkedAppointment.visualFlag = sessionDoc.visualFlag;
         await linkedAppointment.save({ session: mongoSession });
       } */

      remainingAmount -= payNow;
    }
  }

  // 🔹 Recalcula o resumo financeiro do pacote
  const totalSessionPayments = await Payment.aggregate([
    { $match: { package: pkg._id, kind: 'session_payment' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]).session(mongoSession);

  const totalPaid = totalSessionPayments.length > 0 ? totalSessionPayments[0].total : 0;
  const expectedTotal = pkg.totalSessions * sessionValue;
  const balance = expectedTotal - totalPaid;

  pkg.totalPaid = totalPaid;
  pkg.balance = balance;
  pkg.paidSessions = paidCount;

  pkg.financialStatus =
    balance <= 0 ? 'paid' :
      totalPaid > 0 ? 'partially_paid' :
        'unpaid';

  pkg.lastPaymentAt = new Date();
  await pkg.save({ session: mongoSession });

  // 🔹 Ajusta as visualFlags de sessões não pagas, para consistência
  const unpaidSessions = pkg.sessions.filter(s => !s.isPaid);
  for (const s of unpaidSessions) {
    const sessionDoc = await Session.findById(s._id).session(mongoSession);
    if (!sessionDoc) continue;

    const sessionValue = pkg.sessionValue;
    const partial = sessionDoc.partialAmount || 0;

    if (partial >= sessionValue) {
      sessionDoc.visualFlag = 'ok';
    } else if (partial > 0) {
      sessionDoc.visualFlag = 'pending';
    } else {
      sessionDoc.visualFlag = 'blocked';
    }

    await sessionDoc.save({ session: mongoSession });
  }

  // 🔹 Retorna pacote populado
  const updated = await Package.findById(pkg._id)
    .populate('sessions payments')
    .session(mongoSession);

  return updated;
};
