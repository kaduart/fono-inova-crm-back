// src/services/distributePayments.js
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

/**
 * Distribui um valor pago de um pacote entre as sessões do mesmo pacote.
 * Cria Payments por sessão, atualiza status financeiros e salva tudo dentro da transação.
 *
 * @param {String} packageId - ID do pacote
 * @param {Number} amount - Valor total recebido
 * @param {mongoose.ClientSession} mongoSession - sessão ativa do mongoose
 * @param {String|null} parentPaymentId - ID do pagamento principal (recibo do pacote)
 * @returns {Promise<Package>} - pacote atualizado
 */
export const distributePayments = async (packageId, amount, mongoSession, parentPaymentId = null) => {
  const pkg = await Package.findById(packageId)
    .populate('sessions')
    .session(mongoSession);

  const paymentMethod = pkg.paymentMethod || 'pix';

  if (!pkg) throw new Error('Pacote não encontrado.');

  const sessionValue = pkg.sessionValue;
  let remainingAmount = amount;
  let paidCount = 0;

  for (const s of pkg.sessions) {
    if (remainingAmount <= 0) break;

    const sessionDoc = await Session.findById(s._id).session(mongoSession);
    if (!sessionDoc) continue;

    if (sessionDoc.status === 'canceled' || sessionDoc.operationalStatus === 'cancelado') {
      continue; // não pagar sessões canceladas
    }

    const due = sessionValue - (sessionDoc.partialAmount || 0);
    const payNow = Math.min(remainingAmount, due);

    if (payNow > 0) {


      if (payNow > 0) {
        // 🔹 Criar pagamento individual vinculado à sessão
        const sessionPayment = new Payment({
          package: pkg._id,
          session: sessionDoc._id,
          patient: pkg.patient,
          doctor: pkg.doctor,
          amount: payNow,
          paymentMethod,
          status: 'paid',
          kind: 'session_payment',
          parentPayment: parentPaymentId || null
        });
        await sessionPayment.save({ session: mongoSession });
        pkg.payments.push(sessionPayment._id);

        // 🔹 Atualizar status financeiro da sessão
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

        if (sessionDoc.status === 'canceled' || sessionDoc.operationalStatus === 'cancelado') {
          sessionDoc.isPaid = false;
          sessionDoc.paymentStatus = 'canceled';
          sessionDoc.visualFlag = 'blocked';
          await sessionDoc.save({ session: mongoSession });
          continue;
        }

        remainingAmount -= payNow;
      }
    }
  }

  // 🔹 Atualizar resumo financeiro do pacote
  // Evita somar duplicado se já houver session_payment criado no mesmo ciclo
  const totalSessionPayments = await Payment.aggregate([
    { $match: { package: pkg._id, kind: 'session_payment' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
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
  // Popula antes de retornar (garante dados atualizados)
  const updated = await Package.findById(pkg._id)
    .populate('sessions payments')
    .session(mongoSession);

  return updated;

};
