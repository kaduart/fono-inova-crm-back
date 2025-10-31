import moment from 'moment';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import MedicalEvent from '../models/MedicalEvent.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { distributePayments } from '../services/distributePayments.js';

import { syncEvent } from '../services/syncService.js';

const APPOINTMENTS_API_BASE_URL = 'http://167.234.249.6:5000/api';
const validateInputs = {
    sessionType: (type) => ['fonoaudiologia', 'terapia_ocupacional', 'psicologia', 'fisioterapia'].includes(type),
    paymentMethod: (method) => ['dinheiro', 'pix', 'cartão'].includes(method),
    paymentType: (type) => ['full', 'per-session', 'partial'].includes(type)
};

// Operações CRUD Completas
export const packageOperations = {
    create: async (req, res) => {
        const mongoSession = await mongoose.startSession();
        let transactionCommitted = false;

        try {
            await mongoSession.startTransaction();

            const {
                date,
                patientId,
                doctorId,
                specialty,
                paymentMethod,
                paymentType,
                durationMonths,
                sessionsPerWeek,
                sessionType,
                appointmentId,
                sessionValue,
                calculationMode,
                totalSessions,
                selectedSlots = [], // 💡 novo campo
                payments = []
            } = req.body;

            const paymentDate = req.body.paymentDate
                ? req.body.paymentDate
                : new Date().toISOString().split('T')[0];

            // ==========================================================
            // 1️⃣ VALIDAÇÕES BÁSICAS
            // ==========================================================
            if (!date || !patientId || !doctorId || !sessionType || !specialty || !sessionValue) {
                throw new Error('Campos obrigatórios não fornecidos');
            }
            if (!selectedSlots.length) {
                throw new Error('Nenhum horário selecionado (selectedSlots está vazio)');
            }

            // ==========================================================
            // 2️⃣ CONVERSÃO / REAPROVEITAMENTO DO PRIMEIRO SLOT EXISTENTE
            //     - Funciona com appointmentId explícito OU detecta automaticamente
            //       pelo primeiro selectedSlot (data/hora).
            // ==========================================================
            let existingAppointment = null;
            let replacedAppointmentId = null;
            let replacedSessionId = null;

            // 2.1) Caso explícito: veio appointmentId no body
            if (appointmentId) {
                existingAppointment = await Appointment.findById(appointmentId)
                    .populate('session')
                    .session(mongoSession);

                if (!existingAppointment) {
                    throw new Error('Agendamento a ser convertido não encontrado');
                }

                if (existingAppointment.session?._id) {
                    replacedSessionId = existingAppointment.session._id.toString();
                }

                // Remove appointment + eventual session antiga (vamos recriar limpo já vinculado ao pacote)
                await Appointment.deleteOne({ _id: appointmentId }).session(mongoSession);
                if (existingAppointment.session) {
                    await Session.deleteOne({ _id: existingAppointment.session._id }).session(mongoSession);
                }
                replacedAppointmentId = appointmentId;
            }

            // 2.2) Caso implícito: NÃO veio appointmentId → detectar pelo primeiro slot
            if (!existingAppointment && selectedSlots?.length > 0) {
                const firstSlot = selectedSlots[0];
                if (firstSlot?.date && firstSlot?.time) {
                    const toConvert = await Appointment.findOne({
                        patient: patientId,
                        doctor: doctorId,
                        date: firstSlot.date,
                        time: firstSlot.time,
                        status: { $ne: 'canceled' }
                    })
                        .populate('session')
                        .session(mongoSession);

                    // Achamos um agendamento "avulso" no mesmo horário da primeira sessão do pacote
                    if (toConvert) {
                        if (toConvert.session?._id) {
                            replacedSessionId = toConvert.session._id.toString(); // ⬅️ novo
                        }

                        // Remove appointment + eventual session antiga
                        await Appointment.deleteOne({ _id: toConvert._id }).session(mongoSession);
                        if (toConvert.session) {
                            await Session.deleteOne({ _id: toConvert.session._id }).session(mongoSession);
                        }
                        replacedAppointmentId = toConvert._id.toString();
                    }
                }
            }


            // ==========================================================
            // 3️⃣ CÁLCULO DE SESSÕES E VALORES
            // ==========================================================
            const numericSessionValue = Number(sessionValue) || 0;
            const numericSessionsPerWeek = Number(sessionsPerWeek) || selectedSlots.length;
            const numericDurationMonths = Number(durationMonths) || 0;
            const numericTotalSessions = Number(totalSessions) || 0;

            let finalTotalSessions, finalDurationMonths;
            if (calculationMode === 'sessions') {
                finalTotalSessions = numericTotalSessions;
                finalDurationMonths = Math.ceil(finalTotalSessions / ((numericSessionsPerWeek * 4) || 1));
            } else {
                finalTotalSessions = numericDurationMonths * 4 * numericSessionsPerWeek;
                finalDurationMonths = numericDurationMonths;
            }

            const totalValue = numericSessionValue * finalTotalSessions;

            // ==========================================================
            // 4️⃣ CRIAR O PACOTE
            // ==========================================================
            const newPackage = new Package({
                patient: patientId,
                doctor: doctorId,
                date,
                sessionType,
                specialty,
                sessionValue: numericSessionValue,
                totalSessions: finalTotalSessions,
                sessionsPerWeek: numericSessionsPerWeek,
                durationMonths: finalDurationMonths,
                paymentMethod,
                paymentType,
                totalValue,
                totalPaid: 0,
                balance: totalValue,
                status: 'active',
                calculationMode
            });

            await newPackage.save({ session: mongoSession });
            // 🔧 Reconciliação mínima de pagamentos herdados da sessão/appointment avulso
            if (replacedSessionId) {
                // 2.1) Deleta pendentes/abertos da sessão avulsa (evita o “extra”)
                await Payment.deleteMany(
                    {
                        session: replacedSessionId,
                        status: { $in: ['pending', 'unpaid'] },
                        serviceType: { $in: ['individual_session', 'evaluation'] }
                    },
                    { session: mongoSession }
                );

                // 2.2) Converte pagos da sessão avulsa em recibo do pacote (preserva histórico financeiro)
                await Payment.updateMany(
                    {
                        session: replacedSessionId,
                        status: 'paid',
                        serviceType: { $in: ['individual_session', 'evaluation'] }
                    },
                    {
                        $set: {
                            package: newPackage._id,
                            kind: 'package_receipt',
                            serviceType: 'package_session',
                            migratedFrom: { session: replacedSessionId }
                        },
                        $unset: { session: "", appointment: "" }
                    },
                    { session: mongoSession }
                );
            }

            // (opcional) reforço por appointment também:
            if (replacedAppointmentId) {
                await Payment.updateMany(
                    {
                        appointment: replacedAppointmentId,
                        status: { $in: ['pending', 'unpaid'] },
                        serviceType: { $in: ['individual_session', 'evaluation'] }
                    },
                    { $unset: { appointment: "" } },
                    { session: mongoSession }
                );

                await Payment.updateMany(
                    {
                        appointment: replacedAppointmentId,
                        status: 'paid',
                        serviceType: { $in: ['individual_session', 'evaluation'] }
                    },
                    {
                        $set: {
                            package: newPackage._id,
                            kind: 'package_receipt',
                            serviceType: 'package_session',
                            migratedFrom: { appointment: replacedAppointmentId }
                        },
                        $unset: { appointment: "" }
                    },
                    { session: mongoSession }
                );
            }


            await Patient.findByIdAndUpdate(patientId, { $addToSet: { packages: newPackage._id } }, { session: mongoSession });

            // ==========================================================
            // 5️⃣ GERAR SESSÕES E AGENDAMENTOS (com base em selectedSlots)
            // ==========================================================
            const sessionsToCreate = [];
            const appointmentsToCreate = [];

            for (const slot of selectedSlots) {
                if (!slot.date || !slot.time) continue;

                sessionsToCreate.push({
                    date: slot.date,
                    time: slot.time,
                    patient: patientId,
                    doctor: doctorId,
                    package: newPackage._id,
                    sessionValue: numericSessionValue,
                    sessionType,
                    specialty,
                    status: 'scheduled',
                    isPaid: false,
                    paymentStatus: 'pending',
                    visualFlag: 'pending',
                    paymentMethod
                });
            }



            // ==========================================================
            // 🚫 5.1️⃣ VALIDAÇÃO DE CONFLITOS COM SESSÕES EXISTENTES
            // ==========================================================
            for (const s of sessionsToCreate) {
                const conflict = await Session.findOne({
                    date: s.date,
                    time: s.time,
                    doctor: s.doctor,
                    patient: s.patient,
                    specialty: s.specialty,
                    status: { $ne: 'canceled' } // ignora canceladas
                }).lean();

                if (conflict) {
                    throw new Error(
                        `Conflito detectado: o paciente já possui uma sessão de ${s.specialty} com este profissional ` +
                        `no dia ${moment(s.date).format('DD/MM/YYYY')} às ${s.time}.`
                    );
                }
            }


            const insertedSessions = await Session.insertMany(sessionsToCreate, { session: mongoSession });

            for (const s of insertedSessions) {
                appointmentsToCreate.push({
                    patient: patientId,
                    doctor: doctorId,
                    date: s.date,
                    time: s.time,
                    duration: 40,
                    specialty,
                    session: s._id,
                    package: newPackage._id,
                    serviceType: 'package_session',
                    operationalStatus: 'scheduled',
                    clinicalStatus: 'pending',
                    paymentStatus: 'pending'
                });
            }

            const seen = new Set();
            const uniqueAppointments = [];

            for (const a of appointmentsToCreate) {
                const key = `${a.date}-${a.time}-${a.patient}-${a.doctor}`;

                if (!seen.has(key)) {
                    seen.add(key);
                    uniqueAppointments.push(a);
                } else {
                    console.warn(`⛔ Sessão duplicada ignorada: ${key}`);
                }
            }

            if (appointmentsToCreate.length !== uniqueAppointments.length) {
                console.warn(`⚠️ Detectadas ${appointmentsToCreate.length - uniqueAppointments.length} duplicatas internas antes do insert.`);
            }

            const insertedAppointments = await Appointment.insertMany(uniqueAppointments, { session: mongoSession });


            // 🔗 Vincula sessions e appointments com base em data/hora (não pelo índice)
            const appointmentMap = new Map(
                insertedAppointments.map(a => [`${a.date}-${a.time}-${a.patient}-${a.doctor}`, a._id])
            );
            console.log('Sessions:', insertedSessions.length, 'Appointments:', insertedAppointments.length);


            await Session.bulkWrite(
                insertedSessions.map(s => {
                    const key = `${s.date}-${s.time}-${s.patient}-${s.doctor}`;
                    const appId = appointmentMap.get(key);

                    if (!appId) {
                        console.warn(`⚠️ Sessão sem appointment correspondente (${key}) — será ignorada no link.`);
                        return { updateOne: { filter: { _id: s._id }, update: {} } }; // noop
                    }

                    return {
                        updateOne: {
                            filter: { _id: s._id },
                            update: { $set: { appointmentId: appId } }
                        }
                    };
                }),
                { session: mongoSession }
            );


            // ==========================================================
            // 6️⃣ PAGAMENTOS
            // ==========================================================
            let amountPaid = 0;
            const paymentDocs = [];

            for (const p of payments) {
                const value = Number(p.amount) || 0;
                if (value <= 0) continue;

                const paymentDoc = new Payment({
                    package: newPackage._id,
                    patient: patientId,
                    doctor: doctorId,
                    amount: value,
                    paymentMethod: p.method,
                    paymentDate: p.date || new Date(),
                    kind: 'package_receipt',
                    status: 'paid',
                    serviceType: 'package_session',
                    notes: p.description || 'Pagamento do pacote'
                });

                await paymentDoc.save({ session: mongoSession });
                paymentDocs.push(paymentDoc);
                newPackage.payments.push(paymentDoc._id);
                newPackage.totalPaid += value;
                amountPaid += value;
            }

            // 🧩 Sanitização garantida antes do cálculo
            if (isNaN(newPackage.totalValue) || newPackage.totalValue === undefined || newPackage.totalValue === null) {
                newPackage.totalValue = 0;
            }
            if (isNaN(newPackage.totalPaid) || newPackage.totalPaid === undefined || newPackage.totalPaid === null) {
                newPackage.totalPaid = 0;
            }

            newPackage.balance = newPackage.totalValue - newPackage.totalPaid;
            newPackage.financialStatus =
                newPackage.balance <= 0 ? 'paid' :
                    newPackage.totalPaid > 0 ? 'partially_paid' : 'unpaid';

            // 🔢 Soma dos pagos migrados (sessão/appointment avulsos convertidos)
            const migratedPaid = await Payment.aggregate([
                {
                    $match: {
                        package: newPackage._id,
                        status: 'paid',
                        kind: 'package_receipt',
                        serviceType: 'package_session',
                        migratedFrom: { $exists: true }            // ⬅️ só os que acabamos de migrar
                    }
                },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]).session(mongoSession);

            const migratedTotal = migratedPaid?.[0]?.total || 0;

            // Atualiza o array de payments do pacote (IDs migrados)
            const migratedIds = await Payment.find({
                package: newPackage._id,
                status: 'paid',
                kind: 'package_receipt',
                serviceType: 'package_session',
                migratedFrom: { $exists: true }
            }, { _id: 1 }).session(mongoSession);

            if (migratedIds.length) {
                await Package.updateOne(
                    { _id: newPackage._id },
                    { $addToSet: { payments: { $each: migratedIds.map(p => p._id) } } },
                    { session: mongoSession }
                );
            }

            // Agora some no totalPaid do pacote ANTES da finalização
            newPackage.totalPaid = (newPackage.totalPaid || 0) + migratedTotal;
            newPackage.balance = (newPackage.totalValue || 0) - (newPackage.totalPaid || 0);
            newPackage.financialStatus =
                newPackage.balance <= 0 ? 'paid' :
                    newPackage.totalPaid > 0 ? 'partially_paid' : 'unpaid';
            await newPackage.save({ session: mongoSession });

            await newPackage.save({ session: mongoSession });

            // ==========================================================
            // 7️⃣ FINALIZAÇÃO
            // ==========================================================
            await mongoSession.commitTransaction();
            transactionCommitted = true;

            // 🔹 Atualiza o pacote com todas as referências
            await Package.findByIdAndUpdate(newPackage._id, {
                $set: {
                    sessions: insertedSessions.map(s => s._id),
                    appointments: insertedAppointments.map(a => a._id),
                },
            });

            // 🔹 Recarrega o pacote completo para garantir consistência
            const freshPackage = await Package.findById(newPackage._id)
                .populate('sessions appointments payments')
                .lean();

            await syncEvent(freshPackage, 'package');

            // 🕐 Aguarda propagação de visibilidade do Mongo (garante que inserts estejam visíveis)
            await new Promise(resolve => setTimeout(resolve, 250));

            // 🔁 Recarrega o pacote direto do banco, sem cache e com todas as sessões visíveis
            const reloadedPackage = await Package.findById(newPackage._id)
                .lean();

            // 💸 Distribui também o valor migrado (pagos convertidos do avulso → pacote)
            if (migratedTotal > 0) {
                try {
                    await distributePayments(reloadedPackage._id, migratedTotal, null, null);
                } catch (e) {
                    console.error(`⚠️ Erro ao distribuir valor migrado:`, e.message);
                }
            }


            // 💰 Distribui pagamentos após garantir consistência total
            for (const p of paymentDocs) {
                try {
                    await distributePayments(reloadedPackage._id, p.amount, null, p._id);
                } catch (e) {
                    console.error(`⚠️ Erro ao distribuir pagamento ${p._id}:`, e.message);
                }
            }


            // 🔹 Retorna pacote atualizado
            const result = await Package.findById(reloadedPackage._id)
                .populate('sessions appointments payments')
                .lean();


            res.status(201).json({
                success: true,
                data: result,
                replacedAppointment: appointmentId || null,
            });
        } catch (error) {
            if (mongoSession?.inTransaction() && !transactionCommitted) {
                await mongoSession.abortTransaction();
            }

            if (error.message.includes('Conflito detectado')) {
                return res.status(409).json({
                    success: false,
                    message: error.message,
                    errorCode: 'SESSION_CONFLICT'
                });
            }

            if (error.code === 11000 && error.message.includes('unique_appointment')) {
                const dateMatch = error.message.match(/date:\s+"([^"]+)"/);
                const timeMatch = error.message.match(/time:\s+"([^"]+)"/);

                const date = dateMatch ? dateMatch[1] : 'data desconhecida';
                const time = timeMatch ? timeMatch[1] : 'horário desconhecido';

                // 👉 Envia HTML direto
                const detailedMessage = `Já existe um agendamento para este paciente no dia ${date} às ${time}.`;

                return res.status(400).json({
                    success: false,
                    message: detailedMessage,
                    errorCode: 'DUPLICATE_APPOINTMENT'
                });
            }

            console.error('❌ Erro ao criar agendamento/pacote:', error);

            return res.status(500).json({
                success: false,
                message: 'Erro ao criar agendamento ou pacote. Tente novamente.',
                errorCode: 'PACKAGE_CREATION_ERROR'
            });
        } finally {
            await mongoSession.endSession();
        }
    },

    get: {
        all: async (req, res) => {
            try {
                const { patientId } = req.query;

                if (!patientId) {
                    return res.status(400).json({ message: 'ID do paciente é obrigatório.' });
                }

                const packages = await Package.find({ patient: patientId })
                    .populate({
                        path: 'sessions',
                    })
                    .populate({
                        path: 'payments',
                    })
                    .populate('patient')
                    .populate({
                        path: 'doctor',
                        model: 'Doctor',
                        select: '_id fullName specialty',
                    })
                    .lean();

                const enhancedPackages = packages.map(pkg => {
                    return {
                        ...pkg,
                        date: pkg.date,
                        time: pkg.time,
                        sessions: pkg.sessions?.map(session => ({
                            ...session,
                            // Mantém as datas originais das sessões
                            date: session.date, // "YYYY-MM-DD"
                            time: session.time, // "HH:mm"
                        })) || [],
                        remaining: pkg.totalSessions - pkg.sessionsDone,
                        totalValue: pkg.sessionValue * pkg.totalSessions,
                    };
                });

                res.status(200).json(enhancedPackages);
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

                console.error('Erro ao buscar pacotes:', error);
                return res.status(500).json({
                    error: 'Erro interno no servidor',
                    details: error.message
                });
            }
        },
        byId: async (req, res) => {
            try {
                const pkg = await Package.findById(req.params.id)
                    .populate('patient', 'name');
                if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
                res.json(pkg);
            } catch (error) {
                if (error.name === 'ValidationError') {
                    // 💡 Extrai erros campo a campo
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
        },
        search: async (req, res) => {
            try {
                const { status, type, startDate, endDate } = req.query;
                const filters = {};

                if (status) filters.status = status;
                if (type) filters.type = type;
                if (startDate && endDate) {
                    filters.createdAt = {
                        $gte: new Date(startDate),
                        $lte: new Date(endDate)
                    };
                }

                const packages = await Package.find(filters)
                    .populate('sessions payments')
                    .lean();

                res.status(200).json(packages);
            } catch (error) {
                if (error.name === 'ValidationError') {
                    // 💡 Extrai erros campo a campo
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
        },
    },

    // Atualizar
    update: {
        package: async (req, res) => {
            try {
                const { version } = req.body;
                const packageId = req.params.id;

                // Verificar conflito de versão
                const currentPackage = await Package.findById(packageId);
                if (currentPackage.version !== version) {
                    return res.status(409).json({
                        error: 'Conflito de versão',
                        message: 'O pacote foi modificado por outro usuário. Por favor, recarregue os dados.'
                    });
                }

                // Atualizar com incremento de versão
                const updated = await Package.findByIdAndUpdate(
                    packageId,
                    { ...req.body, $inc: { version: 1 } },
                    { new: true, runValidators: true }
                );

                res.json(updated);
            } catch (error) {
                if (error.name === 'ValidationError') {
                    // 💡 Extrai erros campo a campo
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
        },
        session: async (req, res) => {
            const mongoSession = await mongoose.startSession();
            let transactionCommitted = false;

            try {
                await mongoSession.startTransaction();

                const { sessionId } = req.params;
                const {
                    date,
                    time,
                    notes,
                    doctorId,
                    patientId,
                    status,
                    confirmedAbsence,
                    payment = {},
                    sessionType,
                    serviceType,
                    specialty
                } = req.body;

                // Validações básicas
                if (!date || isNaN(Date.parse(date))) throw new Error("Data inválida ou não fornecida");
                if (!time || !/^\d{2}:\d{2}$/.test(time)) throw new Error("Hora inválida ou não fornecida");
                if (status && !['pending', 'completed', 'canceled', 'scheduled'].includes(status)) {
                    throw new Error("Status inválido. Valores permitidos: pending, completed, canceled, scheduled");
                }
                if (status === 'canceled' && confirmedAbsence === undefined) {
                    throw new Error("Para sessões canceladas, 'confirmedAbsence' é obrigatório");
                }

                // Buscar sessão
                const sessionDoc = await Session.findById(sessionId)
                    .populate({
                        path: 'package',
                        select: 'sessionType sessionsPerWeek doctor patient sessionValue totalSessions totalPaid sessionsDone status'
                    })
                    .populate('appointmentId')
                    .session(mongoSession);

                if (!sessionDoc) throw new Error("Sessão não encontrada");

                const previousStatus = sessionDoc.status;

                // Atualiza campos da sessão
                sessionDoc.date = date;
                sessionDoc.time = time;
                sessionDoc.notes = notes ?? sessionDoc.notes;
                if (doctorId) sessionDoc.doctor = doctorId;
                if (patientId) sessionDoc.patient = patientId;
                if (status) sessionDoc.status = status;
                if (sessionType) sessionDoc.sessionType = sessionType;
                if (!sessionType && specialty) sessionDoc.sessionType = specialty;

                // Atualiza confirmedAbsence
                if (confirmedAbsence !== undefined) {
                    sessionDoc.confirmedAbsence = confirmedAbsence;
                    if (status !== 'canceled') sessionDoc.confirmedAbsence = null;
                }

                // Funções auxiliares para status do agendamento
                const getOperationalStatus = (s) => {
                    if (s === 'completed') return 'confirmed'; // ✅ inglês
                    if (s === 'canceled') return 'canceled';
                    return 'scheduled';
                };

                const getClinicalStatus = (s, confirmed) => {
                    if (s === 'completed') return 'completed'; // ✅ inglês
                    if (s === 'canceled') return confirmed ? 'missed' : 'canceled';
                    return 'pending';
                };


                // 1. Ajuste de pacote
                if (sessionDoc.package) {
                    const pkgId = sessionDoc.package._id;

                    if (previousStatus !== 'completed' && status === 'completed') {
                        // Incrementa sessionsDone
                        const updatedPackage = await Package.findByIdAndUpdate(
                            pkgId,
                            { $inc: { sessionsDone: 1 } },
                            { new: true, session: mongoSession }
                        );

                        // Marca pacote como finished se necessário
                        if (updatedPackage.sessionsDone >= updatedPackage.totalSessions) {
                            await Package.findByIdAndUpdate(pkgId, { status: 'finished' }, { session: mongoSession });
                        }

                        // Cria pagamento automático se não pago
                        if (!sessionDoc.isPaid) {
                            const paymentDoc = new Payment({
                                patient: sessionDoc.patient,
                                doctor: sessionDoc.doctor,
                                serviceType: 'package_session',
                                amount: sessionDoc.value,
                                paymentMethod: sessionDoc.paymentMethod,
                                session: sessionDoc._id,
                                package: pkgId,
                                serviceDate: sessionDoc.date,
                                status: 'paid'
                            });
                            await paymentDoc.save({ session: mongoSession });
                            sessionDoc.isPaid = true;
                        }

                    } else if (previousStatus === 'completed' && status !== 'completed') {
                        // Decrementa sessionsDone
                        const updatedPackage = await Package.findByIdAndUpdate(
                            pkgId,
                            { $inc: { sessionsDone: -1 } },
                            { new: true, session: mongoSession }
                        );

                        if (updatedPackage.status === 'finished' && updatedPackage.sessionsDone < updatedPackage.totalSessions) {
                            await Package.findByIdAndUpdate(pkgId, { status: 'active' }, { session: mongoSession });
                        }
                    }
                }

                // 2. Atualiza ou cria appointment
                if (sessionDoc.appointmentId) {
                    const appointment = await Appointment.findById(sessionDoc.appointmentId._id)
                        .session(mongoSession);
                    if (appointment) {
                        appointment.patient = sessionDoc.patient;
                        appointment.doctor = sessionDoc.doctor;
                        appointment.date = date;
                        appointment.time = time;
                        appointment.duration = 40;
                        appointment.specialty = sessionDoc.sessionType;
                        appointment.operationalStatus = getOperationalStatus(sessionDoc.status);
                        appointment.clinicalStatus = getClinicalStatus(sessionDoc.status, sessionDoc.confirmedAbsence);
                        appointment.sessionType = sessionDoc.sessionType;
                        appointment.serviceType = serviceType;
                        appointment.session = sessionDoc._id;
                        await appointment.save({ session: mongoSession });
                    }
                } else {
                    const appointment = new Appointment({
                        patient: sessionDoc.patient,
                        doctor: sessionDoc.doctor,
                        date,
                        time,
                        duration: 40,
                        specialty: sessionDoc.sessionType,
                        operationalStatus: getOperationalStatus(sessionDoc.status),
                        clinicalStatus: getClinicalStatus(sessionDoc.status, sessionDoc.confirmedAbsence),
                        session: sessionDoc._id,
                        serviceType: serviceType,
                        sessionType: sessionDoc.sessionType
                    });
                    await appointment.save({ session: mongoSession });
                    sessionDoc.appointmentId = appointment._id;
                }

                // Salva sessão atualizada
                await sessionDoc.save({ session: mongoSession });

                // Commit da transação
                await mongoSession.commitTransaction();
                transactionCommitted = true;

                // Retorna dados atualizados
                const updatedSession = await Session.findById(sessionId)
                    .populate({
                        path: 'package',
                        populate: { path: 'payments' }
                    })
                    .populate('doctor patient')
                    .populate('appointmentId');

                res.json({ success: true, session: updatedSession, package: updatedSession.package });

            } catch (error) {
                console.error("Erro na atualização da sessão:", error);
                if (!transactionCommitted && mongoSession.inTransaction()) {
                    await mongoSession.abortTransaction();
                }
                res.status(500).json({ success: false, error: error.message });
            } finally {
                await mongoSession.endSession();
            }
        }

    },

    delete: {
        package: async (req, res) => {
            const session = await mongoose.startSession();
            try {
                await session.startTransaction();

                const packageId = req.params.id;

                // 1. Buscar o pacote para obter referências
                const packageDoc = await Package.findById(packageId)
                    .session(session);

                if (!packageDoc) {
                    return res.status(404).json({ error: 'Pacote não encontrado' });
                }

                // 2. Coletar todos os IDs relacionados
                const sessionIds = packageDoc.sessions || [];
                const paymentIds = packageDoc.payments || [];

                // 3. Obter IDs de agendamentos associados às sessões
                const sessions = await Session.find({ _id: { $in: sessionIds } })
                    .select('appointmentId')
                    .session(session);

                const appointmentIds = sessions
                    .map(s => s.appointmentId)
                    .filter(id => id);

                // 4. Deletar em cascata - Ordem correta para evitar erros de chave estrangeira
                // a. Deletar agendamentos
                if (appointmentIds.length > 0) {
                    await Appointment.deleteMany({
                        _id: { $in: appointmentIds }
                    }).session(session);
                }

                // b. Deletar sessões
                if (sessionIds.length > 0) {
                    await Session.deleteMany({
                        _id: { $in: sessionIds }
                    }).session(session);
                }

                // c. Deletar pagamentos
                if (paymentIds.length > 0) {
                    await Payment.deleteMany({
                        _id: { $in: paymentIds }
                    }).session(session);
                }

                // d. Deletar o pacote principal
                await Package.deleteOne({ _id: packageId }).session(session);

                // 🔹 Remover referência do pacote do paciente
                await Patient.findByIdAndUpdate(
                    packageDoc.patient,
                    { $pull: { packages: packageId } },
                    { session }
                );


                // 5. Deletar eventos médicos relacionados
                await MedicalEvent.deleteMany({
                    originalId: {
                        $in: [
                            packageId,
                            ...sessionIds,
                            ...appointmentIds,
                            ...paymentIds
                        ]
                    }
                }).session(session);

                await session.commitTransaction();
                res.status(204).send();

            } catch (error) {
                await session.abortTransaction();
                console.error('Erro ao deletar pacote:', error);

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

                res.status(500).json({
                    error: 'Erro interno',
                    details: process.env.NODE_ENV === 'development' ? error.message : undefined
                });
            } finally {
                await session.endSession();
            }
        },
        session: async (req, res) => {
            const session = await mongoose.startSession();
            try {
                await session.startTransaction();

                const { id: packageId, sessionId } = req.params;

                // 1. Buscar a sessão para obter referências
                const sessionDoc = await Session.findById(sessionId)
                    .session(session);

                if (!sessionDoc) {
                    return res.status(404).json({ error: 'Sessão não encontrada' });
                }

                // 2. Coletar IDs relacionados
                const appointmentId = sessionDoc.appointmentId;
                const paymentId = sessionDoc.paymentId; // assumindo que pode ter

                // 3. Deletar em cascata
                // a. Deletar agendamento se existir
                if (appointmentId) {
                    await Appointment.deleteOne({ _id: appointmentId })
                        .session(session);
                }

                // b. Deletar pagamento se existir
                if (paymentId) {
                    await Payment.deleteOne({ _id: paymentId })
                        .session(session);
                }

                // c. Deletar a sessão
                await Session.deleteOne({ _id: sessionId })
                    .session(session);

                // d. Remover referência no pacote
                await Package.findByIdAndUpdate(
                    packageId,
                    { $pull: { sessions: sessionId } },
                    { session }
                );

                // e. Deletar eventos médicos relacionados
                await MedicalEvent.deleteMany({
                    originalId: {
                        $in: [
                            sessionId,
                            appointmentId,
                            paymentId
                        ].filter(Boolean) // remove valores null/undefined
                    }
                }).session(session);

                await session.commitTransaction();
                res.status(204).send();

            } catch (error) {
                await session.abortTransaction();
                console.error('Erro ao deletar sessão:', error);

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

                res.status(500).json({
                    error: 'Erro interno',
                    details: process.env.NODE_ENV === 'development' ? error.message : undefined
                });
            } finally {
                await session.endSession();
            }
        }

    },

    // Operações Específicas
    addSession: async (req, res) => {
        try {
            const pkg = await Package.findByIdAndUpdate(
                req.params.id,
                { $push: { sessions: req.body } },
                { new: true, runValidators: true }
            );
            res.json(pkg);
        } catch (error) {
            if (error.name === 'ValidationError') {
                // 💡 Extrai erros campo a campo
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
    },

    /* 
    update.session e mais robusto e faz as mesma coisas
    useSession: async (req, res) => {
        const mongoSession = await mongoose.startSession();
        try {
            await mongoSession.startTransaction();
 
            // Extrair apenas os campos necessários
            const { sessionId, payment } = req.body;
            const { status } = req.body; // Novo campo para status
            // Validação reforçada
            if (!sessionId) throw new Error("ID da sessão é obrigatório.");
            if (!status) throw new Error("Status é obrigatório.");
            if (!['completed', 'canceled'].includes(status)) {
                throw new Error("Status inválido. Use 'completed' ou 'canceled'.");
            }
 
            // 1. Atualizar sessão com o status recebido
            const sessionDoc = await Session.findByIdAndUpdate(
                sessionId,
                { status },
                { new: true, session: mongoSession }
            ).populate('package');
 
            if (!sessionDoc) throw new Error("Sessão não encontrada.");
 
            // 2. Atualizar pacote apenas se for conclusão de sessão
            if (status === 'completed') {
                const updatedPackage = await Package.findByIdAndUpdate(
                    sessionDoc.package._id,
                    { $inc: { sessionsDone: 1 } },
                    { new: true, session: mongoSession }
                );
 
                // 3. Atualizar status do pacote
                const newPackageStatus = updatedPackage.sessionsDone >= updatedPackage.totalSessions
                    ? 'finished'
                    : 'active';
 
                await Package.findByIdAndUpdate(
                    sessionDoc.package._id,
                    { status: newPackageStatus },
                    { session: mongoSession }
                );
            }
 
            // 4. Atualizar agendamento associado
            if (sessionDoc.appointmentId) {
                const appointmentStatus = status === 'completed'
                    ? 'completed'
                    : 'canceled';
 
                await axios.patch(
                    `${APPOINTMENTS_API_BASE_URL}/appointments/${sessionDoc.appointmentId}`,
                    { status: appointmentStatus },
                    {
                        headers: { Authorization: req.headers.authorization },
                        timeout: 3000
                    }
                );
            }
 
            // 5. Processar pagamento apenas para sessões concluídas
            if (status === 'completed' && payment?.amount > 0) {
                if (!payment.method || !validateInputs.paymentMethod(payment.method)) {
                    throw new Error("Método de pagamento inválido.");
                }
 
                const newPayment = new Payment({
                    amount: payment.amount,
                    paymentMethod: payment.method,
                    package: sessionDoc.package._id,
                    session: sessionDoc._id,
                    patient: sessionDoc.package.patient,
                    doctor: sessionDoc.package.doctor
                });
 
                await newPayment.save({ session: mongoSession });
 
                // Atualizar sessão como paga
                await Session.findByIdAndUpdate(
                    sessionId,
                    { isPaid: true },
                    { session: mongoSession }
                );
 
                // Atualizar saldo do pacote
                await Package.findByIdAndUpdate(
                    sessionDoc.package._id,
                    {
                        $inc: { totalPaid: payment.amount },
                        balance: new Expression('sessionValue * totalSessions - totalPaid')
                    },
                    { session: mongoSession }
                );
            }
 
            await mongoSession.commitTransaction();
 
            // Buscar dados atualizados
            const finalPackage = await Package.findById(sessionDoc.package._id)
                .populate({
                    path: 'sessions',
                    match: { _id: sessionId },
                    select: 'date status doctor isPaid paymentAmount'
                })
                .populate('payments patient doctor');
 
            res.json({
                ...finalPackage.toObject(),
                updatedSession: finalPackage.sessions[0]
            });
 
        } catch (error) {
            await mongoSession.abortTransaction();
            console.error('Erro em useSession:', error);
 
            // Tratamento de erros aprimorado
            let statusCode = 500;
            let message = 'Erro interno';
 
            if (error.name === 'ValidationError') {
                statusCode = 400;
                message = 'Dados inválidos';
            } else if (error.response) {
                // Erro da API de agendamentos
                statusCode = error.response.status;
                message = `Erro no serviço de agendamentos: ${error.response.data.message || error.response.statusText}`;
            } else if (error.message.includes('não encontrada')) {
                statusCode = 404;
                message = error.message;
            } else if (error.message.includes('inválido')) {
                statusCode = 400;
                message = error.message;
            }
 
            res.status(statusCode).json({
                error: message,
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        } finally {
            await mongoSession.endSession();
        }
    }, */

    registerPayment: async (req, res) => {
        const mongoSession = await mongoose.startSession();
        try {
            await mongoSession.startTransaction();

            const { amount, paymentMethod, notes } = req.body;
            const packageId = req.params.id;

            if (!amount || !paymentMethod) {
                throw new Error("Valor e método de pagamento são obrigatórios.");
            }

            // 🔹 Buscar pacote existente
            const pkg = await Package.findById(packageId)
                .populate("sessions")
                .session(mongoSession);

            if (!pkg) throw new Error("Pacote não encontrado.");

            // 🔹 Criar pagamento principal (recibo do pacote)
            const paymentDoc = new Payment({
                package: pkg._id,
                patient: pkg.patient,
                doctor: pkg.doctor,
                amount: parseFloat(amount),
                paymentMethod,
                notes: notes || "Pagamento adicional registrado manualmente.",
                status: "paid",
                kind: "package_receipt",
                serviceType: "package_session",
                paymentDate: new Date(),
            });

            await paymentDoc.save({ session: mongoSession });

            // 🔹 Distribuir valor entre sessões pendentes
            const updatedPackage = await distributePayments(
                packageId,
                parseFloat(amount),
                mongoSession,
                paymentDoc._id // passa o recibo como parentPayment
            );

            // 🔹 Atualizar vínculos no pacote
            pkg.payments.push(paymentDoc._id);
            pkg.totalPaid = (pkg.totalPaid || 0) + parseFloat(amount);
            pkg.balance =
                pkg.totalSessions * pkg.sessionValue - pkg.totalPaid;
            pkg.financialStatus =
                pkg.balance <= 0
                    ? "paid"
                    : pkg.totalPaid > 0
                        ? "partially_paid"
                        : "unpaid";
            pkg.lastPaymentAt = new Date();

            await pkg.save({ session: mongoSession });

            // 🔹 Finalizar transação
            await mongoSession.commitTransaction();

            res.json({
                success: true,
                message: "Pagamento registrado e distribuído com sucesso.",
                payment: paymentDoc,
                updatedPackage,
            });
        } catch (error) {
            await mongoSession.abortTransaction();
            console.error("❌ Erro em registerPayment:", error);
            res.status(500).json({
                success: false,
                message: error.message || "Erro interno ao registrar pagamento.",
            });
        } finally {
            await mongoSession.endSession();
        }
    },

};

// Operação de Atualização de Status
export const updateStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const validStatus = ['active', 'finished', 'canceled'];

        if (!validStatus.includes(status)) {
            return res.status(400).json({ error: 'Status inválido' });
        }

        const updated = await Package.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true, runValidators: true }
        );

        res.json({
            _id: updated._id,
            status: updated.status,
            updatedAt: updated.updatedAt
        });
    } catch (error) {
        if (error.name === 'ValidationError') {
            // 💡 Extrai erros campo a campo
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
};

// Operação de Relatório
export const generateReport = async (req, res) => {
    try {
        const packages = await Package.find()
            .populate('patient', 'name')
            .lean();

        const reportData = packages.map(pkg => ({
            patient: pkg.patient.name,
            totalSessions: pkg.totalSessions,
            sessionsDone: pkg.sessions.length,
            totalPaid: pkg.totalPaid,
            balance: pkg.balance
        }));

        res.json(reportData);
    } catch (error) {
        if (error.name === 'ValidationError') {
            // 💡 Extrai erros campo a campo
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
};

export const getPackageById = async (req, res) => {
    try {
        const packages = await Package.findById(req.params.id)
            .populate('patient', 'name birthDate'); // Campos necessários

        if (!packages) return res.status(404).json({ error: 'Pacote não encontrado' });
        res.json(packages);
    } catch (error) {
        if (error.name === 'ValidationError') {
            // 💡 Extrai erros campo a campo
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
}

export const getPackageVersionHistory = async (req, res) => {
    try {
        const packageId = req.params.id;

        // Buscar histórico no MedicalEvent
        const event = await MedicalEvent.findOne({
            originalId: packageId,
            type: 'package'
        }).select('versionHistory');

        if (!event) {
            return res.status(404).json({ error: 'Histórico não encontrado' });
        }

        res.json(event.versionHistory);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
};

// Funções de validação
function isValidDateString(dateString) {
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(dateString)) return false;

    const date = new Date(dateString);
    return !isNaN(date.getTime());
}

function isValidTimeString(timeString) {
    const regex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    return regex.test(timeString);
}