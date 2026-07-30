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
import Session from '../../../models/Session.js';
import FinanceWriteGuard from '../../financialGuard/FinanceWriteGuard.js';
import { GuideLifecycleService } from '../../../services/guideLifecycle/GuideLifecycleService.js';
import { insurancePaymentCreationService } from '../../../domains/billing/services/InsurancePaymentCreationService.js';

export const ConvenioHandler = {
    /**
     * Fase 1 — campos de pagamento na Session.
     * Mutates sessionUpdate in-place (padrão do FinanceWriteGuard).
     *
     * @param {Object} sessionUpdate - objeto mutável que será $set na Session
     * @param {import('../shared/context.js').CompleteContext} ctx
     */
    buildSessionUpdate(sessionUpdate, ctx) {
        FinanceWriteGuard.setSessionPaid(sessionUpdate, false, { reason: 'convenio_complete' });
        FinanceWriteGuard.setSessionPaymentStatus(sessionUpdate, 'pending_receipt', { reason: 'convenio_complete' });
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
        const insuranceValue = appointment.insuranceValue || sessionValue || ctx.sessionDoc?.sessionValue || 0;
        if (insuranceValue <= 0) {
            throw new Error('INVALID_INSURANCE_VALUE: nenhuma fonte de valor encontrada (appointment.insuranceValue, sessionValue, session.sessionValue)');
        }
        const specialty = appointment.specialty || 'fonoaudiologia';

        // 🩹 DEFENSIVO: sessionId é obrigatório para convenio
        if (!sessionId) {
            console.error('[ConvenioHandler] ❌ sessionId ausente no contexto', {
                appointmentId: appointmentId?.toString?.(),
                appointmentSession: appointment.session?._id?.toString?.() || appointment.session?.toString?.(),
                sessionDocId: ctx.sessionDoc?._id?.toString?.()
            });
            throw new Error('INVALID_SESSION_ID: sessionId é obrigatório para criar/atualizar payment de convênio');
        }

        // 1. Buscar guia elegível
        // Filtro primário: appointment vinculado à guia correta evita consumir guia errada
        // quando paciente tem múltiplas guias ativas para mesma especialidade.
        let guide = null;
        if (appointment.insuranceGuide) {
            const candidate = await InsuranceGuide.findById(appointment.insuranceGuide).session(mongoSession);
            if (candidate) {
                const lifecycle = await GuideLifecycleService.evaluate(candidate, now);
                if (lifecycle.eligibility.canBill) {
                    guide = candidate;
                }
            }
        }

        if (!guide) {
            guide = await InsuranceGuide.findValid(
                appointment.patient?._id?.toString?.() || appointment.patient,
                specialty,
                now
            );
        }

        if (!guide) {
            const err = new Error('NO_ACTIVE_GUIDE: Nenhuma guia ativa encontrada para este paciente/especialidade');
            err.code = 'NO_ACTIVE_GUIDE';
            err.statusCode = 422;
            throw err;
        }

        // Sincroniza Appointment.insuranceGuide com a guia efetivamente usada.
        // Sem isso, quando o fallback findValid() resolve uma guia diferente da
        // salva no appointment, só Session/Payment ficam com a guia certa e o
        // Appointment continua apontando pra guia antiga (Trinca quebrada).
        appointmentUpdate.$set.insuranceGuide = guide._id;

        // 2. Consumir sessão da guia (dentro da transação)
        // Idempotência anti-double-debit: verifica estado atual da session no banco
        // antes de debitar — protege contra retry e complete duplicado.
        const currentSessionState = await Session.findById(sessionId)
            .select('guideConsumed insuranceGuide')
            .session(mongoSession)
            .lean();
        const alreadyConsumed = currentSessionState?.guideConsumed === true;

        if (!alreadyConsumed) {
            await guide.consumeSession(mongoSession, {
                sessionId:      sessionId,
                professionalId: appointment.doctor?._id || appointment.doctor || null,
            });
            console.log(`[ConvenioHandler] 📋 Guia consumida: ${guide._id} (${guide.usedSessions}/${guide.totalSessions})`);
        } else {
            console.warn(`[ConvenioHandler] ⚡ Idempotência: session ${sessionId} já consumiu guia — pulando consumeSession()`);
        }

        // 3. Vincular guia à Session — causa raiz de sessões órfãs no billing
        await Session.findByIdAndUpdate(
            sessionId,
            { $set: { insuranceGuide: guide._id, guideConsumed: true } },
            { session: mongoSession }
        );
        console.log(`[ConvenioHandler] 📋 Session ${sessionId} vinculada à guia ${guide._id}`);

        // 4. Payment de produção — financialDate null = não entra no caixa imediato
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

        // 🔍 Log de diagnóstico: dados que serão persistidos
        console.log('[ConvenioHandler] 🔍 paymentData preparado', {
            sessionId: sessionId?.toString?.(),
            appointmentId: appointmentId?.toString?.(),
            existingPaymentId: appointment.payment?._id?.toString?.() || appointment.payment?.toString?.(),
            paymentDataSession: paymentData.session?.toString?.(),
            paymentDataKeys: Object.keys(paymentData)
        });

        // 🛡️ PR-A: Idempotência centralizada — 1 Payment ativo de convênio por Session.
        // O serviço cuida de: session (canônico), appointment.payment (fallback),
        // orphan (fallback) e race condition (11000). Nunca ressuscita cancelados.
        const { payment: paymentCreated, created: paymentWasCreated } = await insurancePaymentCreationService.findOrCreateConvenioPayment({
            sessionId,
            appointmentId,
            appointmentPaymentId: appointment.payment?._id || appointment.payment,
            patientId: appointment.patient?._id,
            paymentData,
            mongoSession
        });

        // Garante que Appointment.payment aponte para o Payment realmente ativo
        if (String(appointmentUpdate.$set.payment || appointment.payment) !== String(paymentCreated._id)) {
            appointmentUpdate.$set.payment = paymentCreated._id;
        }

        console.log(`[ConvenioHandler] 💰 Payment ${paymentWasCreated ? 'criado' : 'atualizado'}: ${paymentCreated._id}`, {
            session: paymentCreated.session?.toString?.(),
            status: paymentCreated.status,
            kind: paymentCreated.kind
        });

        return paymentCreated;
    }
};
