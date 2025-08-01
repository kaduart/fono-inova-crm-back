import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import MedicalEvent from '../models/MedicalEvent.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { calculateSessionDates, isWeekend } from '../services/packageService.js';
import { syncEvent } from '../services/syncService.js';
import { extractTimeFromDateTime } from '../utils/horaFormat.js';

const APPOINTMENTS_API_BASE_URL = 'http://167.234.249.6:5000/api';
const validateInputs = {
    sessionType: (type) => ['fonoaudiologia', 'terapeuta ocupacional', 'psicologia', 'fisioterapia'].includes(type),
    paymentMethod: (method) => ['dinheiro', 'pix', 'cartão'].includes(method),
    paymentType: (type) => ['full', 'per-session', 'partial'].includes(type)
};

// Operações CRUD Completas
export const packageOperations = {
    create: async (req, res) => {
        const mongoSession = await mongoose.startSession();

        const {
            durationMonths,
            sessionsPerWeek,
            patientId,
            specialty,
            doctorId,
            paymentMethod,
            paymentType,
            sessionType,
            sessionValue,
            amountPaid,
            dateTime,
            time
        } = req.body;

        try {
            await mongoSession.startTransaction();
            const effectiveDateTime = dateTime || { date: new Date().toISOString().split('T')[0], time };

            // Substitua parseDateTime por esta implementação direta:
            const startDate = new Date(`${effectiveDateTime.date}T${effectiveDateTime.time}:00-03:00`); // GMT-3 (Brasília)

            // Extrai horas e minutos do time fornecido
            const [hours, minutes] = time.split(':').map(Number);

            const requiredFields = ['patientId', 'doctorId', 'sessionType', 'dateTime', 'time', 'paymentType', 'specialty'];
            const missingFields = requiredFields.filter(field => !req.body[field]);

            if (missingFields.length > 0) {
                throw new Error(`Campos obrigatórios faltando: ${missingFields.join(', ')}`);
            }

            // Validação de horário
            const hour = parseInt(time.split(':')[0]);
            if (hour < 8 || hour > 19) {
                throw new Error("Horário fora do expediente (8:00 às 19:00)");
            }

            // Validação de formato de tempo
            if (!time.match(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)) {
                throw new Error("Formato de horário inválido. Use HH:mm");
            }

            // ===== CÁLCULOS DO PACOTE =====
            const totalSessions = Math.floor(durationMonths * 4 * sessionsPerWeek);
            const totalPackageValue = sessionValue * totalSessions;

            // Validação de pagamento
            if (parseFloat(amountPaid) !== totalPackageValue) {
                throw new Error(`Pagamento incompleto. Valor total necessário: R$${totalPackageValue.toFixed(2)}`);
            }

            // Validação de duração
            if (durationMonths < 1 || durationMonths > 12) {
                throw new Error("Duração inválida (1-12 meses)");
            }

            // Validação de sessões por semana
            if (sessionsPerWeek < 1 || sessionsPerWeek > 5) {
                throw new Error("Sessões por semana inválidas (1-5)");
            }

            // Validação de data inicial
            if (isWeekend(startDate)) {
                throw new Error("A data inicial não pode ser no fim de semana");
            }

            const newPackage = new Package({
                patient: patientId,
                doctor: doctorId,
                sessionValue,
                sessionType,
                specialty,
                paymentType,
                paymentMethod,
                status: 'active',
                durationMonths: parseInt(durationMonths, 10),
                sessionsPerWeek: parseInt(sessionsPerWeek, 10),
                totalSessions,
                date: startDate,
                totalPaid: totalPackageValue,
                balance: 0
            });

            await newPackage.save({ session: mongoSession });
            await syncEvent(newPackage, 'package');

            // ===== CÁLCULO DE DATAS DAS SESSÕES =====
            const sessionDates = calculateSessionDates(
                new Date(startDate),
                totalSessions,
                sessionsPerWeek
            );

            // ===== PREPARAÇÃO DAS SESSÕES =====
            const sessionsToCreate = sessionDates.map((date, index) => ({
                date: date,
                time: time,
                specialty,
                session: `Sessão ${index + 1}`,
                sessionType,
                value: sessionValue,
                package: newPackage._id,
                status: 'scheduled',
                doctor: doctorId,
                patient: patientId,
                isPaid: true,
                paymentMethod: paymentMethod,
                confirmedAbsence: null
            }));
            // ===== CRIAÇÃO EM MASSA DAS SESSÕES =====
            const createdSessions = await Session.insertMany(sessionsToCreate, { session: mongoSession });

            // ===== VINCULA SESSÕES AO PACOTE =====
            newPackage.sessions = createdSessions.map(s => s._id);
            await newPackage.save({ session: mongoSession });

            // ===== CRIAÇÃO DOS AGENDAMENTOS =====
            const appointmentCreationPromises = createdSessions.map(async (session) => {
                // Verificação de conflito
                const sessionDateStart = new Date(session.date);
                sessionDateStart.setHours(0, 0, 0, 0);

                const sessionDateEnd = new Date(session.date);
                sessionDateEnd.setHours(23, 59, 59, 999);

                const existingAppointment = await Appointment.findOne({
                    patient: patientId,
                    doctor: doctorId,
                    date: { $gte: sessionDateStart, $lt: sessionDateEnd },
                    time: time,
                    operationalStatus: { $ne: 'cancelado' }
                }).session(mongoSession);

                if (existingAppointment) {
                    const patient = await Patient.findById(patientId).select('fullName').lean();
                    const doctor = await Doctor.findById(doctorId).select('fullName').lean();
                    throw new Error(
                        `Conflito de agendamento: ${patient.name} já tem sessão com ${doctor.name} em ${session.date.toLocaleDateString()} às ${time}`
                    );
                }

                // Criação do agendamento
                const appointment = new Appointment({
                    patient: patientId,
                    doctor: doctorId,
                    date: session.date,
                    duration: 40,
                    specialty: sessionType,
                    operationalStatus: 'agendado',
                    clinicalStatus: 'pendente',
                    session: session._id,
                    package: newPackage._id, // Vínculo direto ao pacote
                    serviceType: 'package_session',
                    sessionType: sessionType,
                    time: time,
                });

                const savedAppointment = await appointment.save({ session: mongoSession });

                // Atualiza sessão com ID do agendamento
                session.appointmentId = savedAppointment._id;
                return session.save({ session: mongoSession });
            });

            await Promise.all(appointmentCreationPromises);

            // ===== REGISTRO DO PAGAMENTO =====
            const paymentDoc = new Payment({
                package: newPackage._id,
                amount: totalPackageValue,
                paymentMethod: paymentMethod,
                patient: patientId,
                doctor: doctorId,
                serviceType: 'package_session',
                notes: 'Pagamento total do pacote',
                status: 'paid'
            });

            await paymentDoc.save({ session: mongoSession });

            // Atualizar pacote com o pagamento
            newPackage.payments = [paymentDoc._id];
            await newPackage.save({ session: mongoSession });

            await mongoSession.commitTransaction();

            // ===== RESPOSTA COM DADOS COMPLETOS =====
            const populatedPackage = await Package.findById(newPackage._id)
                .populate({
                    path: 'sessions',
                    select: 'date status doctor isPaid paymentMethod appointmentId'
                })
                .populate({
                    path: 'payments',
                    select: 'amount paymentMethod date notes status'
                })
                .populate('patient', 'name email phone')
                .populate('doctor', 'name specialty')
                .populate({
                    path: 'sessions.appointmentId',
                    model: 'Appointment',
                    select: '_id date time operationalStatus'
                });

            res.status(201).json({
                success: true,
                message: 'Pacote criado com sucesso',
                package: populatedPackage
            });

        } catch (error) {
            console.error('Erro ao criar pacote:', error);
            if (mongoSession.inTransaction()) {
                await mongoSession.abortTransaction();
            }

            // Tratamento de erros aprimorado
            let statusCode = 500;
            let errorMessage = error.message || 'Erro interno no servidor';
            let errorDetails = {};

            if (error.name === 'ValidationError') {
                statusCode = 400;
                Object.values(error.errors).forEach(err => {
                    errorDetails[err.path] = err.message;
                });
            } else if (error.message.includes('Conflito de agendamento')) {
                statusCode = 409;
            }

            res.status(statusCode).json({
                success: false,
                message: errorMessage,
                errors: errorDetails,
                errorCode: 'PACOTE_CREATION_ERROR'
            });
        } finally {
            await mongoSession.endSession();
        }
    },

    get: {
        all: async (req, res) => {
            console.log('bateuuuuuuuuuu ', req.body)
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

                const adjustTimezone = (utcDate) => {
                    if (!utcDate) return null;
                    return new Date(utcDate);
                };

                // Função para formatar data/horário
                const formatDateTime = (date) => {
                    if (!date) return null;
                    return {
                        date: date.toISOString().split('T')[0],
                        time: date.toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'America/Sao_Paulo'
                        }),
                        full: date.toLocaleString('pt-BR', {
                            timeZone: 'America/Sao_Paulo'
                        })
                    };
                };


                const enhancedPackages = packages.map(pkg => {
                    // Ajusta o fuso horário da data principal
                    const localPackageDate = adjustTimezone(pkg.date);
                    const formattedPackageDate = formatDateTime(localPackageDate);

                    // Ajusta o fuso horário das sessões
                    const adjustedSessions = pkg.sessions?.map(session => {
                        const localSessionDate = adjustTimezone(session.date);
                        const formattedSession = formatDateTime(localSessionDate);

                        return {
                            ...session,
                            date: localSessionDate,
                            formattedDate: formattedSession,
                            originalDate: session.date // Mantém a data original UTC
                        };
                    }) || [];

                    return {
                        ...pkg,
                        date: localPackageDate,
                        formattedDate: formattedPackageDate,
                        sessions: adjustedSessions,
                        remaining: pkg.totalSessions - pkg.sessionsDone,
                        totalValue: pkg.sessionValue * pkg.totalSessions,
                        originalTime: pkg.time // Mantém o horário original
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
            try {
                const mongoSession = await mongoose.startSession();
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
                    specialty
                } = req.body;

                console.log('timeeeeee', time)
                // Validações básicas
                if (!date || isNaN(new Date(date).getTime())) {
                    throw new Error("Data inválida ou não fornecida");
                }

                if (status && !['pending', 'completed', 'canceled', 'scheduled'].includes(status)) {
                    throw new Error("Status inválido. Valores permitidos: pending, completed, canceled, scheduled");
                }

                // Validação para sessões canceladas
                if (status === 'canceled' && confirmedAbsence === undefined) {
                    throw new Error("Para sessões canceladas, o campo 'confirmedAbsence' é obrigatório");
                }

                // Busca a sessão com transação
                const sessionDoc = await Session.findById(sessionId)
                    .populate({
                        path: 'package',
                        select: 'sessionType sessionsPerWeek doctor patient sessionValue totalSessions totalPaid sessionsDone status'
                    })
                    .populate('appointmentId')
                    .session(mongoSession);

                if (!sessionDoc) throw new Error("Sessão não encontrada");

                const previousStatus = sessionDoc.status;

                const dateOnly = date.split('T')[0];

                const sessionDate = new Date(`${dateOnly}T${time}:00-03:00`);

                sessionDoc.date = sessionDate;
                sessionDoc.time = time;
                sessionDoc.notes = notes || sessionDoc.notes;

                if (doctorId) {
                    sessionDoc.doctor = new mongoose.Types.ObjectId(doctorId);
                }

                if (patientId) {
                    sessionDoc.patient = patientId;
                }

                if (status) {
                    sessionDoc.status = status;
                }

                // Atualização do campo confirmedAbsence
                if (confirmedAbsence !== undefined) {
                    sessionDoc.confirmedAbsence = confirmedAbsence;
                    if (status !== 'canceled') {
                        sessionDoc.confirmedAbsence = null;
                    }
                }

                // Valor padrão para sessões canceladas
                if (status === 'canceled' && confirmedAbsence === undefined) {
                    if (sessionDoc.confirmedAbsence === undefined || sessionDoc.confirmedAbsence === null) {
                        sessionDoc.confirmedAbsence = false;
                    }
                }

                if (sessionType) {
                    sessionDoc.sessionType = sessionType;
                }

                // Usa specialty se sessionType não foi enviado
                if (!sessionType && specialty) {
                    sessionDoc.sessionType = specialty;
                }

                // 1. Verificar se o status mudou para 'completed'
                if (status === 'completed' && previousStatus !== 'completed') {
                    // Verificar se o pacote existe
                    if (!sessionDoc.package) {
                        throw new Error("Pacote não encontrado para esta sessão");
                    }

                    // Atualizar o pacote - incrementar sessionsDone
                    const updatedPackage = await Package.findByIdAndUpdate(
                        sessionDoc.package._id,
                        { $inc: { sessionsDone: 1 } },
                        { new: true, session: mongoSession }
                    );

                    // Verificar se o pacote foi concluído
                    if (updatedPackage.sessionsDone >= updatedPackage.totalSessions) {
                        await Package.findByIdAndUpdate(
                            updatedPackage._id,
                            { status: 'finished' },
                            { session: mongoSession }
                        );
                    }

                    // Registrar pagamento automático se necessário
                    if (!sessionDoc.isPaid) {
                        const payment = new Payment({
                            patient: sessionDoc.patient,
                            doctor: sessionDoc.doctor,
                            serviceType: 'session',
                            amount: sessionDoc.value,
                            paymentMethod: sessionDoc.paymentMethod,
                            session: sessionDoc._id,
                            package: sessionDoc.package,
                            status: 'paid'
                        });
                        await payment.save({ session: mongoSession });

                        const sessionsPaidCount = Math.floor(amountPaid / sessionValue);

                        if (sessionsPaidCount > 0) {
                            const sessionsToMarkAsPaid = await Session.find({
                                package: newPackage._id,
                                isPaid: false
                            })
                                .sort({ createdAt: 1 })
                                .limit(sessionsPaidCount)
                                .session(mongoSession);

                            if (sessionsToMarkAsPaid.length > 0) {
                                const sessionIdsToUpdate = sessionsToMarkAsPaid.map(s => s._id);
                                await Session.updateMany(
                                    { _id: { $in: sessionIdsToUpdate } },
                                    { $set: { isPaid: true, paymentMethod: paymentMethod } },
                                    { session: mongoSession }
                                );
                            }
                        }
                        sessionDoc.isPaid = true;
                        await sessionDoc.save({ session: mongoSession });
                    }
                }

                // 2. Verificar se o status foi alterado de 'completed' para outro status
                if (previousStatus === 'completed' && status !== 'completed') {
                    // Verificar se o pacote existe
                    if (!sessionDoc.package) {
                        throw new Error("Pacote não encontrado para esta sessão");
                    }

                    // Atualizar o pacote - decrementar sessionsDone
                    const updatedPackage = await Package.findByIdAndUpdate(
                        sessionDoc.package._id,
                        { $inc: { sessionsDone: -1 } },
                        { new: true, session: mongoSession }
                    );

                    // Reverter status se necessário
                    if (updatedPackage.status === 'finished' &&
                        updatedPackage.sessionsDone < updatedPackage.totalSessions) {
                        await Package.findByIdAndUpdate(
                            updatedPackage._id,
                            { status: 'active' },
                            { session: mongoSession }
                        );
                    }
                }

                // Preparar dados para agendamento
                const formattedTime = extractTimeFromDateTime(date);
                const getOperationalStatus = () => {
                    if (status === 'completed') return 'confirmado';
                    if (status === 'canceled') return 'cancelado';
                    return 'agendado';
                };

                const getClinicalStatus = () => {
                    if (status === 'completed') return 'concluído';
                    if (status === 'canceled') {
                        return confirmedAbsence ? 'faltou' : 'cancelado';
                    }
                    return 'pendente';
                };

                // Gerenciamento de agendamento
                if (sessionDoc.appointmentId) {
                    // Atualização de agendamento existente
                    const appointment = await Appointment.findById(sessionDoc.appointmentId._id)
                        .session(mongoSession);

                    if (appointment) {
                        appointment.patient = patientId || sessionDoc.patient;
                        appointment.doctor = doctorId || sessionDoc.doctor;
                        appointment.date = sessionDate;
                        appointment.time = time;
                        appointment.duration = 40;
                        appointment.specialty = sessionType || sessionDoc.sessionType;
                        appointment.operationalStatus = getOperationalStatus();
                        appointment.clinicalStatus = getClinicalStatus();
                        appointment.session = sessionDoc._id;
                        appointment.sessionType = sessionType || sessionDoc.sessionType;
                        appointment.time = formattedTime;

                        await appointment.save({ session: mongoSession });
                    }
                } else {
                    // Criação de novo agendamento
                    const appointment = new Appointment({
                        patient: patientId || sessionDoc.patient,
                        doctor: doctorId || sessionDoc.doctor,
                        date: sessionDate,
                        duration: 40,
                        specialty: sessionType || sessionDoc.sessionType,
                        operationalStatus: getOperationalStatus(),
                        clinicalStatus: getClinicalStatus(),
                        session: sessionDoc._id,
                        sessionType: sessionType || sessionDoc.sessionType,
                        time: formattedTime
                    });

                    await appointment.save({ session: mongoSession });
                    sessionDoc.appointmentId = appointment._id;
                }

                // Salvar sessão atualizada
                await sessionDoc.save({ session: mongoSession });

                // SINCRONIZAÇÃO COM O MODELO UNIFICADO - PONTO CRÍTICO!
                // 1. Recarregar a sessão com dados populados
                const syncedSession = await Session.findById(sessionId).lean();

                // 2. Sincronizar a sessão
                await syncEvent(syncedSession, 'session');

                // 3. Se houver appointment associado, sincronizá-lo também
                if (syncedSession.appointmentId) {
                    const appointment = await Appointment.findById(syncedSession.appointmentId._id)
                        .session(mongoSession);
                    await syncEvent(appointment, 'appointment');
                }

                await mongoSession.commitTransaction();

                // Buscar dados completos para resposta
                const updatedSession = await Session.findById(sessionId)
                    .populate({
                        path: 'package',
                        populate: { path: 'payments' }
                    })
                    .populate('doctor patient')
                    .populate('appointmentId');

                res.json({
                    success: true,
                    session: updatedSession,
                    package: updatedSession.package
                });

            } catch (error) {
                console.error("Erro na atualização da sessão:", error);
                if (mongoSession.inTransaction()) {
                    await mongoSession.abortTransaction();
                }

                const statusCode = error.name === 'ValidationError' ? 400 : 500;

                res.status(statusCode).json({
                    success: false,
                    error: error.message,
                    details: process.env.NODE_ENV === 'development' ? error.stack : undefined
                });
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
            try {
                const pkg = await Package.findByIdAndUpdate(
                    req.params.id,
                    { $pull: { sessions: { _id: req.params.sessionId } } },
                    { new: true }
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
        const packageId = req.params.id;
        try {
            mongoSession.startTransaction();
            const {
                amount,
                paymentMethod,
                // coveredSessions, // Se você ainda usa isso, precisará de lógica adicional
                notes,
                // Adicione patient e doctor se forem necessários no Payment e não derivados do pacote
                // patient, 
                // doctor 
            } = req.body;

            if (!amount || !paymentMethod) {
                throw new Error("Valor e método de pagamento são obrigatórios.");
            }

            const pkg = await Package.findById(packageId).session(mongoSession);
            if (!pkg) {
                throw new Error("Pacote não encontrado");
            }

            // Lógica para coveredSessions removida para simplificar, 
            // pois o pagamento agora é um documento próprio e pode ou não estar ligado a sessões específicas.
            // Se precisar vincular a sessões, o modelo Payment precisaria de um array de sessionIds.

            const paymentData = {
                package: pkg._id,
                amount: parseFloat(amount),
                paymentMethod: paymentMethod,
                patient: patient || pkg.patient,
                doctor: doctor || pkg.doctor,
                notes: notes || 'Pagamento avulso para o pacote.'
            };

            const newPaymentDoc = new Payment(paymentData);
            await newPaymentDoc.save({ session: mongoSession });

            pkg.payments.push(newPaymentDoc._id);
            pkg.totalPaid = (pkg.totalPaid || 0) + parseFloat(amount);
            await pkg.save({ session: mongoSession });

            await mongoSession.commitTransaction();

            const updatedPackage = await Package.findById(packageId)
                .populate('patient', 'fullName')
                .populate('doctor', 'fullName')
                .populate('payments');

            res.json(updatedPackage);

        } catch (error) {
            if (mongoSession.inTransaction()) {
                await mongoSession.abortTransaction();
            }
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
        } finally {
            await mongoSession.endSession();
        }
    },
};

function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

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