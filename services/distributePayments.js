import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { updateAppointmentFromSession } from '../utils/appointmentUpdater.js';

/**
 * Distribui o valor pago de um pacote entre as sessões correspondentes,
 * atualizando os status financeiros e visuais, sem criar pagamentos duplicados.
 *
 * @param {String} packageId - ID do pacote
 * @param {Number} amount - Valor recebido
 * @param {mongoose.ClientSession} mongoSession - Sessão do mongoose
 * @param {String|null} parentPaymentId - ID do pagamento principal (recibo)
 * @returns {Promise<{ totalPaid: number, balance: number, totalValue: number, financialStatus: string }>}
 */
export const distributePayments = async (packageId, amount, mongoSession, parentPaymentId = null) => {
  const pkg = await Package.findById(packageId)
    .populate('sessions')
    .session(mongoSession);

  if (!pkg) throw new Error('Pacote não encontrado.');

  const paymentMethod = pkg.paymentMethod || 'pix';
  const sessionValue = pkg.sessionValue;
  let remainingAmount = amount;

  // 🔹 Distribui o valor entre as sessões ativas e não pagas
  for (const s of pkg.sessions) {
    if (remainingAmount <= 0) break;

    const sessionDoc = await Session.findById(s._id).session(mongoSession);
    if (!sessionDoc) continue;

    // Ignora canceladas ou já totalmente pagas
    if (
      sessionDoc.status === 'canceled' ||
      sessionDoc.operationalStatus === 'canceled' ||
      sessionDoc.paymentStatus === 'paid'
    )
      continue;

    const due = sessionValue - (sessionDoc.partialAmount || 0);
    const payNow = Math.min(remainingAmount, due);

    if (payNow > 0) {
      sessionDoc.partialAmount = (sessionDoc.partialAmount || 0) + payNow;

      // 🔹 Atualiza status financeiro da sessão
      if (sessionDoc.partialAmount >= sessionValue) {
        sessionDoc.isPaid = true;
        sessionDoc.paymentStatus = 'paid';
        sessionDoc.visualFlag = 'ok';
      } else if (sessionDoc.partialAmount > 0) {
        sessionDoc.isPaid = false;
        sessionDoc.paymentStatus = 'partial';
        sessionDoc.visualFlag = 'pending';
      } else {
        sessionDoc.isPaid = false;
        sessionDoc.paymentStatus = 'pending';
        sessionDoc.visualFlag = 'blocked';
      }

      // Vincula ao pagamento principal (para histórico, não novo pagamento)
      sessionDoc.parentPayment = parentPaymentId || null;
      await sessionDoc.save({ session: mongoSession });
      await updateAppointmentFromSession(sessionDoc, mongoSession);

      remainingAmount -= payNow;
    }
  }

  // 🔹 Recalcula o resumo financeiro do pacote com base nas sessões
  const sessionDocs = await Session.find({ _id: { $in: pkg.sessions } }).session(mongoSession);

  const totalPaid = sessionDocs.reduce((sum, s) => sum + (s.partialAmount || 0), 0);
  const expectedTotal = pkg.totalSessions * sessionValue;
  const balance = Math.max(expectedTotal - totalPaid, 0);

  pkg.totalPaid = totalPaid;
  pkg.balance = balance;
  pkg.paidSessions = sessionDocs.filter(s => s.paymentStatus === 'paid').length;

  // 🔹 Define o status financeiro conforme o progresso real
  if (balance <= 0) pkg.financialStatus = 'paid';
  else if (totalPaid > 0 && totalPaid < expectedTotal) pkg.financialStatus = 'partially_paid';
  else pkg.financialStatus = 'unpaid';

  pkg.lastPaymentAt = new Date();
  await pkg.save({ session: mongoSession });

  // 🔹 Atualiza visualFlags das sessões
  for (const s of sessionDocs) {
    if (s.isPaid) s.visualFlag = 'ok';
    else if (s.paymentStatus === 'partial') s.visualFlag = 'pending';
    else s.visualFlag = 'blocked';
    await s.save({ session: mongoSession });
  }

  // 🔹 Retorna resumo financeiro coerente
  return {
    totalPaid,
    balance,
    totalValue: expectedTotal,
    financialStatus: pkg.financialStatus,
  };
};
