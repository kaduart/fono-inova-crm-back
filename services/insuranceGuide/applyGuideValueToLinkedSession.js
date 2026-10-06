/**
 * Ao vincular uma guia a uma sessão que já aconteceu SEM guia (sessão órfã), o valor da sessão
 * precisa passar a ser o da guia (tabela por especialidade + adicional ABA, já congelado em
 * `InsuranceGuide.sessionValue`).
 *
 * Invariantes (DOMAIN_INVARIANTS):
 *  #21 guia é a fonte oficial do valor        → lemos `guide.sessionValue`
 *  #22 Session.sessionValue espelha a guia    → atualizamos Session (e Appointment, que alimenta o handler)
 *  #23 Payment.amount pode divergir da guia   → só tocamos Payment AINDA PENDENTE e não faturado;
 *      (glosa, parcial, ajuste)                  pagamento faturado/recebido nunca é reescrito aqui.
 *
 * Não altera `Payment.status` (transições só via transitionPaymentStatus).
 */
import Session from '../../models/Session.js';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';

export async function applyGuideValueToLinkedSession({ session, guide, mongoSession }) {
  if (String(guide?.insurance ?? '').toLowerCase() !== 'base') return { applied: false, reason: 'NOT_BASE_CONVENIO' };
  const value = Number(guide?.sessionValue);
  if (!(value > 0)) return { applied: false, reason: 'GUIDE_WITHOUT_VALUE' };

  const opts = mongoSession ? { session: mongoSession } : {};

  await Session.updateOne({ _id: session._id }, { $set: { sessionValue: value } }, opts);

  const appointmentId = session.appointmentId?._id || session.appointmentId;
  if (appointmentId) {
    await Appointment.updateOne(
      { _id: appointmentId },
      { $set: { insuranceValue: value, sessionValue: value } },
      opts
    );
  }

  const payments = await Payment.updateMany(
    {
      session: session._id,
      billingType: 'convenio',
      status: 'pending',
      'insurance.status': { $in: ['pending', 'pending_billing', null] }
    },
    { $set: { amount: value, 'insurance.grossAmount': value } },
    opts
  );

  return { applied: true, value, paymentsUpdated: payments?.modifiedCount ?? 0 };
}

export default { applyGuideValueToLinkedSession };
