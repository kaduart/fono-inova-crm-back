// services/dailyClosing/queries.js
/**
 * Todas as queries do Daily Closing
 * Isoladas para facilitar testes e manutenção
 */

import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';

export async function fetchSessions(date) {
    // 🆕 CORREÇÃO: Usa Date range após migração (date é Date, não String)
    const startOfDay = new Date(date + 'T00:00:00-03:00');
    const endOfDay = new Date(date + 'T23:59:59-03:00');
    return Session.find({ 
        date: { $gte: startOfDay, $lte: endOfDay }
    })
        .populate("package patient doctor appointmentId")
        .lean();
}

export async function fetchAppointmentsCreated(startOfDay, endOfDay) {
    return Appointment.find({
        createdAt: { $gte: startOfDay, $lte: endOfDay },
        serviceType: { $ne: 'package_session' }
    }).populate("doctor patient package").lean();
}

export async function fetchAppointmentsToday(startOfDay, endOfDay, targetDate) {
    // 🐛 CORREÇÃO: Usar Date range, não string comparison
    // O campo date no MongoDB é Date, não string
    return Appointment.find({
        date: { $gte: startOfDay, $lte: endOfDay }
    }).populate("doctor patient package").lean();
}

export async function fetchPayments(startOfDay, endOfDay, targetDate) {
    // ✅ CORREÇÃO: Busca por createdAt (quando o pagamento foi criado/recebido)
    // Não por paymentDate (que pode ser data futura para adiantamentos)
    return Payment.find({
        $and: [
            // 🏥 CONVÊNIO: Inclui payments pendentes de faturamento (produção do dia)
            // 💰 OUTROS: Apenas pagamentos efetivamente recebidos
            {
                $or: [
                    { status: { $in: ["paid", "package_paid"] } },
                    { billingType: 'convenio', status: { $in: ['pending_billing', 'billed', 'received'] } }
                ]
            },
            // ✅ Filtro de data por createdAt (quando o dinheiro entrou)
            {
                createdAt: { $gte: startOfDay, $lte: endOfDay }
            }
        ]
    }).populate("patient doctor package appointment").lean();
}

export async function fetchHistoricalPackagePayments(packageIds) {
    if (packageIds.length === 0) return [];
    
    return Payment.find({
        package: { $in: packageIds.map(id => new mongoose.Types.ObjectId(id)) },
        status: { $in: ['paid', 'package_paid'] }
    }).populate('patient doctor package appointment').lean();
}
