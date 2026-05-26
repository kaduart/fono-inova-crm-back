// ✅ V2 ATIVO — completeSession/handlers/convenioHandler.js
// Handler de complete para billingType === 'convenio'
// REGRA V2: Payment já existe (pre-criado no schedule). Handler apenas ATUALIZA.
//
// REGRA DE NEGÓCIO:
//   - Paciente NÃO paga no dia (faturamento batch ~30 dias depois)
//   - financialDate = null → NÃO entra no caixa imediato
//   - Consome 1 sessão da InsuranceGuide (usedSessions++)
//   - Cria/atualiza Payment com insurance.status = 'pending_billing'

import InsuranceGuide from '../../../models/InsuranceGuide.js';
import Payment from '../../../models/Payment.js';
import LegacyFinanceWriteGuard from '../../financialGuard/LegacyFinanceWriteGuard.js';

export const ConvenioHandler = {
    /**
     * Fase 1 — campos de pagamento na Session.
     * Mutates sessionUpdate in-place (padrão do LegacyFinanceWriteGuard).
     *
     * @param {Object} sessionUpdate - objeto mutável que será $set na Session
     * @param {import('../shared/context.js').CompleteContext} ctx
     */
    buildSessionUpdate(sessionUpdate, ctx) {
        LegacyFinanceWriteGuard.setSessionPaid(sessionUpdate, false, { reason: 'convenio_complete' });
        LegacyFinanceWriteGuard.setSessionPaymentStatus(sessionUpdate, 'pending_receipt', { reason: 'convenio_complete' });
        sessionUpdate.paymentOrigin = 'convenio';
        sessionUpdate.paymentMethod = 'convenio';
    },

    /**
     * Fase 2 — consome guia + cria/atualiza Payment.
     * Mutates appointmentUpdate.$set.payment se Payment for criado (não encontrado).
     *
     * @param {Object} appointmentUpdate - objeto mutável do $set do Appointment
     * @param {import('../shared/context.js').CompleteContext} ctx
     * @returns {Promise<Object>} paymentCreated
     */
    async buildPayment(appointmentUpdate, ctx) {
        const { appointment, sessionId, sessionValue, mongoSession, userId, appointmentId } = ctx;
        const now = new Date();
        const insuranceValue = appointment.insuranceValue || sessionValue || 0;
        const specialty = appointment.specialty || 'fonoaudiologia';

        // 1. Buscar guia ativa
        // Filtro primário: appointment vinculado à guia correta evita consumir guia errada
        // quando paciente tem múltiplas guias ativas para mesma especialidade.
        const guideQuery = appointment.insuranceGuide
            ? {
                _id: appointment.insuranceGuide,
                status: 'active',
                expiresAt: { $gte: now },
                $expr: { $lt: ['$usedSessions', '$totalSessions'] }
            }
            : {
                patientId: appointment.patient?._id,
                specialty: specialty.toLowerCase().trim(),
                status: 'active',
                expiresAt: { $gte: now },
                $expr: { $lt: ['$usedSessions', '$totalSessions'] }
            };

        const guide = await InsuranceGuide.findOne(guideQuery)
            .session(mongoSession)
            .sort({ expiresAt: 1 });

        if (!guide) {
            throw new Error('NO_ACTIVE_GUIDE: Nenhuma guia ativa encontrada para este paciente/especialidade');
        }

        // 2. Consumir sessão da guia (dentro da transação)
        await guide.consumeSession(mongoSession);
        console.log(`[ConvenioHandler] 📋 Guia consumida: ${guide._id} (${guide.usedSessions}/${guide.totalSessions})`);

        // 3. Payment de produção — financialDate null = não entra no caixa imediato
        const paymentData = {
            patient:       appointment.patient?._id,
            amount:        insuranceValue,
            status:        'pending',
            type:          'service',
            serviceType:   'session',
            paymentMethod: 'convenio',
            paymentDate:   now,
            billingType:   'convenio',
            financialDate: null,
            insurance: {
                provider:          guide.insurance || appointment.insuranceProvider || 'Convênio',
                authorizationCode: appointment.authorizationCode || '',
                status:            'pending_billing',
                grossAmount:       insuranceValue,
                guideId:           guide._id
            },
            serviceDate:  appointment.date || now,
            description:  `Sessão convênio - ${guide.insurance || 'Convênio'} | Guia ${guide.number} | ${appointment.patient?.fullName || 'Paciente'}`,
            appointment:  appointmentId,
            session:      sessionId,
            createdBy:    userId,
            kind:         'session_payment'
        };

        let paymentCreated;

        if (appointment.payment) {
            // Payment pré-criado pelo generateInsurancePlanSessions — atualiza
            const existingPaymentId = appointment.payment._id || appointment.payment;
            paymentCreated = await Payment.findByIdAndUpdate(
                existingPaymentId,
                { $set: paymentData },
                { session: mongoSession, new: true }
            );
            console.log(`[ConvenioHandler] 💰 Payment atualizado: ${paymentCreated._id}`);
        } else {
            // Fallback: appointment sem payment pré-linkado (plano legado)
            const [paymentDoc] = await Payment.create([paymentData], { session: mongoSession });
            paymentCreated = paymentDoc;
            appointmentUpdate.$set.payment = paymentCreated._id;
            console.log(`[ConvenioHandler] 💰 Payment criado (produção): ${paymentCreated._id}`);
        }

        return paymentCreated;
    }
};
