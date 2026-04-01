// domain/liminar/recognizeRevenue.js
import Package from '../../models/Package.js';
import Payment from '../../models/Payment.js';

/**
 * Reconhece receita de pacote liminar
 * 
 * REGRAS DO LEGADO (appointment.js:2113-2162):
 * - Diminui liminarCreditBalance
 * - Aumenta recognizedRevenue
 * - Aumenta totalPaid
 * - Cria Payment de revenue_recognition
 * - billingType: 'particular' (entra no caixa)
 * - status: 'paid'
 * 
 * @param {ObjectId} packageId - ID do pacote liminar
 * @param {Object} data - Dados
 * @returns {Object} Resultado
 */
export async function recognizeLiminarRevenue(packageId, data) {
    const {
        sessionValue = 0,
        appointmentId,
        sessionId,
        patientId,
        doctorId,
        date,
        correlationId = null
    } = data;

    const pkg = await Package.findById(packageId);

    if (!pkg) {
        throw new Error('PACKAGE_NOT_FOUND');
    }

    if (pkg.type !== 'liminar') {
        throw new Error('NOT_LIMINAR_PACKAGE');
    }

    // Verifica se tem crédito suficiente
    const currentBalance = pkg.liminarCreditBalance || 0;
    
    if (currentBalance < sessionValue) {
        console.warn(`[recognizeLiminarRevenue] Crédito insuficiente`, {
            currentBalance,
            sessionValue,
            packageId
        });
        // Continua mesmo assim (pode ter configuração especial)
    }

    // Atualiza pacote
    const result = await Package.findByIdAndUpdate(
        packageId,
        {
            $inc: {
                liminarCreditBalance: -sessionValue,
                recognizedRevenue: sessionValue,
                totalPaid: sessionValue
            },
            $set: { updatedAt: new Date() }
        },
        { new: true }
    );

    // Cria Payment de reconhecimento de receita
    const payment = new Payment({
        patient: patientId,
        doctor: doctorId,
        appointment: appointmentId,
        session: sessionId,
        package: packageId,
        amount: sessionValue,
        paymentMethod: 'liminar_credit',
        billingType: 'particular', // Entra no caixa como particular
        status: 'paid',
        kind: 'revenue_recognition',
        serviceDate: date,
        paymentDate: date,
        notes: `Receita reconhecida - Processo: ${pkg.liminarProcessNumber || 'N/A'}`,
        paymentOrigin: 'liminar',
        correlationId,
        createdAt: new Date()
    });

    await payment.save();

    // Vincula payment ao appointment
    const Appointment = (await import('../../models/Appointment.js')).default;
    await Appointment.findByIdAndUpdate(appointmentId, {
        payment: payment._id,
        paymentStatus: 'package_paid'
    });

    console.log(`[recognizeLiminarRevenue] Receita reconhecida`, {
        packageId,
        sessionValue,
        liminarCreditBalance: result.liminarCreditBalance,
        recognizedRevenue: result.recognizedRevenue,
        paymentId: payment._id
    });

    return {
        recognized: true,
        amount: sessionValue,
        package: result,
        payment
    };
}
