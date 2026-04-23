// backend/services/financial/financialAnalytics.service.js
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
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
     * Helper: valor real de uma sessão de convênio (sessionValue ou pkg.insuranceGrossAmount)
     */
    _valorConvenio() {
        return {
            $cond: {
                if: { $gt: ['$sessionValue', 0] },
                then: '$sessionValue',
                else: { $ifNull: ['$pkg.insuranceGrossAmount', 0] }
            }
        };
    }

    /**
     * Helper: merge de resultados de specialty de duas fontes (Payment + Session)
     */
    _mergeSpecialties(paymentData, sessionData) {
        const map = new Map();
        for (const item of paymentData) {
            map.set(item.specialty, { ...item });
        }
        for (const item of sessionData) {
            const existing = map.get(item.specialty);
            if (existing) {
                existing.totalRevenue += item.totalRevenue;
                existing.totalSessions += item.totalSessions;
                existing.uniquePatientCount += item.uniquePatientCount;
                existing.averageTicket = existing.totalSessions > 0
                    ? Math.round((existing.totalRevenue / existing.totalSessions) * 100) / 100
                    : 0;
            } else {
                map.set(item.specialty, { ...item });
            }
        }
        return Array.from(map.values()).sort((a, b) => b.totalRevenue - a.totalRevenue);
    }

    /**
     * 1. Revenue por Especialidade — Payment (particular) + Session (convênio)
     */
    async getRevenueBySpecialty({ from, to, doctorId = null }) {
        const cacheKey = `spec_${from}_${to}_${doctorId || 'all'}`;
        const cached = this._getCache(cacheKey);
        if (cached) return cached;

        const doctorFilter = doctorId ? [{ $match: { doctor: new mongoose.Types.ObjectId(doctorId) } }] : [];

        // --- Particular: Payment model ---
        const paymentPipeline = [
            { $match: { status: 'paid', kind: { $ne: 'package_consumed' }, ...this._getDateMatch(from, to) } },
            ...doctorFilter,
            {
                $lookup: {
                    from: 'doctors', localField: 'doctor', foreignField: '_id', as: 'doc'
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
            }
        ];

        // --- Convênio: Session model ---
        const sessionPipeline = [
            {
                $match: {
                    status: 'completed',
                    date: { $gte: from, $lte: to },
                    $or: [
                        { paymentMethod: 'convenio' },
                        { package: { $exists: true, $ne: null } }
                    ]
                }
            },
            ...doctorFilter,
            {
                $lookup: {
                    from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg'
                }
            },
            { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: 'doctors', localField: 'doctor', foreignField: '_id', as: 'doc'
                }
            },
            { $unwind: { path: '$doc', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    amount: this._valorConvenio(),
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
            }
        ];

        const [paymentData, sessionData] = await Promise.all([
            Payment.aggregate(paymentPipeline),
            Session.aggregate(sessionPipeline)
        ]);

        const result = this._mergeSpecialties(paymentData, sessionData);
        this._setCache(cacheKey, result);
        return result;
    }

    /**
     * 2. Revenue por Profissional — Payment (particular) + Session (convênio)
     */
    async getRevenueByDoctor({ from, to, sessionType = null }) {
        const cacheKey = `doc_${from}_${to}_${sessionType || 'all'}`;
        const cached = this._getCache(cacheKey);
        if (cached) return cached;

        const specFilter = sessionType ? [{ $match: { specialty: sessionType } }] : [];

        // --- Particular: Payment model ---
        const paymentPipeline = [
            { $match: { status: 'paid', kind: { $ne: 'package_consumed' }, ...this._getDateMatch(from, to) } },
            {
                $lookup: {
                    from: 'doctors', localField: 'doctor', foreignField: '_id', as: 'docInfo'
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
            ...specFilter,
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
                    doctorId: { $toString: '$_id' },
                    doctorName: 1,
                    specialty: 1,
                    totalRevenue: 1,
                    sessionsCount: 1,
                    uniquePatients: { $size: '$uniquePatients' },
                    averageTicket: { $round: [{ $divide: ['$totalRevenue', '$sessionsCount'] }, 2] }
                }
            }
        ];

        // --- Convênio: Session model ---
        const sessionPipeline = [
            {
                $match: {
                    status: 'completed',
                    date: { $gte: from, $lte: to },
                    $or: [
                        { paymentMethod: 'convenio' },
                        { package: { $exists: true, $ne: null } }
                    ]
                }
            },
            {
                $lookup: {
                    from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg'
                }
            },
            { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: 'doctors', localField: 'doctor', foreignField: '_id', as: 'docInfo'
                }
            },
            { $unwind: { path: '$docInfo', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    amount: this._valorConvenio(),
                    patient: 1,
                    doctor: 1,
                    fullName: '$docInfo.fullName',
                    specialty: { $ifNull: ['$sessionType', '$docInfo.specialty', 'Outros'] }
                }
            },
            ...specFilter,
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
                    doctorId: { $toString: '$_id' },
                    doctorName: 1,
                    specialty: 1,
                    totalRevenue: 1,
                    sessionsCount: 1,
                    uniquePatients: { $size: '$uniquePatients' },
                    averageTicket: { $round: [{ $divide: ['$totalRevenue', '$sessionsCount'] }, 2] }
                }
            }
        ];

        const [paymentData, sessionData] = await Promise.all([
            Payment.aggregate(paymentPipeline),
            Session.aggregate(sessionPipeline)
        ]);

        // Merge por doctorId
        const map = new Map();
        for (const d of paymentData) {
            map.set(d.doctorId, { ...d });
        }
        for (const d of sessionData) {
            const existing = map.get(d.doctorId);
            if (existing) {
                existing.totalRevenue += d.totalRevenue;
                existing.sessionsCount += d.sessionsCount;
                existing.uniquePatients += d.uniquePatients;
                existing.averageTicket = existing.sessionsCount > 0
                    ? Math.round((existing.totalRevenue / existing.sessionsCount) * 100) / 100
                    : 0;
            } else {
                map.set(d.doctorId, { ...d });
            }
        }

        const result = Array.from(map.values()).sort((a, b) => b.totalRevenue - a.totalRevenue);
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
                { $match: { patient: new mongoose.Types.ObjectId(patientId), status: 'paid', kind: { $ne: 'package_consumed' } } },
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
     * 4. Lista de pacientes com filtros (paginada) — Payment (particular) + Session (convênio)
     */
    async getPatientsFinancialList({ page = 1, limit = 20, sortBy = 'totalSpent', order = 'desc' }) {
        const skipValue = (parseInt(page) - 1) * parseInt(limit);

        // --- Particular: Payment model ---
        const paymentPipeline = [
            { $match: { status: 'paid', kind: { $ne: 'package_consumed' } } },
            {
                $group: {
                    _id: '$patient',
                    totalSpent: { $sum: '$amount' },
                    lastPayment: { $max: '$createdAt' },
                    paymentsCount: { $sum: 1 }
                }
            }
        ];

        // --- Convênio: Session model ---
        const sessionConvenioPipeline = [
            {
                $match: {
                    status: 'completed',
                    $or: [
                        { paymentMethod: 'convenio' },
                        { package: { $exists: true, $ne: null } }
                    ]
                }
            },
            {
                $lookup: {
                    from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg'
                }
            },
            { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    patient: 1,
                    amount: this._valorConvenio(),
                    date: 1
                }
            },
            {
                $group: {
                    _id: '$patient',
                    convenioTotal: { $sum: '$amount' },
                    lastSession: { $max: '$date' },
                    sessionCount: { $sum: 1 }
                }
            }
        ];

        const [paymentData, convenioData] = await Promise.all([
            Payment.aggregate(paymentPipeline),
            Session.aggregate(sessionConvenioPipeline)
        ]);

        // Merge por patient ID
        const map = new Map();
        for (const p of paymentData) {
            const id = p._id.toString();
            map.set(id, {
                patientId: p._id,
                totalSpent: p.totalSpent,
                lastPayment: p.lastPayment,
                paymentsCount: p.paymentsCount
            });
        }
        for (const s of convenioData) {
            const id = s._id.toString();
            const existing = map.get(id);
            if (existing) {
                existing.totalSpent += s.convenioTotal;
                existing.paymentsCount += s.sessionCount;
                // Keep latest date
                const sessDate = new Date(s.lastSession);
                if (!existing.lastPayment || sessDate > existing.lastPayment) {
                    existing.lastPayment = sessDate;
                }
            } else {
                map.set(id, {
                    patientId: s._id,
                    totalSpent: s.convenioTotal,
                    lastPayment: new Date(s.lastSession),
                    paymentsCount: s.sessionCount
                });
            }
        }

        // Lookup patient info and compute averageTicket
        const merged = Array.from(map.values());
        const patientIds = merged.map(m => m.patientId);
        const patients = await Patient.find({ _id: { $in: patientIds } }, { fullName: 1, name: 1, phoneNumber: 1, phone: 1 }).lean();
        const patientMap = new Map(patients.map(p => [p._id.toString(), p]));

        const enriched = merged
            .map(m => {
                const info = patientMap.get(m.patientId.toString());
                if (!info) return null;
                return {
                    patientId: m.patientId,
                    name: info.fullName || info.name,
                    phone: info.phoneNumber || info.phone,
                    totalSpent: Math.round(m.totalSpent * 100) / 100,
                    lastPayment: m.lastPayment,
                    paymentsCount: m.paymentsCount,
                    averageTicket: m.paymentsCount > 0
                        ? Math.round((m.totalSpent / m.paymentsCount) * 100) / 100
                        : 0
                };
            })
            .filter(Boolean);

        // Sort
        const sortKey = sortBy === 'totalSpent' ? 'totalSpent' : sortBy;
        enriched.sort((a, b) => order === 'desc' ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]);

        const totalCount = enriched.length;
        const data = enriched.slice(skipValue, skipValue + parseInt(limit));

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
