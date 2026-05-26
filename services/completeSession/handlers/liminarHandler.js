// completeSession/handlers/liminarHandler.js
// Handler de complete para billingType === 'liminar'
//
// REGRA DE NEGÓCIO:
//   - Sessão coberta por crédito judicial (liminar)
//   - Paciente NÃO paga — LiminarContract absorve o custo
//   - financialDate = now → ENTRA no caixa imediato (receita registrada)
//   - isPaid = true imediatamente
//   - LiminarGuard debita o crédito do contrato antes de criar Payment

import Payment from '../../../models/Payment.js';
import LiminarGuard from '../../financialGuard/guards/liminar.guard.js';
import LegacyFinanceWriteGuard from '../../financialGuard/LegacyFinanceWriteGuard.js';

export const LiminarHandler = {
    /**
     * Fase 1 — campos de pagamento na Session.
     * Mutates sessionUpdate in-place.
     *
     * @param {Object} sessionUpdate
     * @param {import('../shared/context.js').CompleteContext} ctx
     */
    buildSessionUpdate(sessionUpdate, ctx) {
        LegacyFinanceWriteGuard.setSessionPaid(sessionUpdate, true, { reason: 'liminar_complete' });
        LegacyFinanceWriteGuard.setSessionPaymentStatus(sessionUpdate, 'paid', { reason: 'liminar_complete' });
        sessionUpdate.paymentOrigin = 'liminar_credit';
        sessionUpdate.paymentMethod = 'liminar_credit';
        sessionUpdate.paidAt = new Date();
    },

    /**
     * Fase 2 — debita LiminarContract + cria Payment (entra no caixa).
     * Mutates appointmentUpdate.$set.payment com o _id criado.
     *
     * @param {Object} appointmentUpdate
     * @param {import('../shared/context.js').CompleteContext} ctx
     * @returns {Promise<Object>} paymentCreated
     */
    async buildPayment(appointmentUpdate, ctx) {
        const { appointment, appointmentId, sessionId, sessionValue, mongoSession, userId } = ctx;

        if (!sessionValue || sessionValue <= 0) return null;

        const now = new Date();
        const liminarContractId = appointment.liminarContract?._id || appointment.liminarContract;

        if (liminarContractId) {
            await LiminarGuard.handle({
                context: 'COMPLETE_SESSION',
                payload: {
                    liminarContractId: liminarContractId.toString(),
                    sessionValue,
                    appointmentId: appointmentId?.toString()
                },
                session: mongoSession
            });
        }
        // ✅ V2 ATIVO: LiminarHandler — liminar NÃO pre-cria Payment no schedule.
        // Portanto, aqui é o momento correto de criar. (Particular/Convenio atualizam existente.)
        const [paymentDoc] = await Payment.create([{
            patient:         appointment.patient?._id,
            amount:          sessionValue,
            status:          'paid',
            type:            'service',
            serviceType:     'session',
            paymentMethod:   'liminar_credit',
            paymentDate:     now,
            paidAt:          now,
            financialDate:   now,           // receita reconhecida no momento da realização
            isFromPackage:   false,
            description:     `Sessão liminar realizada - ${appointment.patient?.fullName || 'Paciente'}`,
            appointment:     appointmentId,
            session:         sessionId,
            liminarContract: liminarContractId || null,
            createdBy:       userId,
            kind:            'session_payment',
            billingType:     'liminar'
        }], { session: mongoSession });

        const paymentCreated = paymentDoc;
        appointmentUpdate.$set.payment = paymentCreated._id;
        console.log(`[LiminarHandler] 💰 Payment liminar criado: ${paymentCreated._id}`, { liminarContractId });

        return paymentCreated;
    }
};
