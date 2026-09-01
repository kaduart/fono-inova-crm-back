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
        // 🚨 FIX (2026-09-01, caso Davi Felipe/guia 2028 vs 3030): elegibilidade de
        // guia deve ser avaliada na DATA DO ATENDIMENTO, nunca na hora do clique em
        // "concluir". Um complete retroativo (appointment de semanas atrás, reaberto
        // e concluído hoje) usando `now` pode julgar expirada uma guia que estava
        // perfeitamente válida no dia do atendimento — e cair no fallback findValid(),
        // que despenca pra qualquer outra guia ativa da especialidade (ordenada por
        // vencimento mais próximo), inclusive uma sem nenhuma relação com este
        // atendimento (achado real: sessão de 03/08 consumiu por engano uma guia
        // criada em 09/01 pra um ciclo futuro começando em 14/09, só porque a guia
        // certa — emitida em 03/08 — vencia no dia exato do complete retroativo).
        const guideEvalDate = appointment.date ? new Date(appointment.date) : now;
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
                const lifecycle = await GuideLifecycleService.evaluate(candidate, guideEvalDate);
                if (lifecycle.eligibility.canBill) {
                    guide = candidate;
                }
            }
        }

        if (!guide) {
            guide = await InsuranceGuide.findValid(
                appointment.patient?._id?.toString?.() || appointment.patient,
                specialty,
                guideEvalDate
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
        // 🚨 FIX (2026-09-01, caso Davi Felipe/guia 2028 vs 3030): a flag
        // `guideConsumed` é do domínio "esta session já debitou ALGUMA guia",
        // não "já debitou ESTA guia". Quando a guia de uma sessão muda entre
        // duas completações (ex: guia antiga cancelada → resolvida outra guia
        // hoje), o check antigo (só `guideConsumed === true`) pulava o débito
        // pra sempre — mesmo numa guia nova que nunca tinha sido debitada,
        // deixando usedSessions/consumptionHistory permanentemente errados.
        const currentSessionState = await Session.findById(sessionId)
            .select('guideConsumed insuranceGuide')
            .session(mongoSession)
            .lean();
        const alreadyConsumed = currentSessionState?.guideConsumed === true
            && String(currentSessionState.insuranceGuide) === String(guide._id);

        if (!alreadyConsumed) {
            await guide.consumeSession(mongoSession, {
                sessionId:      sessionId,
                professionalId: appointment.doctor?._id || appointment.doctor || null,
                asOfDate:       guideEvalDate,
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
