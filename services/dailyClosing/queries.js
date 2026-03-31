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
    return Session.find({ date })
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
    return Appointment.find({
        $or: [
            { date: targetDate },                                          // string "YYYY-MM-DD"
            { createdAt: { $gte: startOfDay, $lte: endOfDay } }
        ]
    }).populate("doctor patient package").lean();
}

export async function fetchPayments(startOfDay, endOfDay, targetDate) {
    return Payment.find({
        status: { $in: ["paid", "package_paid"] },
        $or: [
            { paymentDate: { $gte: startOfDay, $lte: endOfDay } },
            { paymentDate: targetDate },
            { paymentDate: { $exists: false }, createdAt: { $gte: startOfDay, $lte: endOfDay } },
        ],
    }).populate("patient doctor package appointment").lean();
}

export async function fetchHistoricalPackagePayments(packageIds) {
    if (packageIds.length === 0) return [];
    
    return Payment.find({
        package: { $in: packageIds.map(id => new mongoose.Types.ObjectId(id)) },
        status: { $in: ['paid', 'package_paid'] }
    }).populate('patient doctor package appointment').lean();
}
