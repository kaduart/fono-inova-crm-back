// domain/insurance/consumeInsuranceGuide.js
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Session from '../../models/Session.js';

/**
 * Consome sessão da guia de convênio
 * 
 * REGRAS DO LEGADO (appointment.js:2165-2271, Session.js:210-267):
 * - Só consome se status === 'active'
 * - Verifica se usedSessions < totalSessions
 * - Incrementa usedSessions
 * - Se esgotou, marca como 'exhausted'
 * - Marca session.guideConsumed = true (idempotência)
 * 
 * @param {ObjectId} guideId - ID da guia
 * @param {ObjectId} sessionId - ID da sessão (para idempotência)
 * @returns {Object} Resultado
 */
export async function consumeInsuranceGuide(guideId, sessionId) {
    if (!guideId) {
        return { consumed: false, reason: 'NO_GUIDE_ID' };
    }

    const guide = await InsuranceGuide.findById(guideId);

    if (!guide) {
        console.warn(`[consumeInsuranceGuide] Guia ${guideId} não encontrada`);
        return { consumed: false, reason: 'GUIDE_NOT_FOUND' };
    }

    // 🛡️ IDEMPOTÊNCIA: Verifica se sessão já consumiu
    if (sessionId) {
        const session = await Session.findById(sessionId);
        if (session?.guideConsumed) {
            console.log(`[consumeInsuranceGuide] Sessão ${sessionId} já consumiu guia`);
            return { 
                consumed: false, 
                alreadyConsumed: true,
                guide: {
                    usedSessions: guide.usedSessions,
                    totalSessions: guide.totalSessions
                }
            };
        }
    }

    // Valida guia
    if (guide.status !== 'active') {
        console.warn(`[consumeInsuranceGuide] Guia ${guideId} não está ativa (status: ${guide.status})`);
        return { 
            consumed: false, 
            reason: 'GUIDE_NOT_ACTIVE',
            status: guide.status
        };
    }

    if (guide.usedSessions >= guide.totalSessions) {
        console.warn(`[consumeInsuranceGuide] Guia ${guideId} esgotada`);
        return { 
            consumed: false, 
            reason: 'GUIDE_EXHAUSTED',
            usedSessions: guide.usedSessions,
            totalSessions: guide.totalSessions
        };
    }

    // Consome sessão
    guide.usedSessions += 1;

    // Se esgotou, marca como exhausted
    if (guide.usedSessions >= guide.totalSessions) {
        guide.status = 'exhausted';
    }

    await guide.save();

    // Marca sessão como consumida
    if (sessionId) {
        await Session.findByIdAndUpdate(sessionId, {
            guideConsumed: true
        });
    }

    console.log(`[consumeInsuranceGuide] Guia ${guideId} consumida`, {
        usedSessions: guide.usedSessions,
        totalSessions: guide.totalSessions,
        remaining: guide.totalSessions - guide.usedSessions,
        status: guide.status
    });

    return {
        consumed: true,
        guide: {
            _id: guide._id,
            number: guide.number,
            usedSessions: guide.usedSessions,
            totalSessions: guide.totalSessions,
            status: guide.status
        },
        remainingSessions: guide.totalSessions - guide.usedSessions
    };
}

/**
 * Cria Payment para convênio
 * 
 * Regras do legado (appointment.js:2175-2237):
 * - billingType: 'convenio'
 * - status: 'pending'
 * - insuranceValue: valor do convênio
 * - kind: 'manual'
 * 
 * @param {Object} data - Dados do pagamento
 * @returns {Object} Payment criado
 */
export async function createInsurancePayment(data) {
    const {
        patientId,
        doctorId,
        appointmentId,
        sessionId,
        packageId,
        guideId,
        insuranceProvider,
        insuranceValue = 0,
        authorizationCode = null,
        correlationId = null
    } = data;

    const Payment = (await import('../../models/Payment.js')).default;

    const payment = new Payment({
        patientId,
        appointmentId,
        sessionId,
        packageId,
        amount: 0, // Paciente não paga
        billingType: 'convenio',
        insuranceProvider,
        insuranceValue,
        paymentMethod: 'other', // convenio não é enum válido
        paymentDate: new Date(),
        status: 'pending',
        kind: 'manual',
        insurance: {
            provider: insuranceProvider,
            grossAmount: insuranceValue,
            authorizationCode,
            guideId,
            status: 'pending_billing'
        },
        serviceDate: new Date(),
        notes: `Sessão de convênio - Guia ${guideId}`,
        paymentOrigin: 'convenio',
        correlationId,
        createdAt: new Date()
    });

    await payment.save();

    console.log(`[createInsurancePayment] Payment de convênio criado: ${payment._id}`, {
        insuranceProvider,
        insuranceValue
    });

    return payment;
}
