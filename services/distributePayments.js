import Package from '../models/Package.js';
import Session from '../models/Session.js';
import { updateAppointmentFromSession } from '../utils/appointmentUpdater.js';

export const distributePayments = async (packageId, amount, mongoSession = null, parentPaymentId = null) => {
  const pkg = await Package.findById(packageId).session(mongoSession);
  if (!pkg) throw new Error('Pacote não encontrado.');

  const paymentMethod = pkg.paymentMethod || 'pix';
  const sessionValue = pkg.sessionValue || 0;
  let remainingAmount = amount;

  // ======================================================
  // 1️⃣ Buscar todas as sessões do pacote
  // ======================================================
  const sessions = await Session.find({ package: packageId })
    .sort({ date: 1 })
    .session(mongoSession);

  if (!sessions.length) {
    console.warn(`⚠️ Nenhuma sessão encontrada para o pacote ${packageId}`);
    return {
      totalPaid: 0,
      balance: Number(pkg.totalValue) || 0,
      totalValue: Number(pkg.totalValue) || 0,
      financialStatus: 'unpaid'
    };
  }

  // ======================================================
  // 2️⃣ Distribuir pagamento entre sessões
  // ======================================================
  for (const s of sessions) {
    if (remainingAmount <= 0) break;

    if (
      s.status === 'canceled' ||
      s.operationalStatus === 'canceled' ||
      s.paymentStatus === 'paid'
    ) continue;

    const due = sessionValue - (s.partialAmount || 0);
    const payNow = Math.min(remainingAmount, due);

    if (payNow > 0) {
      s.partialAmount = (s.partialAmount || 0) + payNow;

      if (s.partialAmount >= sessionValue) {
        s.isPaid = true;
        s.paidAt = s.paidAt || new Date();  // ⭐ Consistência de dados
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

      await updateAppointmentFromSession(s, mongoSession);

      remainingAmount -= payNow;
    }
  }

  // ======================================================
  // 3️⃣ Recalcular resumo financeiro com VALIDAÇÃO
  // ======================================================
  const allSessions = await Session.find({ package: packageId }).session(mongoSession);

  const totalPaid = allSessions.reduce((sum, s) => {
    const partial = Number(s.partialAmount) || 0;
    if (isNaN(partial)) {
      console.error(`⚠️ Session ${s._id} tem partialAmount inválido:`, s.partialAmount);
      return sum;
    }
    return sum + partial;
  }, 0);

  // 🛡️ VALIDAÇÃO CRÍTICA: Garantir totalValue numérico
  const safeTotalValue = Number(pkg.totalValue);
  const safeTotalPaid = Number(totalPaid);

  console.log('🔍 [distributePayments] Valores antes do cálculo:', {
    packageId,
    totalValue: pkg.totalValue,
    safeTotalValue,
    totalPaid,
    safeTotalPaid,
    isNaN_totalValue: isNaN(safeTotalValue),
    isNaN_totalPaid: isNaN(safeTotalPaid)
  });

  if (isNaN(safeTotalValue)) {
    console.error(`❌ pkg.totalValue é NaN! Pacote ${packageId}:`, pkg);
    throw new Error('totalValue do pacote está inválido (NaN)');
  }

  if (isNaN(safeTotalPaid)) {
    console.error(`❌ totalPaid é NaN! Pacote ${packageId}`);
    throw new Error('totalPaid calculado está inválido (NaN)');
  }

  const balance = Math.max(safeTotalValue - safeTotalPaid, 0);

  pkg.totalPaid = safeTotalPaid;
  pkg.balance = balance;
  pkg.paidSessions = allSessions.filter(s => s.paymentStatus === 'paid').length;

  if (balance <= 0) pkg.financialStatus = 'paid';
  else if (safeTotalPaid > 0 && safeTotalPaid < safeTotalValue) pkg.financialStatus = 'partially_paid';
  else pkg.financialStatus = 'unpaid';

  pkg.lastPaymentAt = new Date();
  await pkg.save({ session: mongoSession });

  console.log('✅ [distributePayments] Pacote atualizado:', {
    totalPaid: pkg.totalPaid,
    balance: pkg.balance,
    financialStatus: pkg.financialStatus
  });

  // ======================================================
  // 4️⃣ Atualizar visualFlags
  // ======================================================
  for (const s of allSessions) {
    let visualFlag = 'blocked';
    if (s.paymentStatus === 'paid') visualFlag = 'ok';
    else if (s.paymentStatus === 'partial') visualFlag = 'pending';
    await Session.updateOne({ _id: s._id }, { $set: { visualFlag } }, { session: mongoSession });
  }

  // ======================================================
  // 5️⃣ Retornar resumo
  // ======================================================
  return {
    totalPaid: safeTotalPaid,
    balance,
    totalValue: safeTotalValue,
    financialStatus: pkg.financialStatus,
  };
};