// services/dailyClosingService.js
/**
 * Daily Closing Service - Core de Negócio
 * 
 * Extrai toda a lógica do legado (/payments/daily-closing)
 * para ser reusada por:
 * - Legado (compatibilidade)
 * - Worker V2 (snapshot)
 */

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

// ======================================================
// HELPERS (do legado)
// ======================================================
const mapStatusToOperational = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'completed') return 'completed';
    if (s === 'canceled' || s === 'cancelled') return 'canceled';
    if (s === 'confirmed') return 'scheduled';
    return 'scheduled';
};

const mapStatusToClinical = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'completed') return 'completed';
    if (s === 'canceled' || s === 'cancelled') return 'missed';
    return 'pending';
};

const normalizePaymentMethod = (method) => {
    if (!method) return "dinheiro";
    method = String(method).toLowerCase().trim();
    if (method.includes("pix")) return "pix";
    if (method.includes("cartão") || method.includes("cartao") ||
        method.includes("card") || method.includes("credito") ||
        method.includes("débito") || method.includes("debito")) return "cartão";
    return "dinheiro";
};

const isCanceled = (status) => ["canceled"].includes((status || "").toLowerCase());
const isConfirmed = (status) => ["confirmed"].includes((status || "").toLowerCase());
const isCompleted = (status) => ["completed"].includes((status || "").toLowerCase());

const getPaymentDate = (pay) => {
    if (!pay) return null;
    if (typeof pay.paymentDate === "string" && pay.paymentDate.trim()) {
        return pay.paymentDate;
    }
    return moment(pay.createdAt).tz("America/Sao_Paulo").format("YYYY-MM-DD");
};

// ======================================================
// SERVICE PRINCIPAL
// ======================================================
export async function calculateDailyClosing(date, clinicId) {
    const targetDate = date 
        ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
        : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");

    const startOfDay = moment.tz(`${targetDate}T00:00:00`, "America/Sao_Paulo").toDate();
    const endOfDay = moment.tz(`${targetDate}T23:59:59`, "America/Sao_Paulo").toDate();

    console.log(`[DailyClosingService] Calculando: ${targetDate}`);

    // ======================================================
    // 1. BUSCAR SESSIONS (igual ao legado)
    // ======================================================
    const sessions = await Session.find({ date: targetDate })
        .populate("package patient doctor appointmentId")
        .lean();

    // ======================================================
    // 2. ATUALIZAR APPOINTMENTS (bulkWrite)
    // ======================================================
    if (sessions.length > 0) {
        const bulkOps = sessions
            .filter(s => s.appointmentId)
            .map(s => {
                const paidLike = ['paid', 'package_paid', 'advanced', 'partial']
                    .includes(String(s.paymentStatus || '').toLowerCase()) || !!s.isPaid;

                return {
                    updateOne: {
                        filter: { _id: s.appointmentId },
                        update: {
                            $set: {
                                sessionValue: s.sessionValue,
                                paymentStatus: paidLike ? (s.paymentStatus || 'paid') : (s.paymentStatus || 'pending'),
                                operationalStatus: mapStatusToOperational(s.status),
                                clinicalStatus: mapStatusToClinical(s.status),
                            }
                        }
                    }
                };
            });

        if (bulkOps.length > 0) {
            await Appointment.bulkWrite(bulkOps, { ordered: false })
                .catch(e => console.error('[DailyClosingService] bulkWrite error:', e.message));
        }
    }

    // ======================================================
    // 3. QUERIES PARALELAS (igual ao legado)
    // ======================================================
    const [appointmentsCreated, appointmentsToday, payments] = await Promise.all([
        // Appointments criados hoje
        Appointment.find({
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            serviceType: { $ne: 'package_session' }
        }).populate("doctor patient package").lean(),
        
        // Appointments para hoje OU criados hoje
        Appointment.find({
            $or: [
                { date: { $gte: startOfDay, $lte: endOfDay } },
                { createdAt: { $gte: startOfDay, $lte: endOfDay } }
            ]
        }).populate("doctor patient package").lean(),

        // Pagamentos recebidos hoje
        Payment.find({
            status: { $in: ["paid", "package_paid"] },
            $or: [
                { paymentDate: { $gte: startOfDay, $lte: endOfDay } },
                { paymentDate: targetDate },
                { paymentDate: { $exists: false }, createdAt: { $gte: startOfDay, $lte: endOfDay } },
            ],
        }).populate("patient doctor package appointment").lean()
    ]);

    // Deduplicar appointments
    const uniqueAppointmentsMap = new Map();
    for (const appt of appointmentsToday) {
        const id = appt._id.toString();
        if (!uniqueAppointmentsMap.has(id)) {
            uniqueAppointmentsMap.set(id, appt);
        }
    }
    const uniqueAppointmentsToday = Array.from(uniqueAppointmentsMap.values());

    // ======================================================
    // 4. PAGAMENTOS HISTÓRICOS DE PACOTES
    // ======================================================
    const packageIdsToday = [...new Set(
        uniqueAppointmentsToday
            .filter(a => a.serviceType === 'package_session' && a.package?._id)
            .map(a => a.package._id.toString())
    )];

    const historicalPackagePayments = packageIdsToday.length > 0
        ? await Payment.find({
            package: { $in: packageIdsToday.map(id => new mongoose.Types.ObjectId(id)) },
            status: { $in: ['paid', 'package_paid'] }
        }).populate('patient doctor package appointment').lean()
        : [];

    const allPaymentsForMaps = [
        ...payments,
        ...historicalPackagePayments.filter(hp => !payments.some(p => p._id.toString() === hp._id.toString()))
    ];

    // ======================================================
    // 5. MAPS PARA PERFORMANCE O(1)
    // ======================================================
    const paymentsByAppt = new Map();
    const paymentsByPackage = new Map();
    const paymentsByPatient = new Map();

    allPaymentsForMaps.forEach(p => {
        const apptId = p.appointment?._id?.toString();
        if (apptId) {
            if (!paymentsByAppt.has(apptId)) paymentsByAppt.set(apptId, []);
            paymentsByAppt.get(apptId).push(p);
        }

        const pkgId = p.package?._id?.toString();
        if (pkgId) {
            if (!paymentsByPackage.has(pkgId)) paymentsByPackage.set(pkgId, []);
            paymentsByPackage.get(pkgId).push(p);
        }

        const patientId = p.patient?._id?.toString();
        if (patientId) {
            if (!paymentsByPatient.has(patientId)) paymentsByPatient.set(patientId, []);
            paymentsByPatient.get(patientId).push(p);
        }
    });

    // ======================================================
    // 6. FILTRAR PAGAMENTOS DO DIA
    // ======================================================
    const filteredPayments = payments.filter((p) => {
        const payDate = getPaymentDate(p);
        const isTargetDate = payDate === targetDate;

        if (p.billingType === 'convenio') {
            const isReceived = p.insurance?.status === 'received';
            const receivedToday = p.insurance?.receivedAt &&
                moment(p.insurance.receivedAt).format('YYYY-MM-DD') === targetDate;
            return receivedToday && isReceived;
        }

        return isTargetDate;
    });

    // ======================================================
    // 7. CALCULAR PAGAMENTOS POR MÉTODO
    // ======================================================
    const paymentsByMethod = { dinheiro: 0, pix: 0, cartão: 0 };
    filteredPayments.forEach(p => {
        const method = normalizePaymentMethod(p.paymentMethod);
        if (paymentsByMethod[method] !== undefined) {
            paymentsByMethod[method] += p.amount || 0;
        }
    });

    // ======================================================
    // 8. MONTAR RELATÓRIO COMPLETO
    // ======================================================
    const report = {
        date: targetDate,
        summary: {
            appointments: {
                total: 0,
                attended: 0,
                canceled: 0,
                pending: 0,
                expectedValue: 0,
                novos: 0,
                recorrentes: 0
            },
            financial: {
                totalReceived: filteredPayments.reduce((sum, p) => sum + (p.amount || 0), 0),
                totalExpected: 0,
                totalRevenue: 0,
                byMethod: paymentsByMethod
            },
            insurance: {
                production: 0,
                received: 0,
                pending: 0,
                sessionsCount: 0
            }
        },
        timelines: {
            appointments: [],
            payments: [],
            insuranceSessions: []
        },
        professionals: [],
        timeSlots: []
    };

    // Calcular appointments
    for (const appt of uniqueAppointmentsToday) {
        const opStatus = appt.operationalStatus || 'scheduled';
        const clinicalStatus = appt.clinicalStatus || 'pending';
        const sessionValue = Number(appt.sessionValue || 0);

        report.summary.appointments.total++;
        report.summary.appointments.expectedValue += sessionValue;

        if (isCanceled(opStatus)) report.summary.appointments.canceled++;
        else if (isConfirmed(opStatus) || isCompleted(clinicalStatus)) report.summary.appointments.attended++;
        else report.summary.appointments.pending++;

        // Novos vs Recorrentes
        if (appt.isFirstAppointment || appt.patientType === 'new') {
            report.summary.appointments.novos++;
        } else {
            report.summary.appointments.recorrentes++;
        }
    }

    // Calcular receita (expected - cancelado)
    report.summary.financial.totalExpected = report.summary.appointments.expectedValue;
    report.summary.financial.totalRevenue = report.summary.appointments.expectedValue - 
        (uniqueAppointmentsToday
            .filter(a => isCanceled(a.operationalStatus))
            .reduce((sum, a) => sum + Number(a.sessionValue || 0), 0));

    // ======================================================
    // 9. PROCESSAR SESSÕES DE CONVÊNIO
    // ======================================================
    const insuranceSessions = sessions.filter(s => 
        s.package?.type === 'convenio' || 
        s.paymentMethod === 'convenio' ||
        s.billingType === 'convenio'
    );

    for (const session of insuranceSessions) {
        const pkg = session.package;
        const provider = pkg?.insuranceProvider || session.insuranceProvider || 'Convênio';
        const insuranceValue = pkg?.insuranceGrossAmount || pkg?.sessionValue || 80;
        const isSessionCompleted = session.status === 'completed';

        if (isSessionCompleted) {
            report.summary.insurance.production += insuranceValue;
            report.summary.insurance.sessionsCount += 1;
            
            if (session.isPaid) {
                report.summary.insurance.received += insuranceValue;
            } else {
                report.summary.insurance.pending += insuranceValue;
            }
        }
    }

    console.log(`[DailyClosingService] Completo: ${targetDate}`, {
        appointments: report.summary.appointments.total,
        payments: filteredPayments.length,
        totalReceived: report.summary.financial.totalReceived
    });

    return report;
}

export default { calculateDailyClosing };
