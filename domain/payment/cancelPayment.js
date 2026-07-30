// domain/payment/cancelPayment.js
import Payment from '../../models/Payment.js';
import PaymentLifecycleService from './PaymentLifecycleService.js';

/**
 * Cancela um pagamento (se aplicável)
 *
 * REGRA CRÍTICA DO LEGADO (appointment.js:1451-1469):
 * - Se kind === 'package_receipt' → NÃO cancela (mantém histórico)
 * - Se kind === 'session_payment' → NÃO cancela (mantém histórico)
 * - Senão → cancela (status: 'canceled')
 *
 * A partir de PR C.1, a mutação de status passa por PaymentLifecycleService,
 * que garante sincronização do campo embedded `appointment.payment`.
 *
 * @param {ObjectId} paymentId - ID do pagamento
 * @param {Object} options - Opções
 * @param {String} options.reason - Motivo do cancelamento
 * @param {mongoose.ClientSession} [options.mongoSession]
 * @returns {Object} Resultado
 */
export async function cancelPayment(paymentId, options = {}) {
    const { reason = '', mongoSession = null } = options;

    if (!paymentId) {
        return { canceled: false, reason: 'NO_PAYMENT_ID' };
    }

    const sessionOptions = mongoSession ? { session: mongoSession } : {};
    const payment = await Payment.findById(paymentId).session(mongoSession);

    if (!payment) {
        return { canceled: false, reason: 'PAYMENT_NOT_FOUND' };
    }

    // 🔴 REGRA SAGRADA DO LEGADO: NÃO cancela payment de pacote
    if (
        payment.kind === 'package_receipt' ||
        payment.kind === 'session_payment'
    ) {
        console.log(`[cancelPayment] Payment ${paymentId} é de pacote - NÃO cancela`, {
            kind: payment.kind
        });
        return {
            canceled: false,
            reason: 'PACKAGE_PAYMENT_PRESERVED',
            kind: payment.kind,
            payment
        };
    }

    // ❌ CANCELA PAYMENT via lifecycle centralizado (sincroniza Appointment)
    const result = await PaymentLifecycleService.cancelPayment(paymentId, {
        reason: reason || 'manual_cancel',
        mongoSession,
    });

    if (result.canceled) {
        console.log(`[cancelPayment] Payment ${paymentId} cancelado`);
    }

    return result;
}

/**
 * Cria pagamento para sessão completada (per-session, particular, etc)
 *
 * Regras do legado (appointment.js:1715-1772):
 * - Cria FORA da transação principal
 * - Status começa como 'pending'
 * - Vincula a appointment e session
 *
 * @param {Object} data - Dados do pagamento
 * @returns {Object} Payment criado
 */
export async function createPaymentForComplete(data) {
    const {
        patientId,
        doctorId,
        appointmentId,
        sessionId,
        packageId,
        amount,
        paymentMethod = 'pix',
        paymentOrigin = 'auto_per_session',
        correlationId = null,
        serviceDate = null,
        serviceType = 'session'
    } = data;

    const payment = new Payment({
        patient: patientId,  // 🐛 CORREÇÃO: modelo espera 'patient', não 'patientId'
        doctor: doctorId,    // 🐛 CORREÇÃO: adicionado doctor
        appointment: appointmentId,
        session: sessionId,
        package: packageId,
        amount,
        paymentMethod,
        paymentDate: serviceDate ? new Date(serviceDate) : new Date(),
        serviceType,
        serviceDate,
        status: 'pending',
        kind: paymentOrigin === 'auto_per_session' ? 'session_payment' : 'manual',
        paymentOrigin,
        correlationId,
        notes: `[${paymentOrigin.toUpperCase()}] Pagamento automático - Pendente de confirmação`,
        createdAt: new Date(),
        updatedAt: new Date()
    });

    await payment.save();

    // NOTE: caches são invalidados no fluxo completo pelo caller
    console.log(`[createPaymentForComplete] Payment criado: ${payment._id}`, {
        amount,
        paymentOrigin,
        status: 'pending'
    });

    return payment;
}

/**
 * Confirma pagamento (após commit da transação principal)
 *
 * @param {ObjectId} paymentId - ID do pagamento
 * @returns {Object} Payment confirmado
 */
export async function confirmPayment(paymentId) {
    if (!paymentId) return null;

    const payment = await Payment.findByIdAndUpdate(
        paymentId,
        {
            status: 'paid',
            paidAt: new Date(),
            confirmedAt: new Date(),
            updatedAt: new Date()
        },
        { new: true }
    );

    if (payment) {
        console.log(`[confirmPayment] Payment ${paymentId} confirmado`);
    }

    return payment;
}
