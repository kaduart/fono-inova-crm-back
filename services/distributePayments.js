import Package from '../models/Package.js';
import Session from '../models/Session.js';
import { updateAppointmentFromSession } from '../utils/appointmentUpdater.js';

/**
 * Distribui o valor pago de um pacote entre as sessões correspondentes,
 * atualizando os status financeiros e visuais sem duplicar pagamentos.
 *
 * - Mantém compatibilidade total com a versão anterior (que funcionava)
 * - Ordena as sessões por data para distribuir corretamente
 * - Atualiza pacote, sessões e appointments com base no valor pago
 *
 * @param {String} packageId - ID do pacote
 * @param {Number} amount - Valor recebido
 * @param {mongoose.ClientSession|null} mongoSession - Sessão opcional
 * @param {String|null} parentPaymentId - ID do pagamento principal (recibo)
 * @returns {Promise<{ totalPaid: number, balance: number, totalValue: number, financialStatus: string }>}
 */
export const distributePayments = async (packageId, amount, mongoSession = null, parentPaymentId = null) => {
  const pkg = await Package.findById(packageId).session(mongoSession);
  if (!pkg) throw new Error('Pacote não encontrado.');

  const paymentMethod = pkg.paymentMethod || 'pix';
  const sessionValue = pkg.sessionValue;
  let remainingAmount = amount;

  // ======================================================
  // 1️⃣ Buscar todas as sessões do pacote em ordem cronológica
  // ======================================================
  const sessions = await Session.find({ package: packageId })
    .sort({ date: 1 })
    .session(mongoSession);

  if (!sessions.length) {
    console.warn(`⚠️ Nenhuma sessão encontrada para o pacote ${packageId}`);
    return;
  }

  // ======================================================
  // 2️⃣ Distribuir o pagamento entre as sessões
  // ======================================================
  for (const s of sessions) {
    if (remainingAmount <= 0) break;

    // Ignora sessões canceladas ou já pagas
    if (
      s.status === 'canceled' ||
      s.operationalStatus === 'canceled' ||
      s.paymentStatus === 'paid'
    ) continue;

    const due = sessionValue - (s.partialAmount || 0);
    const payNow = Math.min(remainingAmount, due);

    if (payNow > 0) {
      s.partialAmount = (s.partialAmount || 0) + payNow;

      // Define status conforme o novo saldo
      if (s.partialAmount >= sessionValue) {
        s.isPaid = true;
        s.paymentStatus = 'paid';
        s.visualFlag = 'ok';
      } else if (s.partialAmount > 0) {
        s.isPaid = false;
        s.paymentStatus = 'partial';
        s.visualFlag = 'pending';
      } else {
        s.isPaid = false;
        s.paymentStatus = 'pending';
        s.visualFlag = 'blocked';
      }

      s.parentPayment = parentPaymentId || null;
      s.paymentMethod = paymentMethod;
      await s.save({ session: mongoSession });

      // 🔄 Mantém sincronizado com Appointment
      await updateAppointmentFromSession(s, mongoSession);

      remainingAmount -= payNow;
    }
  }

  // ======================================================
  // 3️⃣ Recalcular resumo financeiro do pacote
  // ======================================================
  const allSessions = await Session.find({ package: packageId }).session(mongoSession);

  const totalPaid = allSessions.reduce((sum, s) => sum + (s.partialAmount || 0), 0);
  const expectedTotal = pkg.totalSessions * sessionValue;
  const balance = Math.max(expectedTotal - totalPaid, 0);

  pkg.totalPaid = totalPaid;
  pkg.balance = balance;
  pkg.paidSessions = allSessions.filter(s => s.paymentStatus === 'paid').length;

  if (balance <= 0) pkg.financialStatus = 'paid';
  else if (totalPaid > 0 && totalPaid < expectedTotal) pkg.financialStatus = 'partially_paid';
  else pkg.financialStatus = 'unpaid';

  pkg.lastPaymentAt = new Date();
  await pkg.save({ session: mongoSession });

  // ======================================================
  // 4️⃣ Atualizar visualFlags finais (garantia de consistência)
  // ======================================================
  for (const s of allSessions) {
    let visualFlag = 'blocked';
    if (s.paymentStatus === 'paid') visualFlag = 'ok';
    else if (s.paymentStatus === 'partial') visualFlag = 'pending';
    await Session.updateOne({ _id: s._id }, { $set: { visualFlag } }, { session: mongoSession });
  }

  // ======================================================
  // 5️⃣ Retornar resumo coerente
  // ======================================================
  return {
    totalPaid,
    balance,
    totalValue: expectedTotal,
    financialStatus: pkg.financialStatus,
  };
};
