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
import { createNextPackageFromPrevious } from '../utils/createNextPackageFromPrevious.js';
import { mapStatusToClinical, mapStatusToOperational } from "../utils/statusMappers.js";

const router = express.Router();

router.post('/', async (req, res) => {
    const { patientId,
        doctorId, serviceType,
        amount, paymentMethod,
        status, notes, packageId,
        paymentDate, sessionType,
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
                updatedAt: currentDate
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
            sessionType,
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
            data: payment,
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
        const {
            doctorId,
            patientId,
            status,
            startDate,
            endDate,
        } = req.query;

        const filters = {};

        // 🔍 Filtros básicos
        if (doctorId) filters.doctor = doctorId;
        if (patientId) filters.patient = patientId;
        if (status) filters.status = status;

        // 🔄 IMPORTANTE: fechamento financeiro usa paymentDate, não createdAt
        if (startDate && endDate) {
            // Busca por paymentDate OU createdAt (fallback para registros antigos)
            filters.$or = [
                {
                    paymentDate: {
                        $gte: startDate,
                        $lte: endDate,
                    }
                },
                {
                    // Fallback: se não tiver paymentDate, usa createdAt
                    paymentDate: { $exists: false },
                    createdAt: {
                        $gte: new Date(startDate + 'T00:00:00'),
                        $lte: new Date(endDate + 'T23:59:59')
                    }
                }
            ];
        }

        // 🧾 Busca dos pagamentos com todos os populates que você tinha antes
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
                model: 'Package',
                select:
                    '_id name totalSessions totalPaid balance financialStatus sessionType patient doctor',
                populate: [
                    {
                        path: 'patient',
                        select: '_id fullName phoneNumber',
                        model: 'Patient',
                    },
                    {
                        path: 'doctor',
                        select: '_id fullName specialty',
                        model: 'Doctor',
                    },
                ],
            })
            // 🔎 Sessão principal – agora com mais campos
            .populate({
                path: 'session',
                select: 'date time sessionType status',
                model: 'Session',
            })
            // 📅 Agendamento
            .populate({
                path: 'appointment',
                select: 'date time status',
                model: 'Appointment',
            })
            // 📦 Sessões adiantadas (pacote)
            .populate({
                path: 'advanceSessions.session',
                select: 'date time sessionType status',
                model: 'Session',
            })
            .sort({ createdAt: -1 })
            .lean();

        // ❌ Ignora pagamentos ligados a sessões canceladas
        const validPayments = payments.filter(
            (p) => p.session?.status !== 'canceled'
        );

        if (validPayments.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Nenhum pagamento encontrado',
            });
        }

        // 💰 Totais
        const totalReceived = validPayments.reduce((acc, p) => {
            return p.status === 'paid' ? acc + p.amount : acc;
        }, 0);

        const totalPending = validPayments.reduce((acc, p) => {
            return p.status === 'pending' ? acc + p.amount : acc;
        }, 0);

        // 🎨 Formatação final pro front (mantendo o shape antigo)
        const formattedPayments = validPayments.map((payment) => ({
            ...payment,
            // ⚠️ serviceType continua vindo do próprio Payment (não tiramos nada)
            // ex: payment.serviceType === 'tongue_tie_test'

            patientName: payment.patient?.fullName || 'Não informado',
            doctorName: payment.doctor?.fullName || 'Não informado',
            doctorSpecialty: payment.doctor?.specialty || 'Não informada',
            packageName: payment.package?.name || null,
            formattedDate: new Date(payment.createdAt).toLocaleDateString('pt-BR'),
            formattedAmount: `R$ ${payment.amount.toFixed(2)}`,
            advanceSessions:
                payment.advanceSessions?.map((s) => ({
                    sessionId: s.session?._id,
                    date: s.session?.date,
                    time: s.session?.time,
                    sessionType: s.session?.sessionType,
                    status: s.session?.status,
                    used: s.used,
                })) || [],
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
    console.log('Erro ao exportar CSV:', req.body);

    const executeCriticalOperation = async (entity, filter, update, session) => {
        try {
            return await entity.updateMany(filter, update, { session });
        } catch (error) {
            if (error.code === 112 || error.codeName === 'WriteConflict') {
                console.warn('Conflito detectado em operação crítica. Tentando abordagem alternativa...');
                if (filter._id) {
                    return await entity.updateMany(filter, update, { session });
                } else {
                    const docs = await entity.find(filter).session(session);
                    for (const doc of docs) {
                        await entity.updateOne({ _id: doc._id }, update, { session });
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
            await mongoSession.startTransaction();

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
                    Session,
                    { package: payment.package },
                    {
                        $set: {
                            isPaid: status === 'paid',
                            status: status === 'paid' ? 'completed' : 'pending',
                            updatedAt: currentDate
                        }
                    },
                    mongoSession
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
                    Appointment,
                    { _id: { $in: appointmentIds } },
                    {
                        $set: {
                            paymentStatus: status === 'paid' ? 'paid' : 'pending',
                            operationalStatus: status === 'paid' ? 'confirmed' : 'pending',
                            updatedAt: currentDate
                        }
                    },
                    mongoSession
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
                        paymentDate: moment.tz(currentDate, "America/Sao_Paulo").format("YYYY-MM-DD"),
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
                        paymentMethod: paymentMethod || payment.paymentMethod,
                        isAdvance: true,
                        payment: newPayment._id,
                        status: 'scheduled',
                        isPaid: status === 'paid',
                        paymentStatus: status === 'paid' ? 'paid' : 'pending',
                        visualFlag: status === 'paid' ? 'ok' : 'pending',
                        appointmentId: newAppointment._id,
                        paymentDate: status === 'paid' ? moment.tz(currentDate, "America/Sao_Paulo").format("YYYY-MM-DD") : undefined,
                        createdAt: currentDate,
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

// Novo endpoint simples para marcar como pago
// router.patch('/:id/mark-as-paid' ...)
router.patch('/:id/mark-as-paid', auth, authorize(['admin', 'secretary']), async (req, res) => {
    const session = await mongoose.startSession();

    const runTx = async () => {
        return await session.withTransaction(async () => {
            const id = req.params.id;

            // 0) Idempotência – se já estiver pago, retorna ok
            const existing = await Payment.findById(id).session(session).lean();
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Pagamento não encontrado' });
            }
            if (existing.status === 'paid') {
                return res.json({ success: true, message: 'Pagamento já estava pago', data: existing });
            }

            // 1) Atualiza Payment de forma atômica
            const paidAt = new Date();
            const today = moment.tz(paidAt, "America/Sao_Paulo").format("YYYY-MM-DD"); // ⬅️ Adicionar
            const payment = await Payment.findOneAndUpdate(
                { _id: id, status: { $ne: 'paid' } },
                {
                    $set: {
                        status: 'paid',
                        paidAt,
                        paymentDate: today
                    }
                },
                { new: true, session, runValidators: true }
            );

            if (!payment) {
                // outro processo pode ter pago no meio do caminho
                const latest = await Payment.findById(id).session(session);
                return res.json({ success: true, message: 'Pagamento já foi marcado como pago', data: latest });
            }

            // 2) Atualiza Session (se existir)
            if (payment.session) {
                await Session.updateOne(
                    { _id: payment.session },
                    {
                        $set: {
                            isPaid: true,
                            paymentStatus: 'paid',
                            visualFlag: 'ok',
                            paymentMethod: payment.paymentMethod
                        }
                    },
                    { session }
                );
            }

            // 3) Atualiza Appointment (se existir)
            if (payment.appointment) {
                await Appointment.updateOne(
                    { _id: payment.appointment },
                    {
                        $set: {
                            paymentStatus: 'paid',
                            visualFlag: 'ok',
                            // ⚠️ só mude se sua regra realmente usa 'paid' como estado operacional
                            // operationalStatus: 'paid',
                            paymentMethod: payment.paymentMethod
                        }
                    },
                    { session }
                );
            }

            return res.json({
                success: true,
                message: 'Pagamento marcado como pago com sucesso',
                data: payment
            });
        });
    };

    try {
        let attempt = 0;
        const maxAttempts = 5;

        while (true) {
            try {
                await runTx();
                break; // sucesso
            } catch (e) {
                const msg = String(e?.message || '');
                const isTransient = e?.errorLabels?.includes('TransientTransactionError')
                    || msg.includes('Write conflict')
                    || msg.includes('WriteConflict')
                    || msg.includes('yielding is disabled');

                if (isTransient && attempt < maxAttempts - 1) {
                    attempt += 1;
                    // backoff exponencial simples
                    const delay = 50 * Math.pow(2, attempt);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                throw e; // estoura de vez
            }
        }
    } catch (error) {
        console.error('Erro ao marcar pagamento como pago:', error);
        return res.status(500).json({
            success: false,
            message: 'Erro ao marcar pagamento como pago',
            error: error?.message
        });
    } finally {
        session.endSession();
    }
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
/**
 * @route   GET /api/payments/totals
 * @desc    Retorna totais financeiros com filtros dinâmicos
 * @query   ?period=day|week|month|year|custom
 *          ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (se custom)
 *          ?doctorId=... 
 *          ?paymentMethod=pix|dinheiro|cartão|boleto|transferência
 *          ?serviceType=package|individual_session|evaluation
 *          ?status=paid|pending|partial
 */
router.get("/totals", async (req, res) => {
    try {
        const {
            period = "month",
            startDate,
            endDate,
            doctorId,
            paymentMethod,
            serviceType,
            status,
        } = req.query;

        // ======================================================
        // 🗓️ 1. Definir intervalo de datas
        // ======================================================
        const now = new Date();
        let rangeStart, rangeEnd;

        switch (period) {
            case "day":
                rangeStart = new Date(now.setHours(0, 0, 0, 0));
                rangeEnd = new Date(now.setHours(23, 59, 59, 999));
                break;
            case "week": {
                const day = now.getDay();
                const diff = now.getDate() - day + (day === 0 ? -6 : 1);
                rangeStart = new Date(now.setDate(diff));
                rangeStart.setHours(0, 0, 0, 0);
                rangeEnd = new Date(rangeStart);
                rangeEnd.setDate(rangeStart.getDate() + 6);
                rangeEnd.setHours(23, 59, 59, 999);
                break;
            }
            case "month":
                rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
                rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
                break;
            case "year":
                rangeStart = new Date(now.getFullYear(), 0, 1);
                rangeEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
                break;
            case "custom":
                rangeStart = startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
                rangeEnd = endDate ? new Date(endDate) : new Date();
                break;
            default:
                rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
                rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        }

        // ======================================================
        // 🎛️ 2. Filtros dinâmicos
        // ======================================================
        // 🔹 Filtro por data de pagamento/atendimento (paymentDate) quando disponível
        // ou createdAt como fallback para registros antigos
        const matchStage = {
            $or: [
                // Preferência: paymentDate (data do atendimento)
                {
                    paymentDate: {
                        $gte: rangeStart.toISOString().split('T')[0],
                        $lte: rangeEnd.toISOString().split('T')[0]
                    }
                },
                // Fallback: createdAt para registros antigos sem paymentDate
                {
                    paymentDate: { $exists: false },
                    createdAt: { $gte: rangeStart, $lte: rangeEnd }
                }
            ]
        };

        // 🔹 Caso o período seja "all", remove o filtro de data
        if (period === "all") {
            delete matchStage.$or;
        }

        if (doctorId) matchStage.doctor = new mongoose.Types.ObjectId(doctorId);
        if (paymentMethod) matchStage.paymentMethod = paymentMethod;
        if (serviceType) matchStage.serviceType = serviceType;
        if (status) matchStage.status = status;

        // ======================================================
        // 💰 3. Agregação principal - CAIXA (dinheiro recebido)
        // ======================================================
        const cashAggregation = [
            { $match: matchStage },
            {
                $group: {
                    _id: null,
                    totalReceived: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
                    totalPending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] } },
                    totalPartial: { $sum: { $cond: [{ $eq: ["$status", "partial"] }, "$amount", 0] } },
                    countReceived: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
                    countPending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                    countPartial: { $sum: { $cond: [{ $eq: ["$status", "partial"] }, 1, 0] } },
                },
            },
        ];

        const cashResult = await Payment.aggregate(cashAggregation);
        console.log("💰 Cash Result:", cashResult);
        const cashTotals = cashResult[0] || {
            totalReceived: 0,
            totalPending: 0,
            totalPartial: 0,
            countReceived: 0,
            countPending: 0,
            countPartial: 0,
        };

        // ======================================================
        // 🏥 4. Agregação de PRODUÇÃO DE CONVÊNIOS
        // Busca convênios realizados no período (independentemente de pagamento)
        // ======================================================
        const insuranceMatchStage = {
            ...matchStage,
            billingType: 'convenio',
            // Inclui todos os convênios do período: pending, billed, received, etc.
        };

        // Remove filtro de status para incluir todos os convênios
        delete insuranceMatchStage.status;

        console.log("🔍 Insurance Match Stage:", JSON.stringify(insuranceMatchStage, null, 2));

        const insuranceAggregation = [
            { $match: insuranceMatchStage },
            {
                $group: {
                    _id: null,
                    // Produção total: soma grossAmount se existir, senão usa amount (para registros antigos)
                    totalInsuranceProduction: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ["$insurance", null] },
                                        { $gt: ["$insurance.grossAmount", 0] }
                                    ]
                                },
                                "$insurance.grossAmount",
                                { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] }
                            ]
                        }
                    },
                    totalInsuranceReceived: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ["$insurance", null] },
                                        { $eq: ["$insurance.status", "received"] }
                                    ]
                                },
                                { $ifNull: ["$insurance.receivedAmount", "$amount"] },
                                0
                            ]
                        }
                    },
                    totalInsurancePending: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ["$insurance", null] },
                                        { $in: ["$insurance.status", ["pending_billing", "billed"]] }
                                    ]
                                },
                                "$insurance.grossAmount",
                                { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] }
                            ]
                        }
                    },
                    countInsuranceTotal: { $sum: 1 },
                    countInsuranceReceived: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ["$insurance", null] },
                                        { $eq: ["$insurance.status", "received"] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    },
                    countInsurancePending: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ["$insurance", null] },
                                        { $in: ["$insurance.status", ["pending_billing", "billed"]] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    },
                },
            },
        ];

        const insuranceResult = await Payment.aggregate(insuranceAggregation);
        console.log("🏥 Insurance Result:", insuranceResult);
        const insuranceTotals = insuranceResult[0] || {
            totalInsuranceProduction: 0,
            totalInsuranceReceived: 0,
            totalInsurancePending: 0,
            countInsuranceTotal: 0,
            countInsuranceReceived: 0,
            countInsurancePending: 0,
        };

        // ======================================================
        // 📊 Totals consolidados
        // ======================================================
        const totals = {
            // Caixa (dinheiro efetivamente recebido)
            totalReceived: cashTotals.totalReceived,
            totalPending: cashTotals.totalPending,
            totalPartial: cashTotals.totalPartial,
            countReceived: cashTotals.countReceived,
            countPending: cashTotals.countPending,
            countPartial: cashTotals.countPartial,

            // Produção de Convênios (atendimentos realizados)
            totalInsuranceProduction: insuranceTotals.totalInsuranceProduction,
            totalInsuranceReceived: insuranceTotals.totalInsuranceReceived,
            totalInsurancePending: insuranceTotals.totalInsurancePending,
            countInsuranceTotal: insuranceTotals.countInsuranceTotal,
            countInsuranceReceived: insuranceTotals.countInsuranceReceived,
            countInsurancePending: insuranceTotals.countInsurancePending,

            // Total combinado (caixa + produção de convênios)
            totalCombined: cashTotals.totalReceived + insuranceTotals.totalInsuranceProduction,
        };

        // ======================================================
        // 📊 4. Agrupamento temporal (para gráficos)
        // Usa paymentDate como string e extrai ano/mês/dia
        // ======================================================
        const breakdown = await Payment.aggregate([
            { $match: matchStage },
            {
                $addFields: {
                    // Converte paymentDate (string) para Date se existir, senão usa createdAt
                    effectiveDate: {
                        $cond: [
                            { $and: [{ $ne: ["$paymentDate", null] }, { $ne: ["$paymentDate", ""] }] },
                            { $dateFromString: { dateString: "$paymentDate", onError: "$createdAt" } },
                            "$createdAt"
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: {
                        year: { $year: "$effectiveDate" },
                        month: { $month: "$effectiveDate" },
                        day: { $dayOfMonth: "$effectiveDate" },
                    },
                    totalPaid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
                    totalPending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] } },
                    totalPartial: { $sum: { $cond: [{ $eq: ["$status", "partial"] }, "$amount", 0] } },
                },
            },
            { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
        ]);

        // ======================================================
        // 🧾 5. Agrupamento por método de pagamento
        // ======================================================
        const byMethod = await Payment.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: "$paymentMethod",
                    total: { $sum: "$amount" },
                    count: { $sum: 1 },
                },
            },
            { $sort: { total: -1 } },
        ]);

        // ======================================================
        // 🎯 6. Agrupamento por tipo de serviço
        // ======================================================
        const byServiceType = await Payment.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: "$serviceType",
                    total: { $sum: "$amount" },
                    count: { $sum: 1 },
                },
            },
            { $sort: { total: -1 } },
        ]);

        // ======================================================
        // ✅ 7. Retorno final
        // ======================================================
        console.log("📊 /totals response:", { totals, dateRange: { start: rangeStart, end: rangeEnd } });
        res.status(200).json({
            success: true,
            filters: {
                period,
                doctorId,
                paymentMethod,
                serviceType,
                status,
                dateRange: {
                    start: rangeStart.toISOString(),
                    end: rangeEnd.toISOString(),
                },
            },
            data: {
                totals,
                byMethod,
                byServiceType,
                breakdown,
            },
        });
    } catch (err) {
        console.error("❌ Erro ao calcular totais financeiros:", err);
        res.status(500).json({
            success: false,
            message: "Erro ao calcular totais financeiros",
            error: err.message,
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

// ======================================================
// 📅 ROTA: FECHAMENTO DIÁRIO
// ======================================================
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

        console.time("⏱️ Query Sessions");
        const sessions = await Session.find({ date: targetDate })
            .populate("package patient doctor appointmentId")
            .lean();
        console.timeEnd("⏱️ Query Sessions");

        console.time("⏱️ Bulk Update Appointments");
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
                                    paymentStatus: paidLike
                                        ? (s.paymentStatus || 'paid')
                                        : (s.paymentStatus || 'pending'),
                                    operationalStatus: mapStatusToOperational(s.status),
                                    clinicalStatus: mapStatusToClinical(s.status),
                                }
                            }
                        }
                    };
                });

            if (bulkOps.length > 0) {
                await Appointment.bulkWrite(bulkOps, { ordered: false });
            }
        }
        console.timeEnd("⏱️ Bulk Update Appointments");

        // ======================================================
        // 🔹 QUERIES PARALELAS (mantém performance)
        // ======================================================
        console.time("⏱️ Parallel Queries");
        const [appointments, payments] = await Promise.all([
            Appointment.find({ date: targetDate })
                .populate("doctor patient package")
                .lean(),

            Payment.find({
                status: { $in: ["paid", "package_paid"] },
                $or: [
                    // ✅ NOVO: paymentDate como Date
                    {
                        paymentDate: { $gte: startOfDay, $lte: endOfDay }
                    },

                    // ✅ paymentDate string (modelo atual)
                    { paymentDate: targetDate },

                    // ✅ legado: sem paymentDate → usa createdAt
                    {
                        paymentDate: { $exists: false },
                        createdAt: { $gte: startOfDay, $lte: endOfDay },
                    },
                ],
            })
                .populate("patient doctor package appointment")
                .lean()
        ]);

        console.timeEnd("⏱️ Parallel Queries");

        // ======================================================
        // 🔹 HELPERS
        // ======================================================
        const getPaymentDate = (pay) => {
            if (!pay) return null;
            if (typeof pay.paymentDate === "string" && pay.paymentDate.trim()) {
                return pay.paymentDate; // 🔥 SEM USAR appointment.date
            }
            return moment(pay.createdAt).tz("America/Sao_Paulo").format("YYYY-MM-DD");
        };


        const normalizePaymentMethod = (method) => {
            if (!method) return "dinheiro";
            method = String(method).toLowerCase().trim();
            if (method.includes("pix")) return "pix";
            if (
                method.includes("cartão") || method.includes("cartao") ||
                method.includes("card") || method.includes("credito") ||
                method.includes("débito") || method.includes("debito")
            ) return "cartão";
            return "dinheiro";
        };

        const isCanceled = (status) =>
            ["canceled"].includes((status || "").toLowerCase());
        const isConfirmed = (status) =>
            ["confirmed"].includes((status || "").toLowerCase());
        const isCompleted = (status) =>
            ["completed"].includes((status || "").toLowerCase());

        // ======================================================
        // 🔥 FILTRO CORRIGIDO - Remove restrição de patientIdsOfDay
        // ======================================================
        const filteredPayments = payments.filter((p) => {
            const payDate = getPaymentDate(p);
            const isTargetDate = payDate === targetDate;

            // 🏥 Convênio só entra no caixa quando recebido
            if (p.billingType === 'convenio') {
                const isReceived = p.insurance?.status === 'received';
                const receivedToday = p.insurance?.receivedAt &&
                    moment(p.insurance.receivedAt).format('YYYY-MM-DD') === targetDate;
                return receivedToday && isReceived;
            }

            return isTargetDate;
        });

        console.log(`\n📊 RESUMO PAGAMENTOS:`);
        console.log(`   Total buscados: ${payments.length}`);
        console.log(`   Filtrados do dia: ${filteredPayments.length}`);
        console.log(`   Total em dinheiro: R$${filteredPayments.reduce((sum, p) => sum + (p.amount || 0), 0)}\n`);

        // ======================================================
        // 🔹 MAPS para performance O(1)
        // ======================================================
        const paymentsByAppt = new Map();
        const paymentsByPackage = new Map();
        const paymentsByPatient = new Map();

        filteredPayments.forEach(p => {
            // Por appointment
            const apptId = p.appointment?._id?.toString();
            if (apptId) {
                if (!paymentsByAppt.has(apptId)) paymentsByAppt.set(apptId, []);
                paymentsByAppt.get(apptId).push(p);
            }

            // Por package
            const pkgId = p.package?._id?.toString();
            if (pkgId) {
                if (!paymentsByPackage.has(pkgId)) paymentsByPackage.set(pkgId, []);
                paymentsByPackage.get(pkgId).push(p);
            }

            // Por patient
            const patId = p.patient?._id?.toString();
            if (patId) {
                if (!paymentsByPatient.has(patId)) paymentsByPatient.set(patId, []);
                paymentsByPatient.get(patId).push(p);
            }
        });

        // ======================================================
        // 🔹 ESTRUTURA INICIAL
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
                    pendingValue: 0,
                    pendingCount: 0,
                },
                payments: {
                    totalReceived: 0,
                    byMethod: { dinheiro: 0, pix: 0, cartão: 0 },
                },
            },
            financial: {
                totalReceived: 0,
                totalExpected: 0,
                totalRevenue: 0,
                paymentMethods: {
                    dinheiro: { amount: 0, details: [] },
                    pix: { amount: 0, details: [] },
                    cartão: { amount: 0, details: [] },
                },
                packages: { total: 0, details: [] },
            },
            timelines: {
                appointments: [],
                payments: [],
            },
            professionals: [],
            timeSlots: [],
        };

        // ======================================================
        // 🔹 PROCESSAR APPOINTMENTS
        // ======================================================
        for (const appt of appointments) {
            const opStatus = (appt.operationalStatus || "").toLowerCase();
            const clinicalStatus = (appt.clinicalStatus || "").toLowerCase();
            const doctorName = appt.doctor?.fullName || "Não informado";
            const patientName = appt.patient?.fullName || "Não informado";
            const isPackage = appt.serviceType === "package_session";

            // 🔗 Buscar pagamentos relacionados (3 vias)
            const apptId = appt._id.toString();
            const pkgId = appt.package?._id?.toString();
            const patId = appt.patient?._id?.toString();

            const allRelatedPays = [
                ...(paymentsByAppt.get(apptId) || []),
                ...(pkgId ? (paymentsByPackage.get(pkgId) || []) : []),
                ...(patId ? (paymentsByPatient.get(patId) || []) : [])
            ];

            // Deduplica por _id
            const uniquePays = [...new Map(
                allRelatedPays.map(p => [p._id.toString(), p])
            ).values()];

            const relatedPayToday = uniquePays.find((p) => getPaymentDate(p) === targetDate);
            const relatedPayAnyDay = uniquePays.find((p) => getPaymentDate(p) !== null);

            const method = relatedPayToday
                ? normalizePaymentMethod(relatedPayToday.paymentMethod)
                : normalizePaymentMethod(appt.package?.paymentMethod || appt.paymentMethod || "—");

            const paidStatus = relatedPayToday
                ? "Pago no dia"
                : (relatedPayAnyDay ? "Pago antes" : "Pendente");

            const sessionValue = Number(appt.sessionValue || 0);

            // Atualizar contadores
            report.summary.appointments.total++;
            if (isCanceled(opStatus)) report.summary.appointments.canceled++;
            else if (isConfirmed(opStatus) || isCompleted(clinicalStatus))
                report.summary.appointments.attended++;
            else report.summary.appointments.pending++;

            report.summary.appointments.expectedValue += sessionValue;

            // Timeline
            report.timelines.appointments.push({
                id: apptId,
                patient: patientName,
                service: appt.serviceType,
                doctor: doctorName,
                sessionValue,
                method,
                paidStatus,
                operationalStatus: opStatus,
                clinicalStatus,
                displayStatus: paidStatus,
                date: appt.date,
                time: appt.time,
                isPackage,
                paymentMethod: method,
                packageId: pkgId || null,
            });
        }

        // ======================================================
        // 🔹 PROCESSAR PAGAMENTOS
        // ======================================================
        for (const pay of filteredPayments) {
            const paymentDate = getPaymentDate(pay);
            if (paymentDate !== targetDate) continue;

            const amount = Number(pay.amount || 0);
            const method = normalizePaymentMethod(pay.paymentMethod);
            const type = pay.serviceType || "outro";
            const patient = pay.patient?.fullName || "Avulso";
            const doctor = pay.doctor?.fullName || "Não vinculado";

            // Totais
            report.summary.payments.totalReceived += amount;
            report.summary.payments.byMethod[method] += amount;
            report.financial.totalReceived += amount;
            report.financial.paymentMethods[method].amount += amount;
            report.financial.paymentMethods[method].details.push({
                id: pay._id.toString(),
                type,
                patient,
                value: amount,
                method,
                createdAt: pay.createdAt,
                doctor,
                status: pay.status,
                paymentDate,
                referenceDate: pay.appointment?.date || null,
                isAdvancePayment: pay.isAdvance || false,
                appointmentId: pay.appointment?._id?.toString() || null,
            });

            if (type === "package_session" && pay.package) {
                report.financial.packages.total += amount;
                report.financial.packages.details.push({
                    id: pay._id.toString(),
                    patient,
                    value: amount,
                    method,
                    sessions: pay.package?.totalSessions || 0,
                    sessionValue: pay.package?.sessionValue || 0,
                    date: paymentDate,
                    packageId: pay.package._id.toString(),
                });
            }

            report.timelines.payments.push({
                id: pay._id.toString(),
                patient,
                type,
                method,
                value: amount,
                paymentDate,
                doctor,
                serviceType: pay.serviceType || null,
            });
        }

        // ======================================================
        // 🧮 CÁLCULOS FINAIS
        // ======================================================
        const validAppointments = report.timelines.appointments.filter(
            (a) => !isCanceled(a.operationalStatus)
        );

        report.financial.totalExpected = validAppointments.reduce(
            (sum, a) => sum + (a.sessionValue || 0),
            0
        );

        report.financial.totalRevenue = validAppointments
            .filter((a) => a.paidStatus === "Pendente")
            .reduce((sum, a) => sum + (a.sessionValue || 0), 0);

        report.summary.appointments.pendingCount = validAppointments.filter(
            (a) => a.paidStatus === "Pendente"
        ).length;

        // ======================================================
        // 🔹 MONTAR RELATÓRIOS POR PROFISSIONAL E HORÁRIOS
        // ======================================================
        const professionalsMap = {};
        const timeSlotsMap = {};

        report.timelines.appointments.forEach((appt) => {
            const doctor = appt.doctor || "Não informado";
            const time = (appt.time || "").substring(0, 5);
            const value = appt.sessionValue || 0;

            if (!professionalsMap[doctor]) {
                professionalsMap[doctor] = {
                    name: doctor,
                    appointments: [],
                    confirmed: 0,
                    canceled: 0,
                    scheduled: 0,
                    totalValue: 0,
                };
            }

            professionalsMap[doctor].appointments.push(appt);
            if (isConfirmed(appt.operationalStatus))
                professionalsMap[doctor].confirmed++;
            else if (isCanceled(appt.operationalStatus))
                professionalsMap[doctor].canceled++;
            else professionalsMap[doctor].scheduled++;
            professionalsMap[doctor].totalValue += value;

            if (!timeSlotsMap[time]) {
                timeSlotsMap[time] = {
                    time,
                    appointments: [],
                    count: 0,
                    stats: {
                        confirmed: 0,
                        canceled: 0,
                        scheduled: 0,
                        revenueReceived: 0,
                        professionals: [],
                    },
                };
            }

            const slot = timeSlotsMap[time];
            slot.appointments.push(appt);
            slot.count++;
            if (isConfirmed(appt.operationalStatus)) slot.stats.confirmed++;
            else if (isCanceled(appt.operationalStatus)) slot.stats.canceled++;
            else slot.stats.scheduled++;
            if (appt.paidStatus === "Pago no dia")
                slot.stats.revenueReceived += value;
            if (!slot.stats.professionals.includes(doctor))
                slot.stats.professionals.push(doctor);
        });

        report.professionals = Object.values(professionalsMap).map((prof) => {
            const totalSessions = prof.appointments.length;
            const efficiency =
                totalSessions > 0 ? (prof.confirmed / totalSessions) * 100 : 0;
            return { ...prof, sessionCount: totalSessions, efficiency };
        });

        report.timeSlots = Object.values(timeSlotsMap)
            .map((slot) => {
                const total = slot.stats.confirmed + slot.stats.scheduled;
                const confirmationRate = total > 0 ? (slot.stats.confirmed / total) * 100 : 0;
                return {
                    ...slot,
                    totalSessions: slot.count,
                    stats: {
                        ...slot.stats,
                        confirmationRate,
                        occupancy: (slot.count / 10) * 100,
                    },
                };
            })
            .sort((a, b) => a.time.localeCompare(b.time));

        // ======================================================
        // 🔹 LOGS FINAIS
        // ======================================================
        console.log("\n📊 FECHAMENTO FINAL", targetDate);
        console.log("✅ Agendamentos válidos:", validAppointments.length);
        console.log("💰 Recebido:", report.financial.totalReceived);
        console.log("📅 Previsto:", report.financial.totalExpected);
        console.log("⏳ A receber:", report.financial.totalRevenue);
        console.log("📦 Pagamentos processados:", filteredPayments.length);

        // ======================================================
        // 🔹 RETORNO
        // ======================================================
        res.json({
            success: true,
            data: report,
            meta: {
                generatedAt: new Date().toISOString(),
                recordCount: {
                    appointments: appointments.length,
                    payments: filteredPayments.length,
                    professionals: report.professionals.length,
                    timeSlots: report.timeSlots.length,
                },
            },
        });
    } catch (error) {
        console.error("❌ Erro no fechamento diário:", error);
        res.status(500).json({
            success: false,
            error: "Erro ao gerar relatório diário",
            details: process.env.NODE_ENV === "development" ? error.message : undefined,
        });
    }
});


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
            .populate("patient doctor package appointment advancedSessions")
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

        console.log('💰 Iniciando registro de pagamento:', req.body);

        // 1️⃣ Validação
        if (!packageId || !amount || amount <= 0 || !patientId || !doctorId || !serviceType) {
            return res.status(400).json({
                success: false,
                message: 'Campos obrigatórios faltando ou inválidos.',
            });
        }

        // 2️⃣ Buscar pacote e sessões
        const pkg = await Package.findById(packageId)
            .populate('sessions')
            .session(mongoSession);

        if (!pkg) {
            return res.status(404).json({ success: false, message: 'Pacote não encontrado.' });
        }

        const totalValue = pkg.totalValue ?? pkg.totalSessions * pkg.sessionValue;
        const balance = pkg.balance ?? Math.max(totalValue - pkg.totalPaid, 0);

        console.log(`📦 Pacote atual: total R$${totalValue} | saldo R$${balance}`);

        let remaining = amount;

        // 3️⃣ Aplicar pagamento no pacote atual
        const applied = Math.min(remaining, balance);
        const newTotalPaid = pkg.totalPaid + applied;
        const newBalance = Math.max(totalValue - newTotalPaid, 0);
        const status = newBalance === 0 ? 'paid' : 'partial';

        // 4️⃣ Registrar pagamento principal
        const parentPayment = await Payment.create(
            [{
                patient: patientId,
                doctor: doctorId,
                serviceType,
                amount: applied,
                paymentMethod,
                notes: note || '',
                status,
                package: packageId,
                createdAt: new Date(),
                paymentDate: paymentDate || new Date(),
            }],
            { session: mongoSession }
        );

        // 5️⃣ Distribuir valor nas sessões (se aplicável)
        const updatedPackage = await distributePayments(
            pkg._id,
            applied,
            mongoSession,
            parentPayment[0]._id
        );

        // 6️⃣ Atualizar pacote
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

        remaining -= applied;
        let newPackage = null;

        // 8️⃣ Caso haja excedente → criar novo pacote automático (cenário C)
        if (remaining > 0) {
            console.log(`💡 Valor excedente detectado: R$${remaining}`);

            const result = await createNextPackageFromPrevious(pkg, remaining, {
                session: mongoSession,
                paymentMethod,
                serviceType,
                paymentDate,
                notes: 'Pagamento adiantado após quitação do pacote anterior',
            });

            newPackage = result.newPackage;

            console.log(
                `✅ Novo pacote criado automaticamente: ${newPackage._id} | Início: ${newPackage.startDate}`
            );
        }

        // 9️⃣ Commit
        await mongoSession.commitTransaction();
        transactionCommitted = true;

        const finalPackage = await Package.findById(pkg._id)
            .populate('sessions payments')
            .lean();

        console.log(`
💳 Pagamento registrado:
📦 Pacote: ${packageId}
🧍 Paciente: ${patientId}
👩‍⚕️ Doutor: ${doctorId}
💰 Valor: R$${amount}
💳 Método: ${paymentMethod}
📅 Data: ${paymentDate}
`);

        return res.status(201).json({
            success: true,
            message:
                remaining > 0
                    ? 'Pagamento quitado e novo pacote criado automaticamente 💚'
                    : 'Pagamento registrado e distribuído com sucesso 💚',
            data: {
                currentPackage: {
                    id: pkg._id,
                    status: newBalance === 0 ? 'paid' : 'partial',
                    balance: newBalance,
                    totalPaid: newTotalPaid,
                },
                updatedPackage: finalPackage,
                ...(newPackage && { newPackage }),
            },
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

// ============================================================
// 🏥 CONVÊNIOS - Endpoints
// ============================================================

/**
 * POST /api/payments/insurance
 * Registra atendimento de convênio (amount = 0 no dia)
 */
router.post('/insurance', auth, async (req, res) => {
    try {
        const {
            patientId,
            doctorId,
            sessionId,
            packageId,
            serviceType = 'session',
            insuranceProvider,
            grossAmount,
            authorizationCode,
            paymentDate,
            notes
        } = req.body;

        // Validação
        if (!patientId || !doctorId || !insuranceProvider || !grossAmount) {
            return res.status(400).json({
                success: false,
                message: 'Campos obrigatórios: patientId, doctorId, insuranceProvider, grossAmount'
            });
        }

        const payment = await Payment.create({
            patient: patientId,
            doctor: doctorId,
            session: sessionId || null,
            package: packageId || null,
            serviceType,
            amount: 0, // ← Zerado no dia!
            paymentMethod: 'convenio',
            billingType: 'convenio',
            status: 'pending',
            paymentDate: paymentDate || moment().tz('America/Sao_Paulo').format('YYYY-MM-DD'),
            notes,
            insurance: {
                provider: insuranceProvider,
                grossAmount,
                authorizationCode: authorizationCode || null,
                status: 'pending_billing',
                expectedReceiptDate: moment().add(1, 'month').endOf('month').toDate()
            }
        });

        // Atualiza sessão como realizada (mas não paga)
        if (sessionId) {
            await Session.findByIdAndUpdate(sessionId, {
                status: 'completed',
                isPaid: false,
                paymentStatus: 'pending',
                billingType: 'convenio'
            });
        }

        const populated = await Payment.findById(payment._id)
            .populate('patient', 'fullName')
            .populate('doctor', 'fullName');

        res.status(201).json({
            success: true,
            message: 'Atendimento convênio registrado (aguardando faturamento)',
            data: populated
        });
    } catch (error) {
        console.error('❌ Erro ao registrar convênio:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/payments/insurance/receivables
 * Lista contas a receber de convênios - COM POPULATE DE PACIENTE
 */
router.get('/insurance/receivables', auth, async (req, res) => {
    try {
        const { provider, status } = req.query;

        const match = {
            billingType: 'convenio',
            'insurance.status': { $in: status ? [status] : ['pending_billing', 'billed'] }
        };

        if (provider) match['insurance.provider'] = provider;

        const receivables = await Payment.aggregate([
            { $match: match },
            // Fazer lookup do paciente
            {
                $lookup: {
                    from: 'patients',
                    localField: 'patient',
                    foreignField: '_id',
                    as: 'patientInfo'
                }
            },
            // Desestruturar o array do lookup
            {
                $addFields: {
                    patientName: { $arrayElemAt: ['$patientInfo.fullName', 0] }
                }
            },
            // Agrupar por convênio
            {
                $group: {
                    _id: '$insurance.provider',
                    totalPending: { $sum: '$insurance.grossAmount' },
                    count: { $sum: 1 },
                    payments: {
                        $push: {
                            paymentId: '$_id',
                            patient: '$patient',
                            patientName: { $ifNull: ['$patientName', 'N/A'] },
                            grossAmount: '$insurance.grossAmount',
                            status: '$insurance.status',
                            paymentDate: '$paymentDate',
                            authorizationCode: '$insurance.authorizationCode'
                        }
                    }
                }
            },
            { $sort: { totalPending: -1 } }
        ]);

        const grandTotal = receivables.reduce((sum, r) => sum + r.totalPending, 0);

        res.json({
            success: true,
            data: receivables,
            summary: {
                totalProviders: receivables.length,
                grandTotal
            }
        });
    } catch (error) {
        console.error('❌ Erro ao buscar recebíveis:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * PATCH /api/payments/insurance/:id/receive
 * Marca convênio como recebido (entra no caixa)
 */
router.patch('/insurance/:id/receive', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { receivedAmount, receivedDate, notes } = req.body;

        const payment = await Payment.findById(id);

        if (!payment || payment.billingType !== 'convenio') {
            return res.status(404).json({
                success: false,
                message: 'Pagamento de convênio não encontrado'
            });
        }

        const finalAmount = receivedAmount ?? payment.insurance.grossAmount;
        const isGlosa = receivedAmount !== undefined && receivedAmount < payment.insurance.grossAmount;

        payment.amount = finalAmount; // ← Agora entra no caixa!
        payment.status = 'paid';
        payment.insurance.status = isGlosa ? 'partial' : 'received';
        payment.insurance.receivedAt = receivedDate ? new Date(receivedDate) : new Date();
        payment.insurance.receivedAmount = finalAmount;

        if (isGlosa && notes) {
            payment.insurance.glosaReason = notes;
        }

        await payment.save();

        // Atualiza sessão como paga
        if (payment.session) {
            await Session.findByIdAndUpdate(payment.session, {
                isPaid: true,
                paymentStatus: 'paid'
            });
        }

        res.json({
            success: true,
            message: isGlosa
                ? `Convênio recebido com glosa (R$${finalAmount} de R$${payment.insurance.grossAmount})`
                : 'Convênio recebido integralmente',
            data: payment
        });
    } catch (error) {
        console.error('❌ Erro ao registrar recebimento:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * PATCH /api/payments/insurance/:id/bill
 * Marca como faturado (enviado pro convênio)
 */
router.patch('/insurance/:id/bill', auth, async (req, res) => {
    try {
        const { id } = req.params;

        const payment = await Payment.findByIdAndUpdate(
            id,
            {
                'insurance.status': 'billed',
                'insurance.billedAt': new Date()
            },
            { new: true }
        );

        if (!payment) {
            return res.status(404).json({ success: false, message: 'Não encontrado' });
        }

        res.json({
            success: true,
            message: 'Marcado como faturado',
            data: payment
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ======================================================================
// SALDO DEVEDOR / CONTA CORRENTE (consolidado de patientBalance.js)
// ======================================================================

import PatientBalance from '../models/PatientBalance.js';

// Helper
async function getOrCreateBalance(patientId) {
    return await PatientBalance.getOrCreate(patientId);
}

// GET /api/payments/balance/:patientId
router.get('/balance/:patientId', auth, async (req, res) => {
    try {
        const { patientId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ success: false, message: 'ID inválido' });
        }

        const balance = await PatientBalance.findOne({ patient: patientId })
            .populate('transactions.sessionId', 'date time status')
            .populate('transactions.appointmentId', 'date time operationalStatus')
            .populate('transactions.registeredBy', 'fullName name');

        if (!balance) {
            return res.json({
                success: true,
                data: { patient: patientId, currentBalance: 0, hasDebt: false, hasCredit: false, transactions: [] }
            });
        }

        res.json({ success: true, data: balance });
    } catch (error) {
        console.error('Erro ao buscar saldo:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar saldo' });
    }
});

// POST /api/payments/balance/:patientId/debit
router.post('/balance/:patientId/debit', auth, async (req, res) => {
    const mongoSession = await mongoose.startSession();
    try {
        await mongoSession.startTransaction();
        const { patientId } = req.params;
        const { amount, description, sessionId, appointmentId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(patientId) || !amount || amount <= 0) {
            await mongoSession.abortTransaction();
            return res.status(400).json({ success: false, message: 'Dados inválidos' });
        }

        // 🚀 OTIMIZAÇÃO: Usar updateOne dentro da transação (atômico)
        const newTransaction = {
            type: 'debit',
            amount,
            description: description || 'Sessão utilizada - pagamento pendente',
            sessionId: sessionId || null,
            appointmentId: appointmentId || null,
            registeredBy: req.user?._id || null,
            transactionDate: new Date()
        };

        const result = await PatientBalance.findOneAndUpdate(
            { patient: patientId },
            {
                $push: { transactions: newTransaction },
                $inc: { currentBalance: amount, totalDebited: amount },
                $set: { lastTransactionAt: new Date() }
            },
            { 
                upsert: true, 
                new: true,
                session: mongoSession 
            }
        );

        if (sessionId) {
            await Session.findByIdAndUpdate(sessionId, {
                $set: { addedToBalance: true, balanceRegisteredAt: new Date() }
            }, { session: mongoSession });
        }

        await mongoSession.commitTransaction();
        res.json({
            success: true,
            message: 'Débito registrado',
            data: { 
                currentBalance: result.currentBalance, 
                transaction: result.transactions[result.transactions.length - 1] 
            }
        });
    } catch (error) {
        await mongoSession.abortTransaction();
        console.error('❌ Erro ao registrar débito:', error);
        res.status(500).json({ success: false, message: 'Erro ao registrar débito' });
    } finally {
        await mongoSession.endSession();
    }
});

// POST /api/payments/balance/:patientId/payment
router.post('/balance/:patientId/payment', auth, async (req, res) => {
    const mongoSession = await mongoose.startSession();
    try {
        await mongoSession.startTransaction();
        const { patientId } = req.params;
        const { amount, paymentMethod, description, sessionId, appointmentId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(patientId) || !amount || amount <= 0) {
            await mongoSession.abortTransaction();
            return res.status(400).json({ success: false, message: 'Dados inválidos' });
        }

        const balance = await getOrCreateBalance(patientId);
        if (amount > balance.currentBalance) {
            await mongoSession.abortTransaction();
            return res.status(400).json({ success: false, message: 'Valor excede saldo devedor' });
        }

        await balance.addPayment(amount, paymentMethod || 'dinheiro', description || 'Pagamento saldo devedor', req.user?._id);
        const transaction = balance.transactions[balance.transactions.length - 1];

        if (sessionId) {
            await Session.findByIdAndUpdate(sessionId, {
                $set: { isPaid: true, paymentStatus: 'paid', visualFlag: 'ok', paidAt: new Date() }
            }, { session: mongoSession });
        }
        if (appointmentId) {
            await Appointment.findByIdAndUpdate(appointmentId, {
                $set: { paymentStatus: 'paid', visualFlag: 'ok', paidAt: new Date() },
                $push: { history: { action: 'payment_received', newStatus: 'paid', changedBy: req.user?._id, timestamp: new Date(), context: 'financial' } }
            }, { session: mongoSession });
        }

        await mongoSession.commitTransaction();
        res.json({ success: true, message: 'Pagamento registrado', data: { currentBalance: balance.currentBalance, transaction } });
    } catch (error) {
        await mongoSession.abortTransaction();
        res.status(500).json({ success: false, message: 'Erro ao registrar pagamento' });
    } finally {
        await mongoSession.endSession();
    }
});

// GET /api/payments/balance/debtors
router.get('/balance/debtors', auth, async (req, res) => {
    try {
        const debtors = await PatientBalance.find({ currentBalance: { $gt: 0 } })
            .populate('patient', 'fullName phone email')
            .sort({ currentBalance: -1 });
        res.json({ success: true, count: debtors.length, data: debtors });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao buscar devedores' });
    }
});

export default router;

