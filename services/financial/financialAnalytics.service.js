// backend/services/financial/financialAnalytics.service.js
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import Patient from '../../models/Patient.js';
import Package from '../../models/Package.js';

// Cache simples em memória (60 segundos)
const analyticsCache = new Map();
const CACHE_TTL = 60 * 1000;

class FinancialAnalyticsService {

    _getCache(key) {
        const cached = analyticsCache.get(key);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            return cached.data;
        }
        return null;
    }

    _setCache(key, data) {
        analyticsCache.set(key, { data, timestamp: Date.now() });
    }

    /**
     * Filtro resiliente para datas (String YYYY-MM-DD ou Date)
     */
    _getDateMatch(from, to) {
        return {
            $or: [
                { paymentDate: { $gte: from, $lte: to } },
                {
                    paymentDate: { $exists: false },
                    createdAt: {
                        $gte: new Date(from + 'T00:00:00.000Z'),
                        $lte: new Date(to + 'T23:59:59.999Z')
                    }
                },
                { paidAt: { $gte: new Date(from), $lte: new Date(to) } }
            ]
        };
    }

    /**
     * 1. Revenue por Especialidade (com Fallback para Doctor Specialty)
     */
    async getRevenueBySpecialty({ from, to, doctorId = null }) {
        const cacheKey = `spec_${from}_${to}_${doctorId || 'all'}`;
        const cached = this._getCache(cacheKey);
        if (cached) return cached;

        const pipeline = [
            {
                $match: {
                    status: 'paid',
                    ...this._getDateMatch(from, to)
                }
            },
            ...(doctorId ? [{ $match: { doctor: new mongoose.Types.ObjectId(doctorId) } }] : []),
            {
                $lookup: {
                    from: 'doctors',
                    localField: 'doctor',
                    foreignField: '_id',
                    as: 'doc'
                }
            },
            { $unwind: { path: '$doc', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    amount: 1,
                    patient: 1,
                    specialty: { $ifNull: ['$sessionType', '$doc.specialty', 'Outros'] }
                }
            },
            {
                $group: {
                    _id: '$specialty',
                    totalRevenue: { $sum: '$amount' },
                    totalSessions: { $sum: 1 },
                    averageTicket: { $avg: '$amount' },
                    uniquePatients: { $addToSet: '$patient' }
                }
            },
            {
                $project: {
                    specialty: '$_id',
                    totalRevenue: 1,
                    totalSessions: 1,
                    averageTicket: { $round: ['$averageTicket', 2] },
                    uniquePatientCount: { $size: '$uniquePatients' }
                }
            },
            { $sort: { totalRevenue: -1 } }
        ];

        const result = await Payment.aggregate(pipeline);
        this._setCache(cacheKey, result);
        return result;
    }

    /**
     * 2. Revenue por Profissional
     */
    async getRevenueByDoctor({ from, to, sessionType = null }) {
        const cacheKey = `doc_${from}_${to}_${sessionType || 'all'}`;
        const cached = this._getCache(cacheKey);
        if (cached) return cached;

        const pipeline = [
            {
                $match: {
                    status: 'paid',
                    ...this._getDateMatch(from, to)
                }
            },
            {
                $lookup: {
                    from: 'doctors',
                    localField: 'doctor',
                    foreignField: '_id',
                    as: 'docInfo'
                }
            },
            { $unwind: '$docInfo' },
            {
                $project: {
                    amount: 1,
                    patient: 1,
                    doctor: 1,
                    fullName: '$docInfo.fullName',
                    specialty: { $ifNull: ['$sessionType', '$docInfo.specialty', 'Outros'] }
                }
            },
            ...(sessionType ? [{ $match: { specialty: sessionType } }] : []),
            {
                $group: {
                    _id: '$doctor',
                    doctorName: { $first: '$fullName' },
                    specialty: { $first: '$specialty' },
                    totalRevenue: { $sum: '$amount' },
                    sessionsCount: { $sum: 1 },
                    uniquePatients: { $addToSet: '$patient' }
                }
            },
            {
                $project: {
                    doctorId: '$_id',
                    doctorName: 1,
                    specialty: 1,
                    totalRevenue: 1,
                    sessionsCount: 1,
                    uniquePatients: { $size: '$uniquePatients' },
                    averageTicket: { $round: [{ $divide: ['$totalRevenue', '$sessionsCount'] }, 2] }
                }
            },
            { $sort: { totalRevenue: -1 } }
        ];

        const result = await Payment.aggregate(pipeline);
        this._setCache(cacheKey, result);
        return result;
    }

    /**
     * 3. Patient 360°
     */
    async getPatient360(patientId) {
        const now = new Date();

        const [patient, financialSummary, lastAppointment, packages] = await Promise.all([
            Patient.findById(patientId).lean(),

            Payment.aggregate([
                { $match: { patient: new mongoose.Types.ObjectId(patientId), status: 'paid' } },
                {
                    $group: {
                        _id: null,
                        totalSpent: { $sum: '$amount' },
                        totalPayments: { $sum: 1 },
                        firstPayment: { $min: '$createdAt' },
                        lastPayment: { $max: '$createdAt' }
                    }
                }
            ]),

            Appointment.findOne({ patient: patientId })
                .sort({ date: -1 })
                .populate('doctor', 'fullName specialty')
                .lean(),

            Package.find({
                patient: patientId,
                status: { $in: ['active', 'in-progress', 'pending'] }
            }).lean()
        ]);

        if (!patient) throw new Error('Paciente não encontrado');

        const fin = financialSummary[0] || { totalSpent: 0, totalPayments: 0, firstPayment: null, lastPayment: null };

        const lastVisitDate = lastAppointment ? new Date(lastAppointment.date) : null;
        const daysSinceLastVisit = lastVisitDate ?
            Math.floor((now.getTime() - lastVisitDate.getTime()) / (1000 * 60 * 60 * 24)) :
            null;

        const riskFlags = [];
        if (daysSinceLastVisit > 30) riskFlags.push('long_absence');
        if (daysSinceLastVisit > 60) riskFlags.push('churn_risk');

        const hasPackageEnding = packages.some(p => (p.totalSessions - p.sessionsDone) <= 2);
        if (hasPackageEnding) riskFlags.push('package_ending');

        const hasNoActivePackage = packages.length === 0;
        if (hasNoActivePackage) riskFlags.push('no_active_package');

        return {
            patient: {
                id: patient._id,
                name: patient.fullName || patient.name,
                phone: patient.phoneNumber || patient.phone,
                email: patient.email
            },
            financial: {
                totalSpent: fin.totalSpent,
                totalPayments: fin.totalPayments,
                averageTicket: fin.totalPayments > 0 ? Math.round((fin.totalSpent / fin.totalPayments) * 100) / 100 : 0,
                lifetimeValue: fin.totalSpent,
                customerSince: fin.firstPayment,
                lastPayment: fin.lastPayment
            },
            activity: {
                lastVisitDate: lastAppointment?.date,
                daysSinceLastVisit,
                lastVisitDoctor: lastAppointment?.doctor?.fullName,
                lastVisitSpecialty: lastAppointment?.doctor?.specialty || lastAppointment?.specialty
            },
            packages: packages.map(p => ({
                id: p._id,
                sessionType: p.sessionType,
                totalSessions: p.totalSessions,
                sessionsDone: p.sessionsDone,
                remainingSessions: p.totalSessions - p.sessionsDone,
                isExpiringSoon: (p.totalSessions - p.sessionsDone) <= 2
            })),
            alerts: {
                riskLevel: riskFlags.includes('churn_risk') ? 'high' : riskFlags.length > 0 ? 'medium' : 'low',
                riskFlags,
                suggestedActions: this._suggestActions(riskFlags, packages)
            }
        };
    }

    /**
     * 4. Lista de pacientes com filtros (paginada)
     */
    async getPatientsFinancialList({ page = 1, limit = 20, sortBy = 'totalSpent', order = 'desc' }) {
        const skipValue = (parseInt(page) - 1) * parseInt(limit);

        const pipeline = [
            { $match: { status: 'paid' } },
            {
                $group: {
                    _id: '$patient',
                    totalSpent: { $sum: '$amount' },
                    lastPayment: { $max: '$createdAt' },
                    paymentsCount: { $sum: 1 }
                }
            },
            {
                $lookup: {
                    from: 'patients',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'patientInfo'
                }
            },
            { $unwind: '$patientInfo' },
            {
                $project: {
                    patientId: '$_id',
                    name: { $ifNull: ['$patientInfo.fullName', '$patientInfo.name'] },
                    phone: { $ifNull: ['$patientInfo.phoneNumber', '$patientInfo.phone'] },
                    totalSpent: 1,
                    lastPayment: 1,
                    paymentsCount: 1,
                    averageTicket: { $round: [{ $divide: ['$totalSpent', '$paymentsCount'] }, 2] }
                }
            },
            { $sort: { [sortBy]: order === 'desc' ? -1 : 1 } },
            { $skip: skipValue },
            { $limit: parseInt(limit) }
        ];

        const countPipeline = [
            { $match: { status: 'paid' } },
            { $group: { _id: '$patient' } },
            { $count: 'total' }
        ];

        const [data, countResult] = await Promise.all([
            Payment.aggregate(pipeline),
            Payment.aggregate(countPipeline)
        ]);

        const totalCount = countResult[0]?.total || 0;

        return {
            data,
            total: totalCount,
            page: parseInt(page),
            totalPages: Math.ceil(totalCount / parseInt(limit))
        };
    }

    async getAlertsForToday() {
        const today = new Date();

        const allPackages = await Package.find({
            status: { $in: ['active', 'in-progress'] }
        }).populate('patient', 'fullName phoneNumber name phone');

        const endingPackages = allPackages.filter(p => (p.totalSessions - p.sessionsDone) <= 2);

        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

        const inactivePatientsAgg = await Appointment.aggregate([
            {
                $group: {
                    _id: '$patient',
                    lastVisit: { $max: '$date' }
                }
            },
            {
                $match: {
                    lastVisit: { $lte: thirtyDaysAgoStr }
                }
            },
            {
                $lookup: {
                    from: 'patients',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'patient'
                }
            },
            { $unwind: '$patient' },
            {
                $project: {
                    patientId: '$_id',
                    name: { $ifNull: ['$patient.fullName', '$patient.name'] },
                    phone: { $ifNull: ['$patient.phoneNumber', '$patient.phone'] },
                    lastVisit: 1
                }
            },
            { $limit: 100 }
        ]);

        return {
            packagesEnding: endingPackages.map(p => ({
                type: 'package_ending',
                patientId: p.patient._id,
                patientName: p.patient.fullName || p.patient.name,
                phone: p.patient.phoneNumber || p.patient.phone,
                remainingSessions: p.totalSessions - p.sessionsDone,
                message: `Olá ${p.patient.fullName || p.patient.name}, faltam apenas ${p.totalSessions - p.sessionsDone} sessões do seu pacote. Que tal renovar e garantir sua continuidade? 😊`
            })),
            churnRisk: inactivePatientsAgg.map(p => ({
                type: 'churn_risk',
                patientId: p.patientId,
                patientName: p.name,
                phone: p.phone,
                lastVisit: p.lastVisit,
                message: `Olá ${p.name}, sentimos sua falta! Já faz algum tempo desde sua última consulta. Podemos agendar sua volta? 💚`
            }))
        };
    }

    _suggestActions(flags, packages) {
        const actions = [];
        if (flags.includes('package_ending')) {
            actions.push('Oferecer renovação de pacote com 10% de desconto');
        }
        if (flags.includes('long_absence')) {
            actions.push('Ligar/WhatsApp perguntando se está tudo bem');
        }
        if (flags.includes('churn_risk')) {
            actions.push('Oferecer retorno com valor especial');
        }
        if (flags.includes('no_active_package')) {
            actions.push('Oferecer pacote de 10 sessões (primeira compra)');
        }
        return actions;
    }
}

export default new FinancialAnalyticsService();
