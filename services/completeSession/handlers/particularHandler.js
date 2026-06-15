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
import Session from '../../../models/Session.js';
import LegacyFinanceWriteGuard from '../../financialGuard/LegacyFinanceWriteGuard.js';
import { normalizePaymentMethod } from '../../../utils/paymentResolver.js';

export const ParticularHandler = {
    /**
     * Fase 1 — campos de pagamento na Session.
     */
    buildSessionUpdate(sessionUpdate, ctx) {
        const { appointment, packageData, isBalanceOrigin } = ctx;

        // Detecta se e pacote prepaid (full / pre-pago)
        const isPrepaid = packageData?.model === 'prepaid' || packageData?.paymentType === 'full';
        // Detecta se e pacote per-session (paga individualmente, nao no ato por padrao)
        const isPerSession = packageData?.model === 'per_session' || packageData?.paymentType === 'per-session';

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
        } else if (isPerSession) {
            // Per-session sem fiado (isBalanceOrigin=false já garantido acima) = pago no ato
            LegacyFinanceWriteGuard.setSessionPaid(sessionUpdate, true, { reason: 'per_session_paid_now' });
            LegacyFinanceWriteGuard.setSessionPaymentStatus(sessionUpdate, 'paid', { reason: 'per_session_paid_now' });
            sessionUpdate.paymentOrigin = 'auto_per_session';
            sessionUpdate.paymentMethod = appointment.paymentMethod || packageData?.paymentMethod || 'pix';
            sessionUpdate.paidAt = new Date();
        } else {
            // Pago no ato (avulso)
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
        const { appointment, appointmentId, sessionId, sessionValue, packageId, packageData, mongoSession, userId, isBalanceOrigin, sessionDoc } = ctx;

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
                // ⚠️ FRAGILIDADE CONHECIDA: esta fórmula assume sessionValue fixo para todas as sessões.
                // Quebra com: descontos, sessões bônus, valores variáveis, upgrades, renegociação.
                // Correto futuro: sum(sessoesExecutadas.value) em vez de sessionsDone * sessionValue.
                // NÃO corrigir aqui sem migração de dados e auditoria completa.
                const isPrepaidCovered = totalPaid >= sessionsDone * sessionValue;

                if (isPrepaidCovered) {
                    console.log(`[ParticularHandler] [PREPAID] Sessao coberta por pagamento antecipado — Payment nao criado`);
                    return null;
                }

                // Guard: pacote prepaid/full com cobertura insuficiente (edge case).
                // Loga para auditoria e marca isFromPackage=true para não contaminar caixa.
                console.warn('[PREPAID_FALLBACK_PAYMENT]', {
                    patient: appointment.patient?._id,
                    packageId,
                    sessionValue,
                    totalPaid: pkgAtual.totalPaid,
                    sessionsDone: pkgAtual.sessionsDone,
                    model: pkgAtual.model,
                    paymentType: pkgAtual.paymentType
                });
            }
        }

        // ⛔ NÃO REMOVER — safety net para evitar ghost payments no caixa.
        // Quando isPrepaidCovered=false em pacote prepaid/full (edge case de dados inconsistentes),
        // o payment criado DEVE ser marcado isFromPackage=true para ser excluído de calculateCash.
        // Sem isso, consumo de pacote vira "entrada de caixa falsa" — bug confirmado 2026-06-01
        // que gerou R$9.420 de inflação histórica em 58 payments (março/abril/maio/junho).
        const isPrepaidFallback = !!(packageId && pkgAtual &&
            (pkgAtual.model === 'prepaid' || pkgAtual.paymentType === 'full'));

        // Detecta per-session
        const isPerSession = packageData?.model === 'per_session' || packageData?.paymentType === 'per-session';

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
                billingType:   'particular',
                ...(isPrepaidFallback ? { isFromPackage: true } : {})
            }], { session: mongoSession });
            appointmentUpdate.$set.payment = paymentDoc._id;
            console.log(`[ParticularHandler] [FIADO] Payment pending criado (addToBalance): ${paymentDoc._id}`);

            return paymentDoc;
        }

        // Sub-caso 3: per-session (pago no ato — fiado foi tratado no sub-caso 2)
        if (isPerSession) {
            let paymentCreated;
            let _existingWasPaid = false;

            if (appointment.payment) {
                const existingPaymentId = appointment.payment._id || appointment.payment;
                const existingPayment = await Payment.findById(existingPaymentId).session(mongoSession).lean();

                if (existingPayment?.status === 'paid') {
                    // ⛔⛔⛔ NUNCA ALTERAR financialDate / paidAt / paymentDate AQUI ⛔⛔⛔
                    // Payment já foi pago (pré-registrado pelo usuário — pode ter sido ontem, semana passada, etc).
                    // Sobrescrever datas = caixa errado. Apenas sincroniza campos de classificação.
                    // Bug confirmado 2026-06-10: completar appointment hoje movia caixa de ontem para hoje.
                    _existingWasPaid = true;
                    paymentCreated = await Payment.findByIdAndUpdate(
                        existingPaymentId,
                        {
                            $set: {
                                amount:        sessionValue,
                                kind:          'session_payment',
                                billingType:   'particular',
                                updatedAt:     now,
                                ...(isPrepaidFallback ? { isFromPackage: true } : {})
                                // ⛔ NÃO adicionar financialDate, paidAt, paymentDate aqui ⛔
                            }
                        },
                        { session: mongoSession, new: true }
                    );
                    appointmentUpdate.$set.paymentStatus = 'paid';
                    await Session.findByIdAndUpdate(
                        sessionId,
                        { $set: { isPaid: true, paymentStatus: 'paid', paidAt: existingPayment.paidAt || existingPayment.financialDate || now } },
                        { session: mongoSession }
                    );
                    console.log(`[ParticularHandler] [PER_SESSION] Payment já pago — datas PRESERVADAS: ${paymentCreated._id} (financialDate=${existingPayment.financialDate})`);
                } else {
                    paymentCreated = await Payment.findByIdAndUpdate(
                        existingPaymentId,
                        {
                            $set: {
                                status:        'paid',
                                paidAt:        now,
                                financialDate: now,
                                amount:        sessionValue,
                                paymentMethod: appointment.paymentMethod || packageData?.paymentMethod || 'pix',
                                kind:          'session_payment',
                                billingType:   'particular',
                                updatedAt:     now,
                                ...(isPrepaidFallback ? { isFromPackage: true } : {})
                            }
                        },
                        { session: mongoSession, new: true }
                    );
                    appointmentUpdate.$set.paymentStatus = 'paid';
                    if (sessionId) {
                        await Session.findByIdAndUpdate(
                            sessionId,
                            { $set: { isPaid: true, paymentStatus: 'paid', paidAt: now } },
                            { session: mongoSession }
                        );
                    }
                    console.log(`[ParticularHandler] [PER_SESSION] Payment pending→paid: ${paymentCreated._id}`);
                }
            } else {
                // ⛔⛔⛔ NUNCA REMOVER ESTE GUARD ⛔⛔⛔
                // Per-session pré-registrado via tabela financeira (create-sync ou outro fluxo)
                // pode não ter linkado appointment.payment por falha de sincronização.
                // Sem este lookup, particularHandler criaria um NOVO payment com financialDate=hoje,
                // duplicando o caixa e ignorando a data real de recebimento (ontem, semana passada, etc).
                // Bug confirmado 2026-06-10: Henre pagou ontem mas aparecia no caixa de hoje.
                // ⛔ NÃO substituir por `financialDate: now` sem antes rodar este lookup. ⛔
                // Janela de hoje (Brasília) para capturar orphans do dia
                const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

                const preRegistered = await Payment.findOne({
                    $or: [
                        { appointment: appointmentId },
                        ...(sessionId ? [{ session: sessionId }] : []),
                        // Orphan: payment criado via /create-sync sem appointmentId linkado.
                        // Sem esta condição, appointment.payment=null + lookup sem resultado = Payment.create() duplicado.
                        // Bug confirmado 2026-06-15: Helena pagou Pix 14:00 (orphan), complete 14:40 criou Dinheiro novo.
                        {
                            patient:       appointment.patient?._id,
                            amount:        sessionValue,
                            status:        'paid',
                            appointment:   null,
                            financialDate: { $gte: startOfToday }
                        }
                    ],
                    status: 'paid',
                    billingType: { $in: ['particular', null, undefined] }
                }).sort({ createdAt: -1 }).session(mongoSession).lean();

                if (preRegistered) {
                    // Payment pré-registrado encontrado — sincroniza campos sem sobrescrever datas.
                    // financialDate/paymentDate/paidAt NÃO são alterados: o caixa fica no dia real do recebimento.
                    paymentCreated = await Payment.findByIdAndUpdate(
                        preRegistered._id,
                        {
                            $set: {
                                amount:      sessionValue,
                                kind:        'session_payment',
                                billingType: 'particular',
                                updatedAt:   now,
                                // Adota orphan: linka ao appointment e session se ainda não linkado
                                ...(!preRegistered.appointment && appointmentId ? { appointment: appointmentId } : {}),
                                ...(!preRegistered.session && sessionId ? { session: sessionId } : {}),
                                ...(isPrepaidFallback ? { isFromPackage: true } : {})
                            }
                        },
                        { session: mongoSession, new: true }
                    );
                    appointmentUpdate.$set.payment = preRegistered._id;
                    appointmentUpdate.$set.paymentStatus = 'paid';
                    await Session.findByIdAndUpdate(
                        sessionId,
                        { $set: { isPaid: true, paymentStatus: 'paid', paidAt: preRegistered.paidAt || preRegistered.financialDate || now } },
                        { session: mongoSession }
                    );
                    _existingWasPaid = true;
                    console.log(`[ParticularHandler] [PER_SESSION] Payment pré-registrado via lookup — datas PRESERVADAS: ${preRegistered._id} (financialDate=${preRegistered.financialDate})`);
                } else {
                    const [paymentDoc] = await Payment.create([{
                        patient:       appointment.patient?._id,
                        amount:        sessionValue,
                        status:        'paid',
                        type:          'service',
                        serviceType:   'session',
                        paymentMethod: appointment.paymentMethod || packageData?.paymentMethod || 'pix',
                        paymentDate:   now,
                        paidAt:        now,
                        financialDate: now,
                        description:   `Sessao per-session realizada - ${appointment.patient?.fullName || 'Paciente'}`,
                        appointment:   appointmentId,
                        session:       sessionId,
                        createdBy:     userId,
                        kind:          'session_payment',
                        billingType:   'particular',
                        ...(isPrepaidFallback ? { isFromPackage: true } : {})
                    }], { session: mongoSession });
                    paymentCreated = paymentDoc;
                    appointmentUpdate.$set.payment = paymentCreated._id;
                    console.log(`[ParticularHandler] [PER_SESSION] Payment paid criado (sem pré-registro): ${paymentCreated._id}`);
                }
            }

            if (!_existingWasPaid && packageId && paymentCreated?.status === 'paid') {
                const pkgPerSession = await Package.findById(packageId).session(mongoSession).lean();
                if (pkgPerSession && (pkgPerSession.model === 'per_session' || pkgPerSession.paymentType === 'per-session')) {
                    const novoTotalPaid   = (pkgPerSession.totalPaid || 0) + sessionValue;
                    const novoPaidSessions = (pkgPerSession.paidSessions || 0) + 1;
                    const sessionsDone    = pkgPerSession.sessionsDone || 0;
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
                    console.log(`[ParticularHandler] [PER_SESSION] Package atualizado: totalPaid=${novoTotalPaid}, balance=${currentBalance}`);
                }
            }

            return paymentCreated;
        }

        // Sub-caso 4: pago no ato (avulso)
        let paymentCreated;

        if (appointment.payment) {
            const existingPaymentId = appointment.payment._id || appointment.payment;
            const existingPayment = await Payment.findById(existingPaymentId).session(mongoSession).lean();

            const alreadyPaid = existingPayment?.status === 'paid';
            const preservePaymentDate  = alreadyPaid ? (existingPayment?.paymentDate  || existingPayment?.financialDate || now) : now;
            const preserveFinancialDate = alreadyPaid ? (existingPayment?.financialDate || existingPayment?.paymentDate  || now) : now;
            const preservePaymentMethod = alreadyPaid ? (existingPayment?.paymentMethod || appointment.paymentMethod || 'cash') : (appointment.paymentMethod || 'cash');

            paymentCreated = await Payment.findByIdAndUpdate(
                existingPaymentId,
                {
                    $set: {
                        status:        'paid',
                        paidAt:        now,
                        paymentDate:   preservePaymentDate,
                        financialDate: preserveFinancialDate,
                        amount:        sessionValue,
                        paymentMethod: preservePaymentMethod,
                        kind:          'session_payment',
                        billingType:   'particular',
                        updatedAt:     now,
                        ...(isPrepaidFallback ? { isFromPackage: true } : {})
                    }
                },
                { session: mongoSession, new: true }
            );
            console.log(`[ParticularHandler] [PAGO] Payment existente atualizado: ${paymentCreated._id}`);
        } else {
            // Guard orphan: mesma lógica do per-session — evita duplicata se payment já existe sem appointmentId
            const startOfTodayAvulso = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const orphanAvulso = await Payment.findOne({
                patient:       appointment.patient?._id,
                amount:        sessionValue,
                status:        'paid',
                appointment:   null,
                financialDate: { $gte: startOfTodayAvulso }
            }).sort({ createdAt: -1 }).session(mongoSession).lean();

            if (orphanAvulso) {
                paymentCreated = await Payment.findByIdAndUpdate(
                    orphanAvulso._id,
                    {
                        $set: {
                            appointment:   appointmentId,
                            ...(sessionId ? { session: sessionId } : {}),
                            kind:          'session_payment',
                            billingType:   'particular',
                            updatedAt:     now,
                            ...(isPrepaidFallback ? { isFromPackage: true } : {})
                        }
                    },
                    { session: mongoSession, new: true }
                );
                appointmentUpdate.$set.payment = orphanAvulso._id;
                console.log(`[ParticularHandler] [PAGO] Orphan adotado (sem criar novo): ${orphanAvulso._id} (financialDate=${orphanAvulso.financialDate})`);
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
                    billingType:   'particular',
                    ...(isPrepaidFallback ? { isFromPackage: true } : {})
                }], { session: mongoSession });
                paymentCreated = paymentDoc;
                appointmentUpdate.$set.payment = paymentCreated._id;
                console.log(`[ParticularHandler] [PAGO] Payment criado: ${paymentCreated._id}`);
            }
        }

        if (packageId && paymentCreated && !isBalanceOrigin && paymentCreated.status === 'paid') {
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
