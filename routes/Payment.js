import express from 'express';
import moment from 'moment-timezone';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import { auth, authorize } from '../middleware/auth.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { distributePayments } from '../services/distributePayments.js';
import { updateAppointmentFromSession } from '../utils/appointmentUpdater.js';

const router = express.Router();

router.post('/', async (req, res) => {
    const { patientId,
        doctorId, serviceType,
        amount, paymentMethod,
        status, notes, packageId,
        paymentDate,
        sessionId, isAdvancePayment = false,
        advanceSessions = []
    } = req.body;

    try {
        // Validação básica
        if (!patientId || !doctorId || !sessionType || !amount || !paymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Campos obrigatórios faltando'
            });
        }

        if (isAdvancePayment) {
            return handleAdvancePayment(req, res);
        }

        const currentDate = new Date();

        // Cria sessão individual se necessário
        let individualSessionId = null;
        if (serviceType === 'individual_session') {
            const newSession = await Session.create({
                serviceType,
                patient: patientId,
                doctor: doctorId,
                notes,
                package: null,
                sessionType,
                createdAt: currentDate,
                updatedAt: currentDa
            });
            individualSessionId = newSession._id;
        }

        // Validação específica por tipo de serviço
        if (serviceType === 'package_session' && !packageId) {
            return res.status(400).json({
                success: false,
                message: 'ID do pacote é obrigatório para pagamentos de pacote'
            });
        }

        // Validação para sessões (exceto individual_session)
        if (serviceType === 'session' && !sessionId) {
            return res.status(400).json({
                success: false,
                message: 'ID da sessão é obrigatório para serviço do tipo "session"'
            });
        }

        // Validação de documentos relacionados
        if (serviceType === 'package_session') {
            const packageExists = await Package.exists({ _id: packageId });
            if (!packageExists) {
                return res.status(404).json({
                    success: false,
                    message: 'Pacote não encontrado'
                });
            }
        }

        // Validação de sessão para tipo 'session' (individual_session não precisa)
        if (serviceType === 'session') {
            const sessionExists = await Session.exists({ _id: sessionId });
            if (!sessionExists) {
                return res.status(404).json({
                    success: false,
                    message: 'Sessão não encontrada'
                });
            }
        }

        // Criar sessões futuras se for pagamento adiantado
        let advanceSessionsIds = [];
        if (advanceSessions.length > 0) {
            for (const session of advanceSessions) {
                const newSession = await Session.create({
                    date: session.date,
                    time: session.time,
                    sessionType: session.sessionType,
                    patient: patientId,
                    doctor: doctorId,
                    status: 'scheduled',
                    isPaid: true,
                    paymentMethod: paymentMethod,
                    isAdvance: true,
                    createdAt: currentDate,
                    updatedAt: currentDate,
                });
                advanceSessionsIds.push(newSession._id);
            }
        }

        // Criar pagamento com sessões futuras
        const paymentData = {
            patient: patientId,
            doctor: doctorId,
            serviceType,
            amount,
            paymentMethod,
            notes,
            status: status || 'paid',
            createdAt: currentDate,
            updatedAt: currentDate,
            coveredSessions: advanceSessionsIds.map(id => ({
                sessionId: id,
                used: false,
                scheduledDate: advanceSessions.find(s => s.sessionId === id.toString())?.date
            })),
            isAdvance: advanceSessions.length > 0
        };

        // Adiciona campos condicionais
        if (serviceType === 'session') {
            paymentData.session = sessionId;
        } else if (serviceType === 'individual_session') {
            paymentData.session = individualSessionId;
        } else if (serviceType === 'package_session') {
            paymentData.package = packageId;
        }

        const payment = await Payment.create(paymentData);

        // Atualiza status da sessão para tipos relevantes
        if (serviceType === 'session' || serviceType === 'individual_session') {
            const sessionToUpdate = serviceType === 'individual_session' ? individualSessionId : sessionId;
            await Session.findByIdAndUpdate(
                sessionToUpdate,
                {
                    status: status,
                    updatedAt: currentDate
                }
            );
        }

        return res.status(201).json({
            success: true,
            data: populatedPayment,
            message: advanceSessions.length > 0
                ? `Pagamento registrado com ${advanceSessions.length} sessões futuras`
                : 'Pagamento registrado com sucesso',
            timestamp: currentDate // 🔥 TIMESTAMP NA RESPOSTA
        });

    } catch (error) {
        console.error('Erro ao registrar pagamento:', error);
        return res.status(500).json({
            success: false,
            message: 'Erro ao registrar pagamento',
            error: error.message
        });
    }
});

// Função para lidar com pagamentos de sessões futuras
async function handleAdvancePayment(req, res) {
    const {
        patientId,
        doctorId,
        amount,
        paymentMethod,
        status,
        notes,
        advanceSessions = []
    } = req.body;

    try {
        // Validação específica para sessões futuras
        if (advanceSessions.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'É necessário pelo menos uma sessão futura'
            });
        }

        // Validar cada sessão
        for (const session of advanceSessions) {
            if (!session.date || !session.time || !session.sessionType) {
                return res.status(400).json({
                    success: false,
                    message: 'Todas as sessões devem ter data, horário e tipo preenchidos'
                });
            }
        }

        // Criar sessões futuras
        const advanceSessionsIds = [];
        for (const session of advanceSessions) {
            const newSession = await Session.create({
                date: session.date,
                time: session.time,
                sessionType: session.sessionType,
                patient: patientId,
                doctor: doctorId,
                status: 'scheduled',
                isPaid: true,
                paymentMethod: paymentMethod,
                isAdvance: true
            });
            advanceSessionsIds.push(newSession._id);
        }

        // Criar pagamento
        const payment = await Payment.create({
            patient: patientId,
            doctor: doctorId,
            amount,
            paymentMethod,
            notes,
            status: status || 'paid',
            isAdvance: true,
            advanceSessions: advanceSessionsIds.map(id => ({
                sessionId: id,
                used: false,
                scheduledDate: advanceSessions.find(s => s.sessionId === id.toString())?.date
            }))
        });

        return res.status(201).json({
            success: true,
            data: payment
        });

    } catch (error) {
        console.error('Erro no pagamento adiantado:', error);
        return res.status(500).json({
            success: false,
            message: 'Erro ao registrar pagamento adiantado',
            error: error.message
        });
    }
}

router.get('/', async (req, res) => {
    try {
        const { doctorId, patientId, status, startDate, endDate } = req.query;
        const filters = {};

        if (doctorId) filters.doctor = doctorId;
        if (patientId) filters.patient = patientId;
        if (status) filters.status = status;
        if (startDate && endDate) {
            filters.createdAt = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        }

        const payments = await Payment.find(filters)
            .populate({
                path: 'patient',
                select: 'fullName email phoneNumber',
                model: 'Patient',
            })
            .populate({
                path: 'doctor',
                select: 'fullName specialty',
                model: 'Doctor',
            })
            .populate({
                path: 'package',
                select: 'name totalSessions',
                model: 'Package',
            })
            .populate({
                path: 'session',
                select: 'date status',
                model: 'Session',
            })
            .populate({
                path: 'appointment',
                select: 'date time status',
                model: 'Appointment',
            })
            .populate({
                path: 'advanceSessions.session',
                select: 'date time sessionType status',
                model: 'Session'
            })
            .sort({ createdAt: -1 })
            .lean();

        const validPayments = payments.filter(
            (p) => p.session?.status !== 'canceled'
        );

        if (validPayments.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Nenhum pagamento encontrado',
            });
        }

        const totalReceived = validPayments.reduce((acc, p) => {
            return p.status === 'paid' ? acc + p.amount : acc;
        }, 0);

        const totalPending = validPayments.reduce((acc, p) => {
            return p.status === 'pending' ? acc + p.amount : acc;
        }, 0);

        const formattedPayments = validPayments.map((payment) => ({
            ...payment,
            patientName: payment.patient?.fullName || 'Não informado',
            doctorName: payment.doctor?.fullName || 'Não informado',
            doctorSpecialty: payment.doctor?.specialty || 'Não informada',
            packageName: payment.package?.name || null,
            formattedDate: new Date(payment.createdAt).toLocaleDateString('pt-BR'),
            formattedAmount: `R$ ${payment.amount.toFixed(2)}`,
            advanceSessions: payment.advanceSessions?.map(s => ({
                sessionId: s.session?._id,
                date: s.session?.date,
                time: s.session?.time,
                sessionType: s.session?.sessionType,
                status: s.session?.status,
                used: s.used
            })) || []
        }));

        return res.status(200).json({
            success: true,
            count: formattedPayments.length,
            data: formattedPayments,
            totals: {
                received: totalReceived,
                pending: totalPending,
            },
        });
    } catch (err) {
        console.error('Erro ao buscar pagamentos:', err);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar pagamentos',
            error:
                process.env.NODE_ENV === 'development' ? err.message : undefined,
        });
    }
});

router.patch('/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { amount, paymentMethod, status, advanceServices = [] } = req.body;
    const MAX_RETRIES = 8;
    let retryCount = 0;
    let result;

    const executeCriticalOperation = async (operation, session, entity, filter, update) => {
        try {
            return await operation(entity, filter, update, { session });
        } catch (error) {
            if (error.code === 112 || error.codeName === 'WriteConflict') {
                console.warn('Conflito detectado em operação crítica. Tentando abordagem alternativa...');
                if (filter._id) {
                    return await operation(entity, filter, update, { session });
                } else {
                    const docs = await entity.find(filter).session(session);
                    for (const doc of docs) {
                        await operation(entity, { _id: doc._id }, update, { session });
                    }
                    return { modifiedCount: docs.length };
                }
            }
            throw error;
        }
    };

    const safePopulatePayment = async (paymentId) => {
        try {
            return await Payment.findById(paymentId)
                .populate('patient doctor session')
                .populate('advanceSessions.session')
                .populate('advanceSessions.appointment');
        } catch (error) {
            console.error('Erro na população:', error);
            return await Payment.findById(paymentId).populate('patient doctor session');
        }
    };

    while (retryCount < MAX_RETRIES) {
        const mongoSession = await mongoose.startSession();
        let transactionCommitted = false;

        try {
            await mongoSession.startTransaction({
                readConcern: { level: "snapshot" },
                writeConcern: { w: "majority", wtimeout: 10000 }
            });

            console.log(`🔄 Tentativa ${retryCount + 1} de ${MAX_RETRIES} para atualizar pagamento ${id}`);

            const currentDate = new Date();

            // 1. Buscar pagamento existente
            let payment = await Payment.findById(id)
                .session(mongoSession)
                .select()
                .lean();

            if (!payment) {
                await mongoSession.abortTransaction();
                return res.status(404).json({
                    success: false,
                    error: 'Pagamento não encontrado'
                });
            }

            console.log('📋 Pagamento encontrado:', payment._id);

            // 2. 🔥 ATUALIZAÇÃO DO PAGAMENTO PRINCIPAL (MANTÉM LÓGICA ORIGINAL)
            const updateData = {
                ...(amount !== undefined && { amount }),
                ...(paymentMethod !== undefined && { paymentMethod }),
                ...(status !== undefined && { status }),
                updatedAt: currentDate
            };

            await Payment.updateOne({ _id: id }, { $set: updateData }, { session: mongoSession });
            console.log('✅ Pagamento principal atualizado');

            // 3. 🔥 LÓGICA ORIGINAL PARA O PAGAMENTO PRINCIPAL (MANTIDA)
            // 3.1. Atualizar sessões de pacotes
            if (payment.package) {
                console.log('📦 Atualizando sessões do pacote:', payment.package);
                await executeCriticalOperation(
                    Session.updateMany.bind(Session),
                    mongoSession,
                    Session,
                    { package: payment.package },
                    {
                        $set: {
                            isPaid: status === 'paid',
                            status: status === 'paid' ? 'completed' : 'pending',
                            updatedAt: currentDate
                        }
                    }
                );
                await updatePackageStatus(payment.package, mongoSession);
            }

            // 3.2. Atualizar sessão individual
            if (payment.session) {
                console.log('💼 Atualizando sessão individual:', payment.session);
                await Session.findByIdAndUpdate(
                    payment.session,
                    {
                        $set: {
                            isPaid: status === 'paid',
                            status: status === 'paid' ? 'completed' : 'pending',
                            updatedAt: currentDate
                        }
                    },
                    { session: mongoSession }
                );
            }

            // 3.3. Atualizar status em agendamentos vinculados
            const appointmentIds = [
                payment.appointment,
                ...(payment.advanceSessions?.map(a => a.appointment) || [])
            ].filter(id => id);

            if (appointmentIds.length > 0) {
                console.log('📅 Atualizando agendamentos vinculados:', appointmentIds.length);
                await executeCriticalOperation(
                    async (entity, filter, update, opts) => {
                        return await entity.updateMany(filter, update, opts);
                    },
                    mongoSession,
                    Appointment,
                    { _id: { $in: appointmentIds } },
                    {
                        $set: {
                            paymentStatus: status === 'paid' ? 'paid' : 'pending',
                            operationalStatus: status === 'paid' ? 'confirmado' : 'pendente',
                            updatedAt: currentDate
                        }
                    }
                );
            }

            // 4. 🔥 LÓGICA advanceServices: CRIAR NOVOS PAGAMENTOS SEPARADOS
            if (advanceServices.length > 0) {
                console.log('🔥 Criando novos pagamentos para advanceServices:', advanceServices.length);

                for (const [index, sessionData] of advanceServices.entries()) {
                    console.log(`💰 Criando pagamento ${index + 1}/${advanceServices.length}`);

                    // 🔥 CRIAR NOVO PAGAMENTO INDEPENDENTE
                    const newPayment = new Payment({
                        patient: payment.patient,
                        doctor: payment.doctor,
                        serviceType: sessionData.serviceType || 'individual_session',
                        amount: sessionData.amount, // Valor do advanceService
                        paymentMethod: paymentMethod || payment.paymentMethod,
                        status: status, // Mesmo status do principal
                        specialty: sessionData.sessionType,
                        sessionType: sessionData.sessionType,
                        isAdvance: true,
                        serviceDate: sessionData.date,
                        createdAt: currentDate, // DATA DA CRIAÇÃO DO PAGAMENTO
                        updatedAt: currentDate,
                        notes: `Pagamento adiantado - ${sessionData.date} ${sessionData.time}`
                    });
                    await newPayment.save({ session: mongoSession });
                    console.log('✅ Novo pagamento criado:', newPayment._id);

                    // 🔥 CRIAR APPOINTMENT para o novo pagamento
                    const newAppointment = new Appointment({
                        date: sessionData.date,
                        time: sessionData.time,
                        patient: payment.patient,
                        doctor: payment.doctor,
                        specialty: sessionData.sessionType,
                        serviceType: sessionData.serviceType || 'individual_session',
                        operationalStatus: 'scheduled',
                        clinicalStatus: 'pending',
                        paymentStatus: status === 'paid' ? 'paid' : 'pending',
                        paymentMethod: paymentMethod || payment.paymentMethod,
                        sessionValue: sessionData.amount,
                        payment: newPayment._id, // Vincula ao NOVO pagamento
                        createdAt: currentDate, // DATA DA CRIAÇÃO DO PAGAMENTO
                        updatedAt: currentDate,
                    });
                    await newAppointment.save({ session: mongoSession });
                    console.log('✅ Novo appointment criado:', newAppointment._id);

                    // 🔥 CRIAR SESSION para o novo pagamento
                    const newSession = new Session({
                        date: sessionData.date,
                        time: sessionData.time,
                        sessionType: sessionData.sessionType,
                        sessionValue: sessionData.amount,
                        patient: payment.patient,
                        doctor: payment.doctor,
                        status: 'scheduled',
                        isPaid: status === 'paid',
                        paymentMethod: paymentMethod || payment.paymentMethod,
                        isAdvance: true,
                        appointment: newAppointment._id,
                        payment: newPayment._id, // Vincula ao NOVO pagamento
                        createdAt: currentDate, // DATA DA CRIAÇÃO DO PAGAMENTO
                        updatedAt: currentDate,
                    });
                    await newSession.save({ session: mongoSession });
                    console.log('✅ Nova session criada:', newSession._id);

                    // Vincular appointment com session
                    await Appointment.updateOne(
                        { _id: newAppointment._id },
                        { $set: { session: newSession._id } },
                        { session: mongoSession }
                    );

                    // Vincular pagamento com appointment e session
                    await Payment.updateOne(
                        { _id: newPayment._id },
                        {
                            $set: {
                                appointment: newAppointment._id,
                                session: newSession._id
                            }
                        },
                        { session: mongoSession }
                    );

                    console.log(`✅ AdvanceService ${index + 1} completo - Pagamento: ${newPayment._id}`);
                }
                console.log('🎉 Todos os advanceServices processados');
            }

            // COMMIT DA TRANSAÇÃO
            await mongoSession.commitTransaction();
            transactionCommitted = true;
            console.log('🎉 Transação commitada com sucesso');

            // 5. POPULAÇÃO DO PAGAMENTO PRINCIPAL
            try {
                result = await safePopulatePayment(id);

                return res.json({
                    success: true,
                    data: result,
                    message: advanceServices.length > 0
                        ? `Pagamento atualizado e ${advanceServices.length} sessões futuras criadas`
                        : 'Pagamento atualizado com sucesso'
                });

            } catch (populateError) {
                console.error('❌ Erro na população:', populateError);

                result = await Payment.findById(id).populate('patient doctor session');

                return res.json({
                    success: true,
                    data: result,
                    warning: 'Dados carregados parcialmente',
                    message: 'Pagamento atualizado com sucesso'
                });
            }

        } catch (error) {
            console.error('❌ Erro durante a transação:', error);

            const isWriteConflict = error.code === 112 ||
                error.codeName === 'WriteConflict' ||
                (error.errorLabels && error.errorLabels.includes('TransientTransactionError'));

            if (mongoSession.inTransaction() && !transactionCommitted) {
                try {
                    await mongoSession.abortTransaction();
                    console.log('🔄 Rollback executado');
                } catch (abortError) {
                    console.error('❌ Erro ao fazer rollback:', abortError);
                }
            }

            if (isWriteConflict && retryCount < MAX_RETRIES - 1) {
                retryCount++;
                const delay = Math.min(150 * Math.pow(4, retryCount), 5000);
                console.warn(`🔄 Conflito detectado. Tentativa ${retryCount + 1}/${MAX_RETRIES} em ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            if (error.name === 'ValidationError') {
                return res.status(400).json({
                    success: false,
                    message: 'Erro de validação',
                    errors: error.errors
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Erro interno ao atualizar pagamento',
                error: error.message
            });

        } finally {
            await mongoSession.endSession();
        }
    }

    return res.status(500).json({
        success: false,
        message: 'Falha após múltiplas tentativas'
    });
});

// Função auxiliar para atualizar status do pacote
async function updatePackageStatus(packageId, session) {
    try {
        const Package = mongoose.model('Package');
        const Session = mongoose.model('Session');

        const packageDoc = await Package.findById(packageId).session(session);
        if (!packageDoc) return;

        const totalSessions = await Session.countDocuments({
            package: packageId
        }).session(session);

        const completedSessions = await Session.countDocuments({
            package: packageId,
            status: 'completed'
        }).session(session);

        let newStatus = packageDoc.status;

        if (completedSessions >= totalSessions) {
            newStatus = 'completed';
        } else if (completedSessions > 0) {
            newStatus = 'in_progress';
        }

        if (newStatus !== packageDoc.status) {
            await Package.updateOne(
                { _id: packageId },
                { $set: { status: newStatus } },
                { session }
            );
        }
    } catch (error) {
        console.error('Erro ao atualizar status do pacote:', error);
        throw error;
    }
}

router.get('/future-sessions/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;

        const sessions = await Session.find({
            patient: patientId,
            isAdvance: true,
            status: 'scheduled'
        })
            .populate('doctor', 'fullName specialty')
            .select('date time sessionType specialty')
            .sort({ date: 1 });

        res.json(sessions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.patch('/use-session/:paymentId', async (req, res) => {
    const { sessionId } = req.body;

    try {
        const payment = await Payment.findById(req.params.paymentId);

        // Encontrar a sessão específica
        const session = payment.sessions.id(sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Sessão não encontrada neste pagamento' });
        }

        if (session.status === 'completed') {
            return res.status(400).json({ error: 'Sessão já foi utilizada' });
        }

        // Atualizar status
        session.status = 'completed';
        session.usedAt = new Date();

        await payment.save();

        res.json({
            success: true,
            message: 'Sessão marcada como utilizada',
            updatedPayment: payment
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/:paymentId/add-session', auth, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { date, time, sessionType, specialty } = req.body;
        const payment = await Payment.findById(req.params.paymentId).session(session);

        if (!payment) {
            await session.abortTransaction();
            return res.status(404).json({ error: 'Pagamento não encontrado' });
        }

        if (!payment.isAdvancePayment) {
            await session.abortTransaction();
            return res.status(400).json({ error: 'Este pagamento não permite sessões futuras' });
        }

        // Criar novo agendamento
        const appointment = new Appointment({
            date,
            time,
            sessionType,
            specialty,
            patient: payment.patient,
            doctor: payment.doctor,
            paymentStatus: 'advanced',
            sourcePayment: payment._id,
            operationalStatus: 'scheduled',
            clinicalStatus: 'pending'
        });

        // Criar nova sessão
        const newSession = new Session({
            date,
            time,
            sessionType,
            specialty,
            patient: payment.patient,
            doctor: payment.doctor,
            status: 'scheduled',
            sourcePayment: payment._id
        });

        // Salvar ambos
        await appointment.save({ session });
        await newSession.save({ session });

        // Adicionar ao pagamento
        payment.advancedSessions.push({
            appointment: appointment._id,
            session: newSession._id,
            scheduledDate: new Date(`${date}T${time}`),
            used: false
        });

        await payment.save({ session });
        await session.commitTransaction();

        res.json({
            success: true,
            payment,
            newAppointment: appointment,
            newSession: newSession
        });

    } catch (error) {
        await session.abortTransaction();
        console.error('Erro ao adicionar sessão futura:', error);
        res.status(500).json({
            error: 'Erro ao adicionar sessão futura',
            details: process.env.NODE_ENV === 'development' ? error.message : null
        });
    } finally {
        session.endSession();
    }
});

// Funções auxiliares
async function updateSessionStatus(sessionId, amountPaid) {
    const session = await Session.findById(sessionId);
    if (!session) return;

    if (amountPaid >= session.price) {
        session.status = 'paid';
    } else if (amountPaid > 0) {
        session.status = 'partial';
    } else {
        session.status = 'pending';
    }
    await session.save();
}

// Função para atualizar status do pacote (com suporte a transação)

// Função para atualizar status do pacote (considerando sessões usadas)
// Exportação de PDF
router.get('/export/pdf', authorize(['admin']), async (req, res) => {
    try {
        const filters = req.query;
        const payments = await Payment.find(filters)
            .populate('patientId doctorId sessionId packageId')
            .sort({ sessionDate: 1 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=relatorio_pagamentos.pdf');

        const doc = new PDFDocument({ margin: 30, size: 'A4' });
        doc.pipe(res);

        doc.fontSize(18).text('Relatório de Pagamentos', { align: 'center' });
        doc.moveDown(1);

        doc.fontSize(12);
        doc.text('Data', 50, doc.y, { width: 80, continued: true });
        doc.text('Paciente', 130, doc.y, { width: 120, continued: true });
        doc.text('Profissional', 250, doc.y, { width: 120, continued: true });
        doc.text('Valor', 370, doc.y, { width: 60, continued: true });
        doc.text('Status', 430, doc.y, { width: 80 });
        doc.text('Pacote', 510, doc.y, { width: 80 });
        doc.moveDown(0.5);

        payments.forEach(p => {
            const date = p.sessionDate.toISOString().split('T')[0];
            doc.text(date, 50, doc.y, { width: 80, continued: true });
            doc.text(p.patientId.name, 130, doc.y, { width: 120, continued: true });
            doc.text(p.doctorId.name, 250, doc.y, { width: 120, continued: true });
            doc.text(`R$ ${p.value.toFixed(2)}`, 370, doc.y, { width: 60, continued: true });
            doc.text(p.status.toUpperCase(), 430, doc.y, { width: 80 });
            doc.text(p.packageId.name, 510, doc.y, { width: 80 });
            doc.moveDown(0.5);
        });

        doc.end();
    } catch (err) {
        console.error('Erro ao gerar PDF', err);
        res.status(500).json({ message: 'Erro ao gerar PDF' });
    }
});

// Exportação CSV
router.get('/export/csv', authorize(['admin', 'secretary']), async (req, res) => {
    const filters = req.query;
    const payments = await Payment.find(filters)
        .populate('patientId doctorId')
        .sort({ sessionDate: 1 });

    const headers = ['Data', 'Paciente', 'Profissional', 'Valor', 'Status', 'Método'];
    const rows = payments.map(p => [
        p.sessionDate.toISOString().split('T')[0],
        p.patientId.name,
        p.doctorId.name,
        p.value.toFixed(2),
        p.status,
        p.paymentMethod
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');

    res
        .header('Content-Type', 'text/csv')
        .attachment('pagamentos.csv')
        .send(csv);
});

// routes/paymentRoutes.js
router.get('/totals', async (req, res) => {
    try {
        const { doctorId, startDate, endDate } = req.query;

        const matchStage = {};
        if (doctorId) matchStage.doctor = mongoose.Types.ObjectId(doctorId);
        if (startDate && endDate) {
            matchStage.createdAt = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }

        const aggregation = [
            { $match: matchStage },
            {
                $group: {
                    _id: null,
                    totalReceived: {
                        $sum: {
                            $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0]
                        }
                    },
                    totalPending: {
                        $sum: {
                            $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0]
                        }
                    },
                    countReceived: {
                        $sum: {
                            $cond: [{ $eq: ["$status", "paid"] }, 1, 0]
                        }
                    },
                    countPending: {
                        $sum: {
                            $cond: [{ $eq: ["$status", "pending"] }, 1, 0]
                        }
                    }
                }
            }
        ];

        const result = await Payment.aggregate(aggregation);

        const totals = result[0] || {
            totalReceived: 0,
            totalPending: 0,
            countReceived: 0,
            countPending: 0
        };

        res.status(200).json({
            success: true,
            data: {
                totalReceived: totals.totalReceived,
                totalPending: totals.totalPending,
                countReceived: totals.countReceived,
                countPending: totals.countPending
            }
        });

    } catch (err) {
        console.error('Erro ao calcular totais:', err);
        res.status(500).json({
            success: false,
            message: 'Erro ao calcular totais'
        });
    }
});

/**
 * 🔹 NOVO ENDPOINT: /daily-closing
 *   Retorna uma visão clara e segmentada:
 *   - Sessões (agendamentos do dia)
 *   - Pagamentos (entradas do dia)
 *   - Resumos e métricas consolidados
 */
router.get("/daily-closing", async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date
            ? moment.tz(date, "America/Sao_Paulo").format("YYYY-MM-DD")
            : moment.tz(new Date(), "America/Sao_Paulo").format("YYYY-MM-DD");

        const startOfDay = moment
            .tz(`${targetDate}T00:00:00`, "America/Sao_Paulo")
            .toDate();
        const endOfDay = moment
            .tz(`${targetDate}T23:59:59`, "America/Sao_Paulo")
            .toDate();

        const sessions = await Session.find({ date: targetDate })
            .populate("package patient doctor appointmentId");

        for (const s of sessions) {
            await updateAppointmentFromSession(s);

            if (s.appointmentId) {
                await Appointment.findByIdAndUpdate(
                    s.appointmentId,
                    {
                        sessionValue: s.sessionValue,
                        paymentStatus: s.paymentStatus,
                        operationalStatus: mapStatusToOperational(s.status),
                        clinicalStatus: mapStatusToClinical(s.status), // <-- novo
                    },
                    { new: true, runValidators: false } // evita erro de enum
                );

            }
        }

        const appointments = await Appointment.find({ date: targetDate })
            .populate("doctor patient package")
            .lean();

        const patientIdsOfDay = appointments
            .map((a) => a.patient?._id?.toString())
            .filter(Boolean);

        const payments = await Payment.find({
            status: "paid",
            $or: [
                { paymentDate: targetDate },
                { createdAt: { $gte: startOfDay, $lte: endOfDay } },
            ],
        })
            .populate("patient doctor package appointment")
            .lean();

        const filteredPayments = payments.filter((p) =>
            patientIdsOfDay.includes(p.patient?._id?.toString())
        );

        const normalizePaymentMethod = (method) => {
            if (!method) return "dinheiro";
            method = method.toLowerCase().trim();
            if (method.includes("pix")) return "pix";
            if (
                method.includes("cartão") ||
                method.includes("card") ||
                method.includes("credito") ||
                method.includes("débito")
            )
                return "cartão";
            return "dinheiro";
        };

        const isAttended = (appt) =>
            (appt.operationalStatus || "").toLowerCase() === "confirmed" ||
            (appt.clinicalStatus || "").toLowerCase() === "completed";

        const isCanceled = (status) =>
            (status || "").toLowerCase() === "canceled";

        // ✅ Tradução para exibição legível (frontend ainda em PT)
        const translateStatus = (status) => {
            const map = {
                scheduled: "agendado",
                confirmed: "confirmado",
                canceled: "cancelado",
                paid: "pago",
                missed: "faltou",
            };
            return map[status] || status;
        };

        const report = {
            date: targetDate,
            summary: {
                appointments: {
                    total: 0,
                    attended: 0,
                    canceled: 0,
                    pending: 0,
                    expectedValue: 0,
                },
                payments: {
                    totalReceived: 0,
                    byMethod: { dinheiro: 0, pix: 0, cartão: 0 },
                },
            },
            timelines: { appointments: [], payments: [] },
        };

        for (const appt of appointments) {
            const status = (appt.operationalStatus || "").toLowerCase();
            const doctorName = appt.doctor?.fullName || "Não informado";
            const patientName = appt.patient?.fullName || "Não informado";
            const method = appt.package?.paymentMethod || appt.paymentMethod || "—";
            const isPackage = appt.serviceType === "package_session";

            const relatedPayment = payments.find(
                (p) =>
                    p.patient?._id?.toString() === appt.patient?._id?.toString() &&
                    (p.appointment?._id?.toString() === appt._id?.toString() ||
                        p.package?._id?.toString() === appt.package?._id?.toString())
            );

            const paymentDate = relatedPayment
                ? typeof relatedPayment.paymentDate === "string"
                    ? relatedPayment.paymentDate
                    : moment(relatedPayment.createdAt)
                        .tz("America/Sao_Paulo")
                        .format("YYYY-MM-DD")
                : null;

            const paidStatus = relatedPayment
                ? paymentDate === targetDate
                    ? "Pago no dia"
                    : "Pago antes"
                : "Pendente";

            const sessionValue = appt.sessionValue || 0;

            report.summary.appointments.total++;
            report.summary.appointments.expectedValue += sessionValue;

            if (isAttended(appt)) report.summary.appointments.attended++;
            else if (isCanceled(status)) report.summary.appointments.canceled++;
            else report.summary.appointments.pending++;

            report.timelines.appointments.push({
                id: appt._id,
                patient: patientName,
                service: appt.serviceType,
                doctor: doctorName,
                sessionValue,
                method,
                paidStatus,
                status: translateStatus(status), // 👈 mostra em PT no front
                date: appt.date,
                time: appt.time,
                isPackage,
            });
        }

        for (const pay of filteredPayments) {
            const paymentDate =
                typeof pay.paymentDate === "string"
                    ? pay.paymentDate
                    : moment(pay.createdAt)
                        .tz("America/Sao_Paulo")
                        .format("YYYY-MM-DD");

            if (paymentDate !== targetDate && pay.paymentDate) continue;

            const amount = pay.amount || 0;
            const method = normalizePaymentMethod(pay.paymentMethod);
            const type = pay.serviceType || "outro";
            const patient = pay.patient?.fullName || "Avulso";
            const doctor = pay.doctor?.fullName || "Não vinculado";

            report.summary.payments.totalReceived += amount;
            report.summary.payments.byMethod[method] += amount;

            report.timelines.payments.push({
                id: pay._id,
                patient,
                type,
                method,
                value: amount,
                paymentDate,
                doctor,
            });
        }

        report.summary.appointments.canceled = appointments.filter((a) =>
            isCanceled(a.operationalStatus)
        ).length;

        res.json({
            success: true,
            data: report,
            meta: {
                generatedAt: new Date().toISOString(),
                recordCount: {
                    appointments: appointments.length,
                    payments: filteredPayments.length,
                },
            },
        });
    } catch (error) {
        console.error("❌ Erro no fechamento diário:", error);
        res.status(500).json({
            success: false,
            error: "Erro ao gerar relatório diário",
            details:
                process.env.NODE_ENV === "development" ? error.message : undefined,
        });
    }
});


const mapStatusToOperational = (status) => {
    switch ((status || "").toLowerCase()) {
        case "scheduled":
            return "scheduled";
        case "confirmed":
            return "confirmed";
        case "paid":
            return "paid";
        case "canceled":
        case "cancelado":
            return "canceled";
        case "missed":
        case "faltou":
            return "missed";
        default:
            return "scheduled";
    }
};

const mapStatusToClinical = (status) => {
    switch ((status || "").toLowerCase()) {
        case "pending":
        case "pendente":
            return "pending";
        case "in_progress":
        case "em_andamento":
            return "in_progress";
        case "completed":
        case "concluído":
            return "completed";
        case "missed":
        case "faltou":
            return "missed";
        default:
            return "pending"; // nunca canceled
    }
};


// Detalhamento de sessões agendadas
router.get('/daily-scheduled-details', async (req, res) => {
    try {
        const { date } = req.query;

        // Criar datas com o fuso horário UTC-3
        const startOfDay = date
            ? new Date(`${date}T00:00:00-03:00`)
            : new Date(new Date().setHours(0, 0, 0, 0) - 3 * 60 * 60 * 1000);

        const endOfDay = date
            ? new Date(`${date}T23:59:59.999-03:00`)
            : new Date(new Date().setHours(23, 59, 59, 999) - 3 * 60 * 60 * 1000);

        const sessions = await Session.find({
            date: { $gte: startOfDay, $lte: endOfDay },
            status: 'scheduled'
        })
            .populate({
                path: 'patient',
                select: 'fullName phone email'
            })
            .populate({
                path: 'doctor',
                select: 'fullName specialty'
            })
            .populate({
                path: 'package',
                select: 'sessionValue sessionType'
            })
            .select('date time status confirmedAbsence notes')
            .sort({ date: 1 })
            .lean();

        // Formatar dados para resposta
        const formattedSessions = sessions.map(session => ({
            id: session._id,
            date: session.date,
            time: session.time,
            patient: session.patient?.fullName || 'N/A',
            patientPhone: session.patient?.phone || '',
            patientEmail: session.patient?.email || '',
            doctor: session.doctor?.fullName || 'N/A',
            specialty: session.doctor?.specialty || 'N/A',
            sessionType: session.package?.sessionType || 'N/A',
            value: session.package?.sessionValue || 0,
            status: session.status,
            confirmedAbsence: session.confirmedAbsence || false,
            notes: session.notes || ''
        }));

        res.json(formattedSessions);
    } catch (error) {
        console.error('Erro ao obter detalhes de sessões agendadas:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// Detalhamento de sessões realizadas
router.get('/daily-completed-details', async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date ? new Date(date) : new Date();

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        startOfDay.setHours(startOfDay.getHours() + 3);

        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        endOfDay.setHours(endOfDay.getHours() + 3);

        const sessions = await Session.find({
            date: { $gte: startOfDay, $lte: endOfDay },
            status: 'completed'
        })
            .populate({
                path: 'patient',
                select: 'fullName'
            })
            .populate({
                path: 'doctor',
                select: 'fullName specialty'
            })
            .populate({
                path: 'package',
                select: 'sessionValue sessionType'
            })
            .select('date time notes')
            .sort({ date: 1 }) // Ordenar por horário
            .lean();

        // Formatar dados para resposta
        const formattedSessions = sessions.map(session => ({
            id: session._id,
            date: session.date,
            time: session.time,
            patient: session.patient?.fullName || 'N/A',
            doctor: session.doctor?.fullName || 'N/A',
            specialty: session.doctor?.specialty || 'N/A',
            sessionType: session.package?.sessionType || 'N/A',
            value: session.package?.sessionValue || 0,
            duration: 40, // Duração fixa padrão
            notes: session.notes || ''
        }));

        res.json(formattedSessions);
    } catch (error) {
        console.error('Erro ao obter detalhes de sessões realizadas:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// Detalhamento de pagamentos
router.get('/daily-payments-details', async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date ? new Date(date) : new Date();

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        startOfDay.setHours(startOfDay.getHours() + 3);

        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        endOfDay.setHours(endOfDay.getHours() + 3);

        const payments = await Payment.find({
            status: "paid",
            $or: [
                // ✅ Pagamentos com paymentDate explícito
                { paymentDate: targetDate },

                // ✅ Pagamentos antigos sem paymentDate — usa createdAt como fallback
                {
                    paymentDate: { $exists: false },
                    createdAt: { $gte: startOfDay, $lte: endOfDay },
                },
            ],
        })
            .populate("patient doctor package appointment")
            .lean();


        // Formatar dados para resposta
        const formattedPayments = payments.map(payment => ({
            id: payment._id,
            date: payment.createdAt,
            patient: payment.patient?.fullName || 'N/A',
            doctor: payment.doctor?.fullName || 'N/A',
            specialty: payment.doctor?.specialty || 'N/A',
            sessionType: payment.package?.sessionType || 'N/A',
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            notes: payment.notes || ''
        }));

        res.json(formattedPayments);
    } catch (error) {
        console.error('Erro ao obter detalhes de pagamentos:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// Detalhamento de faltas e cancelamentos
router.get('/daily-absences-details', async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date ? new Date(date) : new Date();

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        startOfDay.setHours(startOfDay.getHours() + 3);

        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        endOfDay.setHours(endOfDay.getHours() + 3);

        const absences = await Session.find({
            date: { $gte: startOfDay, $lte: endOfDay },
            status: 'canceled',
            confirmedAbsence: true // Apenas faltas confirmadas
        })
            .populate({
                path: 'patient',
                select: 'fullName phone'
            })
            .populate({
                path: 'doctor',
                select: 'fullName specialty'
            })
            .populate({
                path: 'package',
                select: 'sessionValue sessionType'
            })
            .select('date time confirmedAbsence notes')
            .sort({ date: 1 }) // Ordenar por horário
            .lean();

        // Formatar dados para resposta
        const formattedAbsences = absences.map(absence => ({
            id: absence._id,
            date: absence.date,
            time: absence.time,
            patient: absence.patient?.fullName || 'N/A',
            patientPhone: absence.patient?.phone || '',
            doctor: absence.doctor?.fullName || 'N/A',
            specialty: absence.doctor?.specialty || 'N/A',
            sessionType: absence.package?.sessionType || 'N/A',
            value: absence.package?.sessionValue || 0,
            confirmedAbsence: absence.confirmedAbsence || false,
            notes: absence.notes || ''
        }));

        res.json(formattedAbsences);
    } catch (error) {
        console.error('Erro ao obter detalhes de faltas:', error);
        res.status(500).json({ error: 'Erro interno' });
    }
});

/**
 * Registra um novo pagamento (manual, Pix, etc.) para um pacote existente.
 * Atualiza automaticamente os saldos e status das sessões.
 */
/**
 * Registra um novo pagamento (manual, Pix, etc.) para um pacote existente.
 * Atualiza automaticamente os saldos e status das sessões.
 */
router.post('/add', async (req, res) => {
    const mongoSession = await mongoose.startSession();
    let transactionCommitted = false;

    try {
        await mongoSession.startTransaction();

        const {
            packageId,
            amount,
            paymentMethod = 'dinheiro',
            paymentDate,
            note,
            patientId,
            doctorId,
            serviceType,
        } = req.body;

        const currentDate = new Date();

        // 🔹 1. Validação básica
        if (!packageId || !amount || amount <= 0 || !patientId || !doctorId || !serviceType) {
            return res.status(400).json({
                success: false,
                message: 'Campos obrigatórios faltando ou inválidos.',
            });
        }

        // 🔹 2. Buscar o pacote
        const pkg = await Package.findById(packageId)
            .populate('sessions')
            .session(mongoSession);

        if (!pkg) {
            return res.status(404).json({
                success: false,
                message: 'Pacote não encontrado',
            });
        }

        // 🔹 3. Criar pagamento principal (inicia como pending)
        const parentPayment = await Payment.create(
            [
                {
                    patient: patientId,
                    doctor: doctorId,
                    serviceType,
                    amount,
                    paymentMethod,
                    notes: note || '',
                    status: 'pending', // status inicial
                    package: packageId,
                    createdAt: currentDate,
                },
            ],
            { session: mongoSession }
        );

        // 🔹 4. Distribuir o pagamento entre as sessões
        const updatedPackage = await distributePayments(
            pkg._id,
            amount,
            mongoSession,
            parentPayment[0]._id
        );

        // 🔹 5. Calcular o status real após a distribuição
        const remainingBalance = updatedPackage.balance ?? 0;
        const totalValue = updatedPackage.totalValue ?? 0;

        let paymentStatus = 'paid';
        if (remainingBalance > 0 && remainingBalance < totalValue) {
            paymentStatus = 'partial';
        } else if (remainingBalance === totalValue) {
            paymentStatus = 'pending';
        }

        console.log(`📊 Pagamento distribuído — Status: ${paymentStatus} | Saldo: ${remainingBalance} | Total: ${totalValue}`);

        // 🔹 6. Atualizar o pagamento com o status correto
        await Payment.findByIdAndUpdate(
            parentPayment[0]._id,
            { status: paymentStatus },
            { session: mongoSession }
        );

        // 🔹 7. Atualizar o pacote com informações financeiras
        await Package.findByIdAndUpdate(
            pkg._id,
            {
                $push: { payments: parentPayment[0]._id },
                $set: {
                    totalPaid: updatedPackage.totalPaid,
                    balance: updatedPackage.balance,
                    financialStatus: updatedPackage.financialStatus,
                },
            },
            { session: mongoSession }
        );

        await mongoSession.commitTransaction();
        transactionCommitted = true;

        // 🔹 8. Buscar pacote atualizado
        const finalResult = await Package.findById(pkg._id)
            .populate('sessions payments')
            .lean();

        return res.status(201).json({
            success: true,
            message:
                paymentStatus === 'partial'
                    ? 'Pagamento parcial registrado com sucesso.'
                    : 'Pagamento registrado e distribuído com sucesso.',
            data: finalResult,
        });
    } catch (error) {
        if (mongoSession.inTransaction() && !transactionCommitted) {
            await mongoSession.abortTransaction();
        }

        console.error('❌ Erro ao registrar pagamento:', error);

        return res.status(500).json({
            success: false,
            message: error.message || 'Erro ao registrar pagamento.',
            errorCode: 'ADD_PAYMENT_ERROR',
        });
    } finally {
        await mongoSession.endSession();
    }
});


export default router;

