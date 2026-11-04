// domain/guide/releaseGuideConsumption.js
// Devolve à guia a sessão que uma Session de convênio consumiu.
// Mesma operação de revertSessionAndGuide (services/financialGuard/guards/convenio.guard.js):
// $inc -1 + $pull do consumptionHistory atômicos, com piso em 0, e reativa a guia
// 'exhausted' que voltou a ter saldo. Só age se a Session realmente consumiu
// (guideConsumed=true) — nunca devolve o que não foi debitado.
import InsuranceGuide from '../../models/InsuranceGuide.js';

export async function releaseGuideConsumption(sessionDoc, { mongoSession } = {}) {
  if (!sessionDoc?.guideConsumed || !sessionDoc.insuranceGuide) {
    return { released: false, reason: 'NOT_CONSUMED' };
  }

  const restored = await InsuranceGuide.findOneAndUpdate(
    { _id: sessionDoc.insuranceGuide, usedSessions: { $gt: 0 } },
    {
      $inc: { usedSessions: -1 },
      $pull: { consumptionHistory: { sessionId: sessionDoc._id } },
    },
    { session: mongoSession, new: true }
  );

  if (!restored) {
    return { released: false, reason: 'GUIDE_NOT_FOUND_OR_ZERO' };
  }

  if (restored.status === 'exhausted' && restored.usedSessions < restored.totalSessions) {
    await InsuranceGuide.findByIdAndUpdate(restored._id, { $set: { status: 'active' } }, { session: mongoSession });
  }

  return { released: true, guideId: restored._id, usedSessions: restored.usedSessions };
}
