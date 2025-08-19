import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import MedicalEvent from '../models/MedicalEvent.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

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
                time,
                patientId,
                doctorId,
                specialty,
                paymentMethod,
                paymentType = 'full',
                durationMonths = 1,
                sessionsPerWeek = 1,
                sessionType,
                appointmentId, // ID do appointment existente que será convertido
                sessionValue,
                amountPaid = sessionValue
            } = req.body;

            // 1. VALIDAÇÕES BÁSICAS
            if (!date || !time || !patientId || !doctorId || !sessionType || !specialty || !sessionValue) {
                throw new Error('Campos obrigatórios não fornecidos');
            }

            // 2. BUSCAR O APPOINTMENT EXISTENTE (se fornecido)
            let existingAppointment = null;
            if (appointmentId) {
                existingAppointment = await Appointment.findById(appointmentId)
                    .populate('session')
                    .session(mongoSession);

                if (!existingAppointment) {
                    throw new Error('Agendamento a ser convertido não encontrado');
                }

                // 3. REMOVER O APPOINTMENT/SESSION EXISTENTE
                await Appointment.deleteOne({ _id: appointmentId }).session(mongoSession);
                if (existingAppointment.session) {
                    await Session.deleteOne({ _id: existingAppointment.session._id }).session(mongoSession);
                }
            }

            // 4. CRIAR PACOTE (usando o mesmo horário do appointment original)
            const totalSessions = durationMonths * 4 * sessionsPerWeek;
            const totalValue = sessionValue * totalSessions;

            const newPackage = new Package({
                patient: patientId,
                doctor: doctorId,
                date: date,
                time: time, // Mantém o mesmo horário original
                sessionType,
                specialty,
                sessionValue,
                totalSessions,
                sessionsPerWeek,
                durationMonths,
                paymentMethod,
                paymentType,
                totalValue,
                totalPaid: amountPaid,
                balance: amountPaid - totalValue,
                status: 'active'
            });

            await newPackage.save({ session: mongoSession });

            // 5. CRIAR SESSÕES (a primeira no mesmo horário do appointment original)
            const createdSessions = [];
            const sessionDates = [];
            let currentDate = new Date(date);

            for (let i = 0; i < totalSessions; i++) {
                sessionDates.push(new Date(currentDate));
                currentDate.setDate(currentDate.getDate() + Math.floor(7 / sessionsPerWeek));
            }

            for (let i = 0; i < totalSessions; i++) {
                const sessionDate = sessionDates[i].toISOString().split('T')[0];
                const sessionTime = i === 0 ? time : existingAppointment?.time || time; // Mantém o horário original na primeira sessão

                const newSession = new Session({
                    date: sessionDate,
                    time: sessionTime,
                    patient: patientId,
                    doctor: doctorId,
                    package: newPackage._id,
                    sessionValue,
                    sessionType,
                    specialty,
                    status: 'scheduled',
                    isPaid: paymentType === 'full',
                    paymentMethod,
                    sessionNumber: i + 1
                });

                await newSession.save({ session: mongoSession });

                const newAppointment = new Appointment({
                    patient: patientId,
                    doctor: doctorId,
                    date: sessionDate,
                    time: sessionTime,
                    duration: 40,
                    specialty,
                    session: newSession._id,
                    package: newPackage._id,
                    serviceType: 'package_session',
                    operationalStatus: 'agendado'
                });

                await newAppointment.save({ session: mongoSession });

                await Session.findByIdAndUpdate(
                    newSession._id,
                    { appointmentId: newAppointment._id },
                    { session: mongoSession }
                );

                createdSessions.push(newSession._id);
            }

            // 6. ATUALIZAR PACOTE COM SESSÕES
            await Package.findByIdAndUpdate(
                newPackage._id,
                { $set: { sessions: createdSessions } },
                { session: mongoSession }
            );

            // 7. CRIAR PAGAMENTO (opcional)
            if (amountPaid > 0) {
                const newPayment = new Payment({
                    package: newPackage._id,
                    amount: amountPaid,
                    patient: patientId,
                    doctor: doctorId,
                    paymentMethod,
                    status: paymentType === 'full' ? 'paid' : 'partial'
                });

                await newPayment.save({ session: mongoSession });
                await Package.findByIdAndUpdate(
                    newPackage._id,
                    { $push: { payments: newPayment._id } },
                    { session: mongoSession }
                );
            }

            await mongoSession.commitTransaction();
            transactionCommitted = true;

            // 8. RETORNO
            const result = await Package.findById(newPackage._id)
                .populate('sessions appointments payments')
                .lean();

            res.status(201).json({
                success: true,
                data: result,
                replacedAppointment: appointmentId || null
            });

        } catch (error) {
            if (mongoSession.inTransaction() && !transactionCommitted) {
                await mongoSession.abortTransaction();
            }

            res.status(500).json({
                success: false,
                message: error.message,
                errorCode: 'PACKAGE_CONVERSION_ERROR'
            });
        } finally {
            await mongoSession.endSession();
        }
    }
    ,

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
                    if (s === 'completed') return 'confirmado';
                    if (s === 'canceled') return 'cancelado';
                    return 'agendado';
                };

                const getClinicalStatus = (s, confirmed) => {
                    if (s === 'completed') return 'concluído';
                    if (s === 'canceled') return confirmed ? 'faltou' : 'cancelado';
                    return 'pendente';
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
                                serviceType: 'session',
                                amount: sessionDoc.value,
                                paymentMethod: sessionDoc.paymentMethod,
                                session: sessionDoc._id,
                                package: pkgId,
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

// Função auxiliar para calcular o próximo horário (se necessário)
function calculateNextTime(baseTime, durationMonths, sessionIndex) {
    // Implementação personalizada conforme sua lógica de negócio
    return baseTime; // Por padrão, mantém o mesmo horário
}

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