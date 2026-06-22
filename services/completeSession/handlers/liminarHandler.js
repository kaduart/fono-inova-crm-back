// completeSession/handlers/liminarHandler.js
// Handler de complete para billingType === 'liminar'
//
// REGRA DE NEGÓCIO:
//   - Sessão coberta por crédito judicial (liminar)
//   - Paciente pagou antecipadamente (LiminarContract.receivedAt / createdAt)
//   - Sessão = consumo de crédito, NÃO nova entrada de caixa
//   - LiminarGuard debita o crédito do contrato
//   - NÃO é criado Payment: o caixa já foi reconhecido no recebimento do contrato

import LiminarGuard from '../../financialGuard/guards/liminar.guard.js';
import FinanceWriteGuard from '../../financialGuard/FinanceWriteGuard.js';

export const LiminarHandler = {
    /**
     * Fase 1 — campos de pagamento na Session.
     * Mutates sessionUpdate in-place.
     * Necessário para calculateProduction (usa session.paymentMethod/paymentOrigin).
     */
    buildSessionUpdate(sessionUpdate, ctx) {
        FinanceWriteGuard.setSessionPaid(sessionUpdate, true, { reason: 'liminar_complete' });
        FinanceWriteGuard.setSessionPaymentStatus(sessionUpdate, 'paid', { reason: 'liminar_complete' });
        sessionUpdate.paymentOrigin = 'liminar_credit';
        sessionUpdate.paymentMethod = 'liminar_credit';
        sessionUpdate.paidAt = new Date();
    },

    /**
     * Fase 2 — debita LiminarContract.
     * NÃO cria Payment: liminar é pré-paga, caixa foi reconhecido no contrato.
     */
    async buildPayment(appointmentUpdate, ctx) {
        const { appointment, appointmentId, sessionValue, mongoSession } = ctx;

        if (!sessionValue || sessionValue <= 0) return null;

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

        return null;
    }
};
