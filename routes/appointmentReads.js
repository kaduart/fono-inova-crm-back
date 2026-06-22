import express from 'express';
import mongoose from 'mongoose';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import { getAvailableTimeSlots } from '../middleware/conflictDetection.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import PatientBalance from '../models/PatientBalance.js';
import { mapAppointmentToEvent } from '../utils/appointmentMapper.js';
import { mapAppointmentDTO } from '../utils/appointmentDto.js';

const router = express.Router();

// ======================================================================
// HELPER: Validação segura de datas
// ======================================================================
function isValidDateString(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return false;
    const date = new Date(dateStr);
    return !isNaN(date.getTime());
}

// ======================================================================
// HELPER: Enriquece pacientes com último e próximo agendamento
// ======================================================================
function attachLastAndNext(patients) {
    const now = new Date();
    return patients.map((patient) => {
        const appointments = patient.appointments || [];
        const sorted = [...appointments].sort((a, b) => new Date(a.date) - new Date(b.date));
        const nextAppointment = sorted.find((a) => new Date(a.date) >= now) || null;
        const lastAppointment = [...sorted].reverse().find((a) => new Date(a.date) < now) || null;
        return {
            ...patient,
            nextAppointment,
            lastAppointment,
        };
    });
}

// Verifica horários disponíveis
router.get('/available-slots', flexibleAuth, getAvailableTimeSlots);

// Lista pacientes com agendamentos
router.get('/with-appointments', flexibleAuth, async (req, res) => {
    try {
        const patients = await Patient.find(/* seu filtro */)
            .select('-__v')
            .populate({
                path: 'appointments',
                select:
                    'date time doctor operationalStatus clinicalStatus paymentStatus serviceType session specialty payment',
                match: { operationalStatus: { $ne: 'canceled' } },
            })
            .lean({ virtuals: false }); // 🔑 desliga virtuals

        const enriched = attachLastAndNext(patients);
        res.json({ success: true, data: enriched });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Busca agendamentos por especialidade
router.get('/by-specialty/:specialty', auth, async (req, res) => {
    try {
        const { specialty } = req.params;
        const appointments = await Appointment.find({
            doctor: req.user._id,
            specialty,
            operationalStatus: { $ne: 'pre_agendado' },
            appointmentId: { $exists: false }
        })
            .populate('patient', 'fullName phone dateOfBirth email')
            .populate('doctor', 'fullName specialty')
            .lean();

        res.json(appointments.map(mapAppointmentDTO));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Histórico de agendamentos por paciente
router.get('/history/:patientId', flexibleAuth, async (req, res) => {
    try {
        const { patientId } = req.params;
        const history = await Appointment.find({ patient: patientId, operationalStatus: { $ne: 'pre_agendado' }, appointmentId: { $exists: false } })
            .sort({ date: -1 })
            .populate('doctor', 'fullName specialty')
            .populate('payment', 'status amount paymentMethod');
        res.json({ success: true, data: history.map(mapAppointmentDTO) });
    } catch (error) {
        if (error.name === 'ValidationError') {
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});

            return res.status(400).json({
                message: 'Falha na validação dos dados',
                errors
            });
        }

        return res.status(500).json({ error: 'Erro interno' });
    }
});

// Busca todos os agendamentos de um paciente
router.get('/patient/:id', validateId, auth, async (req, res) => {

    let patient = req.params.id;
    
    // 🆕 Verifica se é um ID de view ou ID real
    const PatientsView = mongoose.model('PatientsView');
    const patientView = await PatientsView.findById(patient).lean();
    
    if (patientView) {
        // É um ID de view, usa o patientId real
        console.log(`[GET /appointments/patient/:id] PatientId é de view, usando patientId real: ${patientView.patientId}`);
        patient = patientView.patientId;
    }
    
    try {
        const appointments = await Appointment.find({ patient, operationalStatus: { $ne: 'pre_agendado' }, appointmentId: { $exists: false } }).populate([
            { path: 'doctor', select: 'fullName crm' },
            { path: 'patient', select: 'fullName phone' },
            { path: 'payment' },
            {
                path: 'advancedSessions', // Nome correto do campo
                select: 'date time specialty operationalStatus clinicalStatus',
                populate: {
                    path: 'doctor',
                    select: 'fullName specialty'
                }
            },
            {
                path: 'history.changedBy',
                select: 'name email role',
                options: { retainNullValues: true },
            },
            {
                path: 'package',
                select: 'sessionType durationMonths sessionsPerWeek',
                populate: {
                    path: 'sessions',
                    select: 'date status isPaid'
                }
            },
            {
                path: 'session',
                select: 'date status isPaid confirmedAbsence',
                populate: {
                    path: 'package',
                    select: 'sessionType durationMonths sessionsPerWeek'
                }
            }
        ]).lean();

        const formattedAppointments = appointments.map(appt => {
            const dto = mapAppointmentDTO(appt);
            
            // Formatar sessões adiantadas
            let advancedSessions = appt.advancedSessions;
            if (advancedSessions) {
                advancedSessions = advancedSessions.map(session => ({
                    ...session,
                    formattedDate: session.date && isValidDateString(session.date)
                        ? new Date(session.date).toLocaleDateString('pt-BR')
                        : 'Data não disponível',
                    formattedTime: session.time || '--:--',
                }));
            }

            return {
                ...dto,
                advancedSessions,
                paymentStatus:
                    appt.package
                        ? (appt.paymentStatus || 'package_paid')
                        : (appt.paymentStatus === 'paid' ? 'paid' : appt.paymentStatus || 'pending'),
                source: appt.package ? 'package' : 'individual',
                // Campos enriquecidos que o DTO não cobre
                history: appt.history,
                session: appt.session,
                package: appt.package
            };
        });

        res.json({ success: true, data: formattedAppointments });
    } catch (error) {
        if (error.name === 'ValidationError') {
            const errors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});

            return res.status(400).json({
                message: 'Falha na validação dos dados',
                errors
            });
        }

        return res.status(500).json({ error: 'Erro interno' });
    }
});

router.get('/count-by-status', auth, async (req, res) => {
    try {
        const { dateFrom, dateTo, specialty } = req.query;

        // FILTRO SEM MÉDICO (toda clínica)
        const filter = {};

        // Filtro de datas
        if (dateFrom || dateTo) {
            filter.date = {};
            if (dateFrom && isValidDateString(dateFrom)) {
                filter.date.$gte = new Date(dateFrom);
            }
            if (dateTo && isValidDateString(dateTo)) {
                const end = new Date(dateTo);
                end.setHours(23, 59, 59, 999);
                filter.date.$lte = end;
            }
        }

        // Filtro de especialidade
        if (specialty && specialty !== 'all') {
            filter.specialty = specialty;
        }

        // Agregação - Agendamentos Reais
        const counts = await Appointment.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$operationalStatus",
                    count: { $sum: 1 }
                }
            }
        ]);

        // 🛡️ Exclui pré-agendamentos pendentes e convertidos da contagem
        filter.operationalStatus = { $ne: 'pre_agendado' };
        filter.appointmentId = { $exists: false };

        // Formatar resultado
        const result = {
            agendado: 0,
            confirmado: 0,
            cancelado: 0,
            pago: 0,
            faltou: 0,
            pre_agendado: 0
        };

        counts.forEach(item => {
            if (result.hasOwnProperty(item._id)) {
                result[item._id] = item.count;
            }
        });

        return res.json({ success: true, data: result });

    } catch (error) {
        console.error('Erro na rota count-by-status:', error);
        return res.status(500).json({
            success: false,
            message: 'Erro interno do servidor',
            error: error.message
        });
    }
});

// Nova rota para estatísticas completas
// Atualize a rota de estatísticas
router.get('/stats', auth, async (req, res) => {
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        const doctor = new mongoose.Types.ObjectId(req.user._id);

        // Configuração das especialidades
        const specialtiesConfig = {
            'Terapia Ocupacional': {
                id: 'to',
                name: 'Terapia Ocupacional',
                icon: 'accessibility',
                color: '#9C27B0',
                sessionDuration: 40,
                price: 200.00
            },
            'Psicologia': {
                id: 'psicologia',
                name: 'Psicologia',
                icon: 'psychology',
                color: '#3F51B5',
                sessionDuration: 40,
                price: 200.00
            },
            'Psiquiatria': {
                id: 'psiquiatria',
                name: 'Psiquiatria',
                icon: 'medical_services',
                color: '#009688',
                sessionDuration: 30,
                price: 300.00
            },
            'Fonoaudiologia': {
                id: 'fonoaudiologia',
                name: 'Fonoaudiologia',
                icon: 'AudioLines',
                color: '#FF9800',
                sessionDuration: 40,
                price: 160.00
            },
            'Psicomotricidade': {
                id: 'psicomotricidade',
                name: 'Psicomotricidade',
                icon: 'directions_run',
                color: '#FF5722',
                sessionDuration: 40,
                price: 180.00
            },
            'Musicoterapia': {
                id: 'musicoterapia',
                name: 'Musicoterapia',
                icon: 'music_note',
                color: '#17c041',
                sessionDuration: 40,
                price: 180.00
            },
            'Psicopedagogia': {
                id: 'psicopedagogia',
                name: 'Psicopedagogia',
                icon: 'school',
                color: '#9C27B0',
                sessionDuration: 40,
                price: 180.00
            }
        };

        const stats = await Appointment.aggregate([
            { $match: { doctor, operationalStatus: { $ne: 'pre_agendado' }, appointmentId: { $exists: false } } },
            {
                $facet: {
                    today: [
                        { $match: { date: { $gte: todayStart, $lte: todayEnd } } },
                        { $count: "count" }
                    ],
                    confirmed: [
                        { $match: { operationalStatus: 'confirmed' } },
                        { $count: "count" }
                    ],
                    totalPatients: [
                        { $group: { _id: "$patient" } },
                        { $count: "count" }
                    ],
                    bySpecialty: [
                        {
                            $group: {
                                _id: "$specialty",
                                scheduled: { $sum: 1 },
                                completed: {
                                    $sum: {
                                        $cond: [{ $eq: ["$operationalStatus", "confirmed"] }, 1, 0]
                                    }
                                },
                                canceled: {
                                    $sum: {
                                        $cond: [{ $eq: ["$operationalStatus", "canceled"] }, 1, 0]
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        ]);

        const result = {
            today: stats[0]?.today[0]?.count || 0,
            confirmed: stats[0]?.confirmed[0]?.count || 0,
            totalPatients: stats[0]?.totalPatients[0]?.count || 0,
            specialties: []
        };

        const specialtyStats = stats[0]?.bySpecialty || [];

        for (const [name, config] of Object.entries(specialtiesConfig)) {
            const stat = specialtyStats.find(s => s._id === name) || {
                scheduled: 0,
                completed: 0,
                canceled: 0
            };

            const revenue = stat.completed * config.price;

            result.specialties.push({
                ...config,
                stats: {
                    scheduled: stat.scheduled || 0,
                    completed: stat.completed || 0,
                    canceled: stat.canceled || 0,
                    revenue: revenue || 0
                }
            });
        }

        res.json(result);

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            error: 'Erro interno',
            details: error.message
        });
    }
});

// Busca agendamentos com filtros
router.get('/', flexibleAuth, async (req, res) => {
    try {
        const { patientId, doctorId, status, specialty, startDate, endDate, excludePreAgendamentos, includePreAgendamentos } = req.query;
        const shouldIncludePreAgendamentos = includePreAgendamentos === 'true';

        const filter = {};
        let individualSessionId = null;
        let createdAppointmentId = null; // 👈 novo

        // 🔹 Filtros por paciente e médico
        if (patientId && patientId !== 'all' && mongoose.Types.ObjectId.isValid(patientId)) {
            // Resolver patientId: pode vir como ID da patients_view — buscar o ID real
            let resolvedPatientId = patientId;
            const patientExists = await mongoose.connection.db.collection('patients').findOne(
                { _id: new mongoose.Types.ObjectId(patientId) },
                { projection: { _id: 1 } }
            );
            if (!patientExists) {
                const viewDoc = await mongoose.connection.db.collection('patients_view').findOne(
                    { _id: new mongoose.Types.ObjectId(patientId) },
                    { projection: { patientId: 1 } }
                );
                if (viewDoc?.patientId) {
                    resolvedPatientId = viewDoc.patientId.toString();
                }
            }
            filter.patient = new mongoose.Types.ObjectId(resolvedPatientId);
        }
        if (doctorId && doctorId !== 'all' && mongoose.Types.ObjectId.isValid(doctorId)) {
            filter.doctor = new mongoose.Types.ObjectId(doctorId);
        }

        if (status && status !== 'all') {
            if (status === 'Confirmado') {
                filter.operationalStatus = { $in: ['confirmed', 'paid'] };
            } else if (status === 'Pendente') {
                filter.operationalStatus = { $in: ['scheduled', 'pending'] };
            } else if (status === 'Cancelado') {
                filter.operationalStatus = { $in: ['canceled', 'missed'] };
            }
        } else if (!shouldIncludePreAgendamentos) {
            // 🛡️ Por padrão, exclui pré-agendamentos pendentes e convertidos
            filter.operationalStatus = { $ne: 'pre_agendado' };
            filter.appointmentId = { $exists: false };
        }
        console.log('[GET /appointments] Filtro montado:', JSON.stringify(filter));
        if (specialty && specialty !== 'all') filter.specialty = specialty;

        // 🔹 Filtro por período
        // 🆕 CORREÇÃO: Converte strings para Date objects após migração do schema
        if (startDate && endDate) {
            const start = new Date(startDate + 'T00:00:00-03:00');
            const end = new Date(endDate + 'T23:59:59-03:00');
            filter.date = {
                $gte: start,
                $lte: end
            };
        }
        console.time('appointments.query');

        // 🔹 Buscar agendamentos com relacionamentos importantes (otimizado)
        // 🔸 Adiciona limite padrão para evitar carregar muitos dados
        const limit = parseInt(req.query.limit) || 500;
        const skip = parseInt(req.query.skip) || 0;

        // 🔹 Buscar agendamentos com relacionamentos importantes (otimizado)
        // Removido limit default para garantir que todos os appointments do período venham
        const appointments = await Appointment.find(filter)
            .limit(limit)
            .select('date time duration specialty notes responsible operationalStatus clinicalStatus paymentStatus visualFlag patient patientInfo professionalName doctor package session payment metadata billingType insuranceProvider insuranceValue authorizationCode serviceType sessionType sessionValue reason urgency assignedTo secretaryNotes')
            .populate({ path: 'doctor', select: 'fullName specialty email phoneNumber specialties' })
            .populate({ path: 'patient', select: '_id fullName dateOfBirth gender phone email cpf rg address' })
            .populate({ path: 'package', select: 'financialStatus totalPaid totalSessions balance sessionValue type liminarProcessNumber liminarCourt' })
            .populate({ path: 'session', select: 'isPaid paymentStatus partialAmount' })
            .populate({ path: 'payment', select: 'status amount paymentMethod' })
            .sort({ date: -1, time: 1 })
            .lean();
        console.log(`[GET /appointments] MongoDB retornou ${appointments.length} documentos`);

        // pre_agendados agora são Appointments — já incluídos na query acima

        // 🔹 Buscar saldos dos pacientes para mostrar no calendário
        const patientIds = appointments
            .map(appt => appt.patient?._id?.toString())
            .filter((id, index, arr) => id && arr.indexOf(id) === index);

        console.log(`[Calendar] ${patientIds.length} pacientes únicos para verificar saldo`);

        const patientBalances = await PatientBalance.find({
            patient: { $in: patientIds },
            currentBalance: { $gt: 0 }
        }).select('patient currentBalance').lean();

        console.log(`[Calendar] ${patientBalances.length} pacientes com saldo devedor`);

        // Map de patientId -> saldo para lookup rápido
        const balanceMap = patientBalances.reduce((map, bal) => {
            map[bal.patient.toString()] = bal.currentBalance;
            return map;
        }, {});

        // 🔹 Mapear agendamentos REAIS incluindo saldo
        // NOTA: Removido filtro que excluía appointments sem patient populado
        // O patient pode ser um ObjectId (não populado) se houver erro no populate
        const calendarEvents = appointments.map(appt => {
            const event = mapAppointmentToEvent(appt);
            const patientId = appt.patient?._id?.toString();
            if (patientId && balanceMap[patientId]) {
                event.patientBalance = balanceMap[patientId];
                event.patientHasDebt = true;
            }
            return event;
        });

        // 🔹 3. ORDENAR E RETORNAR
        const shouldExcludePreAgendamentos = excludePreAgendamentos === 'true';

        let finalResults = calendarEvents;
        if (shouldExcludePreAgendamentos) {
            finalResults = calendarEvents.filter(e => e.operationalStatus !== 'pre_agendado' && !e.appointmentId);
        }

        // Quando explicitamente incluir pré-agendamentos, mantém todos os status
        if (shouldIncludePreAgendamentos) {
            finalResults = calendarEvents;
        }

        finalResults.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));

        console.log(`[GET /appointments] Retornando ${finalResults.length} eventos`);
        res.json(finalResults);
    } catch (error) {
        console.error('Erro ao buscar agendamentos:', error);

        if (error.name === 'CastError') {
            return res.status(400).json({
                error: 'ID inválido',
                message: 'O formato do ID fornecido é inválido'
            });
        }

        res.status(500).json({
            error: 'Erro interno',
            details: error.message
        });
    }
});

// Busca agendamento por ID
router.get('/:id', flexibleAuth, async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const appointment = await Appointment.findById(id)
            .populate('patient', 'fullName phone email dateOfBirth')
            .populate('doctor', 'fullName specialty')
            .populate('package', 'totalSessions sessionsUsed')
            .populate('liminarContract', 'processNumber court totalCredit creditBalance usedCredit status mode')
            .populate('session', 'status paymentStatus')
            .populate('payment', 'status amount paymentMethod');

        if (!appointment) {
            return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });
        }

        res.json({ success: true, data: mapAppointmentDTO(appointment) });
    } catch (error) {
        console.error('[APPOINTMENT] Erro ao buscar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
