// ✅ V2 ATIVO — completeSession/handlers/particularHandler.js
// Handler de complete para billingType === 'particular' (prepaid, per-session, avulso, fiado)
// REGRA V2: Payment já existe (pre-criado no schedule). Handler apenas ATUALIZA.
//
// REGRA DE NEGOCIO:
//   - Session.isPaid = false por padrao (Payment e fonte de verdade)
//   - Prepaid e excecao: Session reflete que ja foi pago no pacote
//   - Quatro sub-casos no payment:
//     1. Prepaid coberto    -> Payment NAO criado (caixa ja entrou na compra)
//     2. Fiado              -> Payment pending (divida do paciente)
//     3. Pago no ato        -> Payment paid (entra no caixa)
//     4. Per-session        -> Payment paid + atualiza Package

import Payment from '../../../models/Payment.js';
import Package from '../../../models/Package.js';
import LegacyFinanceWriteGuard from '../../financialGuard/LegacyFinanceWriteGuard.js';

export const ParticularHandler = {
    /**
     * Fase 1 — campos de pagamento na Session.
     */
    buildSessionUpdate(sessionUpdate, ctx) {
        const { appointment, packageData, isBalanceOrigin } = ctx;

        // Detecta se e pacote prepaid (full / pre-pago)
        const isPrepaid = packageData?.model === 'prepaid' || packageData?.paymentType === 'full';

        if (isPrepaid) {
            LegacyFinanceWriteGuard.setSessionPaid(sessionUpdate, true, { reason: 'package_prepaid_complete' });
            LegacyFinanceWriteGuard.setSessionPaymentStatus(sessionUpdate, 'package_paid', { reason: 'package_prepaid_complete' });
            sessionUpdate.paymentOrigin = 'package_prepaid';
            sessionUpdate.paymentMethod = 'package_prepaid';
            sessionUpdate.paidAt = new Date();
        } else if (isBalanceOrigin) {
            // Fiado / addToBalance
            LegacyFinanceWriteGuard.setSessionPaid(sessionUpdate, false, { reason: 'per_session_complete' });
            LegacyFinanceWriteGuard.setSessionPaymentStatus(sessionUpdate, 'unpaid', { reason: 'per_session_complete' });
            sessionUpdate.paymentOrigin = 'manual_balance';
            sessionUpdate.paymentMethod = appointment.paymentMethod || packageData?.paymentMethod || 'pix';
        } else {
            // Pago no ato (avulso ou per-session)
            LegacyFinanceWriteGuard.setSessionPaid(sessionUpdate, true, { reason: 'per_session_paid_now' });
            LegacyFinanceWriteGuard.setSessionPaymentStatus(sessionUpdate, 'paid', { reason: 'per_session_paid_now' });
            sessionUpdate.paymentOrigin = 'auto_per_session';
            sessionUpdate.paymentMethod = appointment.paymentMethod || packageData?.paymentMethod || 'pix';
            sessionUpdate.paidAt = new Date();
        }
    },

    /**
     * Fase 2 — cria/atualiza Payment e ajusta Package.
     */
    async buildPayment(appointmentUpdate, ctx) {
        const { appointment, appointmentId, sessionId, sessionValue, packageId, mongoSession, userId, isBalanceOrigin, sessionDoc } = ctx;

        // Incrementa sessionsDone apenas se sessao NAO estava completed antes
        // (protecao contra retry/idempotencia)
        let pkgAtual = null;
        if (packageId && sessionDoc?.status !== 'completed') {
            await Package.findByIdAndUpdate(
                packageId,
                { $inc: { sessionsDone: 1 } },
                { session: mongoSession }
            );

            // 🔥 RECALCULA BALANCE para pacotes prepaid/full
            pkgAtual = await Package.findById(packageId).session(mongoSession).lean();
            if (pkgAtual && (pkgAtual.model === 'prepaid' || pkgAtual.paymentType === 'full')) {
                const sessionsDone = pkgAtual.sessionsDone || 0;
                const usedValue = sessionsDone * sessionValue;
                const remainingCredit = (pkgAtual.totalValue || 0) - usedValue;
                const newBalance = remainingCredit;
                const newFinancialStatus = newBalance > 0.001 ? 'paid_with_credit' : 'paid';

                await Package.findByIdAndUpdate(
                    packageId,
                    {
                        $set: {
                            balance: newBalance,
                            financialStatus: newFinancialStatus,
                            updatedAt: new Date()
                        }
                    },
                    { session: mongoSession }
                );
                console.log(`[ParticularHandler] [PREPAID] Package recalculado: sessionsDone=${sessionsDone}, balance=${newBalance}, status=${newFinancialStatus}`);
            }
        }

        if (!sessionValue || sessionValue <= 0) return null;

        const now = new Date();

        // Sub-caso 1: pacote pre-pago quitado
        // ⚠️ Só aplica a pacotes prepaid (model='prepaid' ou paymentType='full')
        if (packageId) {
            if (!pkgAtual) {
                pkgAtual = await Package.findById(packageId).session(mongoSession).lean();
            }
            if (pkgAtual && (pkgAtual.model === 'prepaid' || pkgAtual.paymentType === 'full')) {
                const sessionsDone = pkgAtual.sessionsDone || 0;
                const totalPaid    = pkgAtual.totalPaid || 0;
                const isPrepaidCovered = totalPaid >= sessionsDone * sessionValue;

                if (isPrepaidCovered) {
                    console.log(`[ParticularHandler] [PREPAID] Sessao coberta por pagamento antecipado — Payment nao criado`);
                    return null;
                }
            }
        }

        // Sub-caso 2: fiado / addToBalance
        if (isBalanceOrigin) {
            const [paymentDoc] = await Payment.create([{
                patient:       appointment.patient?._id,
                amount:        sessionValue,
                status:        'pending',
                type:          'service',
                serviceType:   'session',
                paymentMethod: appointment.paymentMethod || 'cash',
                paymentDate:   now,
                financialDate: null,
                description:   `Sessao particular fiada - ${appointment.patient?.fullName || 'Paciente'}`,
                appointment:   appointmentId,
                session:       sessionId,
                createdBy:     userId,
                kind:          'session_payment',
                billingType:   'particular'
            }], { session: mongoSession });
            appointmentUpdate.$set.payment = paymentDoc._id;
            console.log(`[ParticularHandler] [FIADO] Payment pending criado (addToBalance): ${paymentDoc._id}`);

            return paymentDoc;
        }

        // Sub-caso 3: pago no ato
        let paymentCreated;

        if (appointment.payment) {
            const existingPaymentId = appointment.payment._id || appointment.payment;
            paymentCreated = await Payment.findByIdAndUpdate(
                existingPaymentId,
                {
                    $set: {
                        status:        'paid',
                        paidAt:        now,
                        paymentDate:   now,
                        financialDate: now,
                        amount:        sessionValue,
                        paymentMethod: appointment.paymentMethod || 'cash',
                        kind:          'session_payment',
                        billingType:   'particular',
                        updatedAt:     now
                    }
                },
                { session: mongoSession, new: true }
            );
            console.log(`[ParticularHandler] [PAGO] Payment existente atualizado: ${paymentCreated._id}`);
        } else {
            const [paymentDoc] = await Payment.create([{
                patient:       appointment.patient?._id,
                amount:        sessionValue,
                status:        'paid',
                type:          'service',
                serviceType:   'session',
                paymentMethod: appointment.paymentMethod || 'cash',
                paymentDate:   now,
                paidAt:        now,
                financialDate: now,
                description:   `Sessao realizada - ${appointment.patient?.fullName || 'Paciente'}`,
                appointment:   appointmentId,
                session:       sessionId,
                createdBy:     userId,
                kind:          'session_payment',
                billingType:   'particular'
            }], { session: mongoSession });
            paymentCreated = paymentDoc;
            appointmentUpdate.$set.payment = paymentCreated._id;
            console.log(`[ParticularHandler] [PAGO] Payment criado: ${paymentCreated._id}`);
        }

        // Per-session package: atualiza totalPaid e recalcula balance
        // ⚠️ Só incrementa totalPaid quando dinheiro REALMENTE entrou (NAO fiado)
        if (packageId && paymentCreated && !isBalanceOrigin) {
            const pkgAtual = await Package.findById(packageId).session(mongoSession).lean();
            if (pkgAtual && (pkgAtual.model === 'per_session' || pkgAtual.paymentType === 'per-session')) {
                const novoTotalPaid    = (pkgAtual.totalPaid || 0) + sessionValue;
                const novoPaidSessions = (pkgAtual.paidSessions || 0) + 1;

                const sessionsDone    = pkgAtual.sessionsDone || 0;
                const currentBalance  = (sessionsDone * sessionValue) - novoTotalPaid;
                await Package.findByIdAndUpdate(
                    packageId,
                    {
                        $set: {
                            totalPaid:       novoTotalPaid,
                            paidSessions:    novoPaidSessions,
                            balance:         currentBalance,
                            financialStatus: currentBalance > 0.001 ? 'unpaid' : 'paid',
                            updatedAt:       new Date()
                        }
                    },
                    { session: mongoSession }
                );
                console.log(`[ParticularHandler] [PKG] Package per-session atualizado: totalPaid=${novoTotalPaid}, balance=${currentBalance}`);
            }
        }

        return paymentCreated;
    }
};
