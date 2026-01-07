import dotenv from 'dotenv';
import express from 'express';
import moment from 'moment-timezone';
import mongoose from 'mongoose';
import { handleAdvancePayment } from '../helpers/handleAdvancePayment.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { auth } from '../middleware/auth.js';
import { checkPackageAvailability } from '../middleware/checkPackageAvailability.js';
import { checkAppointmentConflicts, getAvailableTimeSlots } from '../middleware/conflictDetection.js';
import validateId from '../middleware/validateId.js';
import { validateIndividualPayment } from '../middleware/validateIndividualPayment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { handlePackageSessionUpdate, syncEvent } from '../services/syncService.js';
import { updateAppointmentFromSession, updatePatientAppointments } from '../utils/appointmentUpdater.js';
import { runTransactionWithRetry } from '../utils/transactionRetry.js';

dotenv.config();
const router = express.Router();

// Verifica horários disponíveis
router.get('/available-slots', flexibleAuth, getAvailableTimeSlots);

// Cria um novo agendamento
router.post('/', flexibleAuth, checkAppointmentConflicts, async (req, res) => {
    const {
        patientId,
        doctorId,
        serviceType,
        paymentMethod,
        status = 'scheduled',
        notes,
        packageId,
        sessionId,
        specialty,
        sessionType,
        isAdvancePayment = false,
        advanceSessions = [],
    } = req.body;
    console.log("DEBUG IDS", {
        patientId, doctorId, packageId, sessionId,
        t_patientId: typeof patientId,
        t_doctorId: typeof doctorId,
        t_packageId: typeof packageId,
        t_sessionId: typeof sessionId,
    });
    const amount = parseFloat(req.body.paymentAmount) || 0;
    const currentDate = new Date();
    const safeId = (v) => {
        if (v === false || v === true) return null;
        if (v === "false" || v === "true") return null;
        if (v === "" || v === undefined || v === null) return null;
        return v;
    };

    let individualSessionId = null;
    let createdAppointmentId = null;
    let createdPaymentId = null; // 👈 NOVO: guardar o ID do pagamento

    try {
        // 🔹 Validação básica
        if (!patientId || !doctorId || !serviceType || !paymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Campos obrigatórios faltando',
            });
        }

        // 🔹 Caso 1: Pagamento adiantado
        if (isAdvancePayment || (advanceSessions && advanceSessions.length > 0)) {
            return await handleAdvancePayment(req, res);
        }

        // 🔹 Caso 2: Pacote
        if (serviceType === 'package_session') {
            if (!packageId) {
                return res.status(400).json({
                    success: false,
                    message: 'ID do pacote é obrigatório para operações de pacote',
                });
            }

            // 📌 DIFERENCIAR:
            // - amount > 0  → pagamento de pacote (fluxo financeiro atual)
            // - amount <= 0 → apenas agendar sessão usando o pacote (reaproveita cancelada se houver)
            if (amount <= 0) {
                const mongoSession = await mongoose.startSession();
                mongoSession.startTransaction();

                try {
                    const pkg = await Package.findById(packageId).session(mongoSession);
                    if (!pkg) {
                        await mongoSession.abortTransaction();
                        return res.status(404).json({
                            success: false,
                            message: 'Pacote não encontrado',
                        });
                    }

                    const { date, time } = req.body;

                    if (!date || !time) {
                        await mongoSession.abortTransaction();
                        return res.status(400).json({
                            success: false,
                            message: 'Data e horário são obrigatórios para sessão de pacote',
                        });
                    }

                    // 🔹 Definições básicas herdando do pacote quando necessário
                    const sessionPatient = patientId || pkg.patient;
                    const sessionDoctor = doctorId || pkg.doctor;
                    const sessionSpecialty = specialty || pkg.specialty || pkg.sessionType;
                    const sessionTypeValue = sessionType || pkg.sessionType;

                    // 🔹 Valor da sessão (herda do pacote por padrão)
                    let validSessionValue = pkg.sessionValue || 0;
                    if (
                        req.body.sessionValue !== undefined &&
                        req.body.sessionValue !== null &&
                        req.body.sessionValue !== ''
                    ) {
                        const parsed = Number(req.body.sessionValue);
                        if (!Number.isNaN(parsed) && parsed >= 0) {
                            validSessionValue = parsed;
                        }
                    }

                    // 🔹 Verificar conflito de horário
                    const conflictSession = await Session.findOne({
                        date,
                        time,
                        doctor: sessionDoctor,
                        patient: sessionPatient,
                        specialty: sessionSpecialty,
                        status: { $ne: 'canceled' }
                    }).session(mongoSession);

                    if (conflictSession) {
                        await mongoSession.abortTransaction();
                        return res.status(409).json({
                            success: false,
                            message: 'Já existe uma sessão agendada para este horário para este paciente/profissional',
                        });
                    }

                    // 🔹 Buscar sessão cancelada com crédito reaproveitável
                    const canceledPaidSession = await Session.findOne({
                        package: packageId,
                        status: 'canceled',
                        $or: [
                            { originalPaymentStatus: { $exists: true } },
                            { originalIsPaid: true },
                            { originalPartialAmount: { $exists: true, $gt: 0 } }
                        ]
                    })
                        .sort({ canceledAt: -1 })
                        .session(mongoSession);

                    let isPaid;
                    let paymentStatus;
                    let visualFlag;
                    let paymentMethodToUse;
                    let partialAmount;

                    if (canceledPaidSession && canceledPaidSession.originalPartialAmount > 0) {
                        // ✅ Reaproveita o crédito da sessão cancelada
                        isPaid = true;
                        paymentStatus = 'paid';
                        visualFlag = 'ok';
                        paymentMethodToUse =
                            canceledPaidSession.originalPaymentMethod ||
                            pkg.paymentMethod ||
                            paymentMethod;
                        partialAmount = Number(canceledPaidSession.originalPartialAmount);

                        // Zera os campos "originais" da sessão cancelada
                        canceledPaidSession.originalPartialAmount = 0;
                        canceledPaidSession.originalPaymentStatus = null;
                        canceledPaidSession.originalIsPaid = false;
                        canceledPaidSession.originalPaymentMethod = null;

                        await canceledPaidSession.save({
                            session: mongoSession,
                            validateBeforeSave: false
                        });
                    } else {
                        // ✅ Nova sessão sem pagamento prévio
                        isPaid = false;
                        paymentStatus = 'pending';
                        visualFlag = 'pending';
                        paymentMethodToUse = pkg.paymentMethod || paymentMethod;
                        partialAmount = 0;
                    }

                    // 🔹 Criar nova sessão do pacote
                    const newSession = new Session({
                        date,
                        time,
                        patient: sessionPatient,
                        doctor: sessionDoctor,
                        package: packageId,
                        sessionValue: validSessionValue,
                        sessionType: sessionTypeValue,
                        specialty: sessionSpecialty,
                        status,
                        isPaid,
                        paymentStatus,
                        visualFlag,
                        paymentMethod: paymentMethodToUse,
                        partialAmount,
                        notes: notes || '',
                        _inFinancialTransaction: true
                    });

                    await newSession.save({
                        session: mongoSession,
                        validateBeforeSave: false
                    });

                    // 🔹 Criar appointment vinculado
                    const newAppointment = new Appointment({
                        patient: newSession.patient,
                        doctor: newSession.doctor,
                        date: newSession.date,
                        time: newSession.time,
                        duration: 40,
                        specialty: newSession.specialty,
                        session: newSession._id,
                        package: packageId,
                        serviceType: 'package_session',
                        operationalStatus: 'scheduled',
                        clinicalStatus: 'pending',
                        paymentStatus: newSession.paymentStatus,
                        visualFlag: newSession.visualFlag,
                        notes: notes || ''
                    });

                    await newAppointment.save({
                        session: mongoSession,
                        validateBeforeSave: false
                    });

                    // Vincular appointment na sessão
                    newSession.appointmentId = newAppointment._id;
                    await newSession.save({
                        session: mongoSession,
                        validateBeforeSave: false
                    });

                    // Atualizar pacote com nova sessão/appointment
                    const updatedPkg = await Package.findByIdAndUpdate(
                        packageId,
                        {
                            $push: {
                                sessions: newSession._id,
                                appointments: newAppointment._id
                            }
                        },
                        {
                            session: mongoSession,
                            new: true
                        }
                    );

                    await mongoSession.commitTransaction();

                    // (Opcional) se quiser sincronizar o pacote aqui também:
                    // try {
                    //     await syncEvent(updatedPkg, 'package');
                    // } catch (syncError) {
                    //     console.error('⚠️ Erro na sincronização:', syncError.message);
                    // }

                    const result = await Package.findById(packageId)
                        .populate('sessions appointments payments')
                        .populate('patient')
                        .populate({
                            path: 'doctor',
                            model: 'Doctor',
                            select: '_id fullName specialty'
                        })
                        .lean();

                    return res.status(201).json({
                        success: true,
                        message:
                            canceledPaidSession && partialAmount > 0
                                ? 'Sessão de pacote agendada reaproveitando pagamento anterior'
                                : 'Sessão de pacote agendada com sucesso',
                        session: {
                            _id: newSession._id,
                            date: newSession.date,
                            time: newSession.time,
                            isPaid: newSession.isPaid,
                            paymentStatus: newSession.paymentStatus,
                            visualFlag: newSession.visualFlag,
                            partialAmount: newSession.partialAmount,
                            sessionValue: newSession.sessionValue
                        },
                        package: result,
                        reusedPayment: !!(canceledPaidSession && partialAmount > 0)
                    });
                } catch (err) {
                    await mongoSession.abortTransaction();
                    console.error('❌ Erro ao agendar sessão de pacote:', err);
                    return res.status(500).json({
                        success: false,
                        message: err.message || 'Erro ao agendar sessão de pacote',
                        errorCode: 'PACKAGE_SESSION_SCHEDULE_ERROR'
                    });
                } finally {
                    await mongoSession.endSession();
                }
            }

            // 🔹 amount > 0 → fluxo financeiro de pagamento de pacote (mantido)
            const mongoSession = await mongoose.startSession();
            mongoSession.startTransaction();

            try {
                const pkgExists = await Package.exists({ _id: packageId });
                if (!pkgExists) {
                    await mongoSession.abortTransaction();
                    return res.status(404).json({
                        success: false,
                        message: 'Pacote não encontrado',
                    });
                }

                const parentPayment = await Payment.create(
                    [
                        {
                            patient: patientId,
                            doctor: doctorId,
                            serviceType,
                            amount,
                            paymentMethod,
                            notes,
                            status: 'pending',
                            package: packageId,
                            createdAt: currentDate,
                        },
                    ],
                    { session: mongoSession }
                );

                await distributePayments(packageId, amount, mongoSession, parentPayment[0]._id);

                await mongoSession.commitTransaction();

                const populatedPayment = await Payment.findById(parentPayment[0]._id)
                    .populate('patient doctor package')
                    .session(mongoSession);

                return res.status(201).json({
                    success: true,
                    message: 'Pagamento de pacote registrado (pendente)',
                    data: populatedPayment,
                });
            } catch (err) {
                await mongoSession.abortTransaction();
                throw err;
            } finally {
                mongoSession.endSession();
            }
        } else {
            // 🔹 PRIMEIRO cria a sessão (fluxo AVULSO — permanece exatamente como já estava)
            const newSession = await Session.create({
                patient: safeId(patientId),
                doctor: safeId(doctorId),
                serviceType,
                sessionType,
                notes,
                status: 'scheduled',
                isPaid: false,
                paymentStatus: 'pending',
                visualFlag: 'pending',
                date: req.body.date,
                time: req.body.time,
                sessionValue: amount,
                createdAt: currentDate,
                updatedAt: currentDate,
            });
            individualSessionId = newSession._id;

            const appointment = await Appointment.create({
                patient: safeId(patientId),
                doctor: safeId(doctorId),
                session: safeId(newSession._id),
                package: safeId(packageId),
                date: req.body.date,
                time: req.body.time,
                paymentStatus: 'pending',
                clinicalStatus: 'pending',
                operationalStatus: 'scheduled',
                visualFlag: 'pending',
                sessionValue: amount,
                serviceType,
                specialty,
                notes,
            });
            createdAppointmentId = appointment._id;

            // 🔹 SEGUNDO cria o PAGAMENTO INDIVIDUAL (PENDENTE)
            const paymentData = {
                patient: safeId(patientId),
                doctor: safeId(doctorId),
                session: safeId(individualSessionId),
                package: safeId(packageId),
                appointment: safeId(createdAppointmentId),
                serviceType,
                amount,
                paymentMethod,
                notes,
                status: 'pending',
                paymentDate: req.body.date,
                serviceDate: req.body.date,
                createdAt: currentDate,
                updatedAt: currentDate,
            };


            const payment = await Payment.create(paymentData);
            createdPaymentId = payment._id;




            // após criar o appointment:
            await Patient.findByIdAndUpdate(
                patientId,
                { $addToSet: { appointments: createdAppointmentId } },
                { new: false }
            );

            // 🔹 ATUALIZA O PAGAMENTO COM O ID DO AGENDAMENTO
            await Payment.findByIdAndUpdate(createdPaymentId, {
                appointment: safeId(createdAppointmentId)
            });

            // 🔹 VINCULA O PAYMENT AO APPOINTMENT (BIDIRECIONAL)
            await Appointment.findByIdAndUpdate(createdAppointmentId, {
                payment: createdPaymentId
            });

            console.log('✅ [POST] Sessão individual criada:', {
                appointmentId: createdAppointmentId,
                paymentId: createdPaymentId,
                paymentStatus: 'pending' // ✅ DEVE SER PENDING
            });

            await updateAppointmentFromSession(newSession);
            await updatePatientAppointments(patientId);
        }

        // 🔹 Caso 4: Pagamento vinculado a sessão existente
        if (serviceType === 'session') {
            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    message: 'ID da sessão é obrigatório para serviço do tipo "session"',
                });
            }

            const sessionDoc = await Session.findById(sessionId);
            if (!sessionDoc) {
                return res.status(404).json({
                    success: false,
                    message: 'Sessão não encontrada',
                });
            }

            await Session.findByIdAndUpdate(sessionId, {
                status: 'scheduled',
                isPaid: false,
                paymentStatus: 'pending',
                visualFlag: 'pending',
                updatedAt: currentDate,
            });

            // 🔹 Cria pagamento para sessão existente
            const paymentData = {
                patient: safeId(patientId),
                doctor: safeId(doctorId),
                serviceType,
                amount,
                paymentMethod,
                notes,
                status: 'pending',
                paymentDate: req.body.date,
                serviceDate: req.body.date,
                session: safeId(sessionId),
                createdAt: currentDate,
                updatedAt: currentDate,
            };

            const payment = await Payment.create(paymentData);
            createdPaymentId = payment._id;

            await updateAppointmentFromSession(sessionDoc);
        }

        // 🔹 POPULA E RETORNA OS DADOS
        let populatedPayment = null;

        if (createdPaymentId) {
            populatedPayment = await Payment.findById(createdPaymentId)
                .populate('patient doctor session package appointment');
        } else {
            // Fallback para outros casos
            const paymentData = {
                patient: safeId(patientId),
                doctor: safeId(doctorId),
                serviceType,
                amount,
                paymentMethod,
                notes,
                status: 'pending',
                paymentDate: req.body.date,
                serviceDate: req.body.date,
                createdAt: currentDate,
                updatedAt: currentDate,
            };

            if (serviceType === 'session') paymentData.session = safeId(sessionId);
            if (serviceType === 'individual_session') paymentData.session = safeId(individualSessionId);
            if (serviceType === 'package_session') paymentData.package = safeId(packageId);
            if (createdAppointmentId) paymentData.appointment = safeId(createdAppointmentId);


            const payment = await Payment.create(paymentData);
            populatedPayment = await Payment.findById(payment._id)
                .populate('patient doctor session package appointment');
        }

        console.log('✅ [POST] Agendamento criado com pagamento vinculado:', {
            appointmentId: createdAppointmentId,
            paymentId: populatedPayment._id,
            paymentStatus: populatedPayment.status,
            hasAppointmentField: !!populatedPayment.appointment
        });

        return res.status(201).json({
            success: true,
            message: 'Agendamento criado (pagamento pendente)',
            data: populatedPayment,
        });
    } catch (err) {
        console.error("ERR:", err?.message);
        console.error("MODEL:", err?.model?.modelName);     // às vezes existe
        console.error("PATH:", err?.path);                  // MUITO importante
        console.error("VALUE:", err?.value);
        console.error("KIND:", err?.kind);
        console.error(err?.errors);                         // se tiver ValidationError
        console.error(err?.stack);
        throw err;
    }
});

// Busca agendamentos com filtros
router.get('/', auth, async (req, res) => {
    try {
        const { patientId, doctorId, status, specialty, startDate, endDate } = req.query;
        const filter = {};
        let individualSessionId = null;
        let createdAppointmentId = null; // 👈 novo

        // 🔹 Filtros por paciente e médico
        if (patientId && patientId !== 'all' && mongoose.Types.ObjectId.isValid(patientId)) {
            filter.patient = new mongoose.Types.ObjectId(patientId);
        }
        if (doctorId && doctorId !== 'all' && mongoose.Types.ObjectId.isValid(doctorId)) {
            filter.doctor = new mongoose.Types.ObjectId(doctorId);
        }

        if (status && status !== 'all') filter.status = status;
        if (specialty && specialty !== 'all') filter.specialty = specialty;

        // 🔹 Filtro por período
        if (startDate && endDate) {
            filter.date = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }

        console.time('appointments.query');

        // 🔹 Buscar agendamentos com relacionamentos importantes
        const appointments = await Appointment.find(filter)
            .populate({ path: 'doctor', select: 'fullName specialty' })
            .populate({ path: 'patient', select: 'fullName dateOfBirth gender phone email address cpf rg' })
            .populate({ path: 'package', select: 'financialStatus totalPaid totalSessions balance sessionValue' })
            .populate({ path: 'session', select: 'isPaid paymentStatus partialAmount' })
            .populate({ path: 'payment', select: 'status amount paymentMethod' }) // ✅ ADICIONE ESTA LINHA
            .sort({ date: 1 })
            .lean();

        console.log('📦 Total appointments encontrados:', appointments.length);

        // 🔧 Função para resolver visualFlag com base no estado real
        const resolveVisualFlag = (appt) => {
            if (appt.visualFlag) return appt.visualFlag;

            // ✅ PRIORIZAR O PAYMENT VINCULADO
            if (appt.payment) {
                switch (appt.payment.status) {
                    case 'paid': return 'ok';
                    case 'partial': return 'partial';
                    case 'pending': return 'pending';
                }
            }

            // Sessão vinculada a pacote
            if (appt.package) {
                const pkg = appt.package;
                const sess = appt.session;
                const totalPaid = pkg.totalPaid || 0;
                const balance = pkg.balance ?? 0;

                if (sess?.isPaid || balance === 0) return 'ok';
                if (balance > 0 && totalPaid > 0 && balance < totalPaid) return 'partial';
                if (balance > 0 && !sess?.isPaid) return 'blocked';
            }

            // Sessão avulsa (fallback)
            switch (appt.paymentStatus) {
                case 'paid':
                case 'package_paid':
                case 'advanced':
                    return 'ok';
                case 'partial':
                    return 'partial';
                case 'pending':
                default:
                    return 'pending';
            }
        };
        // 🔹 Mapear para o formato do FullCalendar
        const calendarEvents = appointments
            .filter(appt => appt.patient || appt.package)
            .map(appt => {
                const [hours, minutes] = appt.time?.split(':').map(Number) || [0, 0];
                const start = new Date(appt.date);
                start.setHours(hours, minutes);
                const end = new Date(start.getTime() + (appt.duration || 40) * 60000);

                // ✅ Consolida o status financeiro
                const paymentStatus =
                    appt.payment?.status ||                    // 1º: Payment vinculado
                    appt.paymentStatus ||                       // 2º: Campo do Appointment
                    appt.session?.paymentStatus ||              // 3º: Session
                    (appt.package?.financialStatus === 'paid' ? 'paid' : 'pending'); // 4º: Package

                // 🧩 Resolve visualFlag de forma robusta
                const visualFlag = resolveVisualFlag({ ...appt, paymentStatus });

                return {
                    id: appt._id.toString(),
                    title: `${appt.reason || 'Consulta'} - ${appt.doctor?.fullName || 'Profissional'}`,
                    start: start.toISOString(),
                    end: end.toISOString(),
                    date: appt.date,
                    time: appt.time,
                    status: appt.status,
                    specialty: appt.specialty,
                    description: appt.reason,
                    operationalStatus: appt.operationalStatus,
                    clinicalStatus: appt.clinicalStatus,
                    paymentStatus,
                    visualFlag, // ✅ campo calculado e padronizado
                    package: appt.package || null,
                    session: appt.session || null,
                    patient: {
                        id: appt.patient._id.toString(),
                        fullName: appt.patient.fullName,
                        dateOfBirth: appt.patient.dateOfBirth,
                        gender: appt.patient.gender,
                        phone: appt.patient.phone,
                        email: appt.patient.email,
                        cpf: appt.patient.cpf,
                        rg: appt.patient.rg,
                        address: appt.patient.address,
                    },
                    doctor: {
                        id: appt.doctor?._id?.toString(),
                        fullName: appt.doctor?.fullName,
                        specialty: appt.doctor?.specialty,
                    },
                };
            });

        // ✅ Retorna tudo já consolidado
        res.json(calendarEvents);
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

router.get('/with-appointments', async (req, res) => {
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
            specialty
        }).populate('patient', 'fullName');

        res.json(appointments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/:id', validateId, auth, checkPackageAvailability,
    validateIndividualPayment, checkAppointmentConflicts, async (req, res) => {

        const mongoSession = await mongoose.startSession();

        try {
            await mongoSession.startTransaction();
            const currentDate = new Date();

            // 1. Buscar e validar agendamento com lock
            const appointment = await Appointment.findOneAndUpdate(
                { _id: req.params.id },
                { $set: {} },
                { new: true, session: mongoSession }
            ).populate('payment session package');

            if (!appointment) {
                await mongoSession.abortTransaction();
                return res.status(404).json({
                    error: 'Agendamento não encontrado',
                    message: 'Este agendamento não existe mais.'
                });
            }

            // 2. Verificar permissões
            if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
                await mongoSession.abortTransaction();
                return res.status(403).json({
                    error: 'Acesso não autorizado',
                    message: 'Você não pode editar este agendamento.'
                });
            }

            // 3. Aplicar atualizações manualmente
            const updateData = {
                ...req.body,
                doctor: req.body.doctorId || appointment.doctor,
                updatedAt: currentDate
            };

            // Salvar dados anteriores para comparação
            const previousData = {
                doctor: appointment.doctor.toString(),
                date: appointment.date,
                time: appointment.time,
                paymentAmount: appointment.paymentAmount,
                paymentMethod: appointment.paymentMethod,
                sessionType: appointment.sessionType,
                serviceType: appointment.serviceType,
                createdAt: currentDate,
                updatedAt: currentDate
            };

            // Atualizar appointment
            Object.assign(appointment, updateData);
            await appointment.validate();
            const updatedAppointment = await appointment.save({ session: mongoSession });

            // 4. Atualizar documentos relacionados
            const updatePromises = [];

            // Atualizar Sessão se existir
            if (appointment.session) {
                const sessionUpdate = Session.findByIdAndUpdate(
                    appointment.session,
                    {
                        $set: {
                            date: updateData.date || appointment.date,
                            time: updateData.time || appointment.time,
                            doctor: updateData.doctor || appointment.doctor,
                            sessionType: updateData.sessionType || appointment.sessionType,
                            sessionValue: updateData.paymentAmount || appointment.paymentAmount,
                            notes: updateData.notes || appointment.notes,
                            status: (updateData.sessionStatus || updateData.operationalStatus || appointment.operationalStatus),
                            updatedAt: currentDate
                        }
                    },
                    { session: mongoSession, new: true }
                );
                updatePromises.push(sessionUpdate);
            }

            // Atualizar Pagamento se existir
            if (appointment.payment) {
                const paymentUpdate = Payment.findByIdAndUpdate(
                    appointment.payment,
                    {
                        $set: {
                            doctor: updateData.doctor || appointment.doctor,
                            amount: (updateData.amount ?? updateData.paymentAmount ?? appointment.paymentAmount),
                            paymentMethod: updateData.paymentMethod || appointment.paymentMethod,
                            serviceDate: updateData.date || appointment.date,
                            serviceType: updateData.serviceType || appointment.serviceType,
                            updatedAt: currentDate
                        }
                    },
                    { session: mongoSession, new: true }
                );
                updatePromises.push(paymentUpdate);
            }

            // Atualizar Pacote se for sessão de pacote
            if (appointment.package && appointment.serviceType === 'package_session') {
                const packageUpdate = Package.findByIdAndUpdate(
                    appointment.package,
                    {
                        $set: {
                            doctor: updateData.doctor || appointment.doctor,
                            sessionValue: updateData.paymentAmount || appointment.paymentAmount,
                            updatedAt: currentDate
                        }
                    },
                    { session: mongoSession, new: true }
                );
                updatePromises.push(packageUpdate);
            }

            // Atualizar Paciente se o médico foi alterado
            if (req.body.doctorId && previousData.doctor !== req.body.doctorId) {
                const patientUpdate = Patient.findByIdAndUpdate(
                    appointment.patient,
                    {
                        $set: {
                            doctor: req.body.doctorId,
                            updatedAt: currentDate
                        }
                    },
                    { session: mongoSession, new: true }
                );
                updatePromises.push(patientUpdate);
            }

            // Executar todas as atualizações em paralelo
            await Promise.all(updatePromises);

            await mongoSession.commitTransaction();

            // 5. Sincronização pós-transação
            setTimeout(async () => {
                try {
                    await syncEvent(updatedAppointment, 'appointment');

                    if (appointment.serviceType === 'package_session') {
                        const action = determineActionType(req.body, previousData);
                        await handlePackageSessionUpdate(
                            updatedAppointment,
                            action,
                            req.user,
                            {
                                changes: req.body,
                                previousData
                            }
                        );
                    }
                } catch (err) {
                    console.error('Erro na sincronização pós-atualização:', err);
                }
            }, 100);

            res.json(updatedAppointment);

        } catch (error) {
            console.error('Erro ao atualizar agendamento:', error);

            if (mongoSession.inTransaction()) {
                await mongoSession.abortTransaction();
            }

            // ✅ NOVO: tratamento para write conflict
            if (error.message?.includes('Write conflict') || error.code === 112 || error.codeName === 'WriteConflict') {
                return res.status(409).json({
                    error: 'Conflito de edição',
                    message: 'Outro usuário está editando este agendamento. Recarregue a página e tente novamente.',
                    code: 'WRITE_CONFLICT'
                });
            }

            if (error.name === 'ValidationError') {
                const errors = Object.values(error.errors).reduce((acc, err) => {
                    acc[err.path] = err.message;
                    return acc;
                }, {});

                return res.status(400).json({
                    error: 'Dados inválidos', // ✅ mudou de 'message' pra 'error'
                    message: 'Verifique os campos destacados e tente novamente.', // ✅ adicionado
                    fields: errors // ✅ mudou de 'errors' pra 'fields'
                });
            }

            if (error.name === 'CastError') {
                return res.status(400).json({
                    error: 'ID inválido',
                    message: 'O formato do ID fornecido é inválido'
                });
            }

            if (error.message === 'Pacote inválido ou sem sessões disponíveis') {
                return res.status(400).json({
                    error: 'Pacote indisponível',
                    message: error.message
                });
            }

            res.status(500).json({
                error: 'Erro no servidor', // ✅ mudou de 'Erro interno'
                message: 'Não foi possível atualizar o agendamento. Tente novamente em instantes.', // ✅ adicionado
                details: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        } finally {
            await mongoSession.endSession();
        }
    });

function determineActionType(updateData) {
    if (updateData.status === 'canceled') return 'cancel';
    if (updateData.date || updateData.time) return 'reschedule';
    return 'update';
}

// Deleta um agendamento
router.delete('/:id', validateId, auth, async (req, res) => {
    try {
        const appt = await Appointment.findByIdAndDelete(req.params.id);

        if (!appt) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        // Recalcular agendamentos do paciente
        await updatePatientAppointments(appt.patient);

        res.json({ message: 'Agendamento deletado com sucesso' });
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

// Histórico de agendamentos por paciente
router.get('/history/:patientId', async (req, res) => {
    try {
        const { patientId } = req.params;
        const history = await Appointment.find({ patient: patientId }).sort({ date: -1 });
        res.json(history);
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

// Cancela um agendamento
router.patch('/:id/cancel', validateId, auth, async (req, res) => {
    try {
        const { reason, confirmedAbsence = false } = req.body;

        if (!reason) {
            return res.status(400).json({
                error: 'O motivo do cancelamento é obrigatório'
            });
        }

        const updatedAppointment = await runTransactionWithRetry(async (session) => {

            const appointment = await Appointment.findById(req.params.id)
                .populate('session')
                .session(session);

            if (!appointment) {
                const err = new Error('Agendamento não encontrado');
                err.status = 404;
                throw err;
            }

            console.log('🔓 Permitindo cancelamento (dados preservados)');

            // Atualizar Payment (se não for de pacote)
            if (appointment.payment) {
                const pay = await Payment.findById(appointment.payment)
                    .session(session);

                if (pay && pay.kind !== 'package_receipt' && pay.kind !== 'session_payment') {
                    await Payment.findByIdAndUpdate(
                        appointment.payment,
                        {
                            $set: {
                                status: 'canceled',
                                canceledAt: new Date(),
                                canceledReason: reason,
                                updatedAt: new Date()
                            }
                        },
                        { session }
                    );
                    console.log('✅ Payment cancelado');
                }
            }

            // Atualizar Session - VERSÃO CORRETA
            // Atualizar Session
            if (appointment.session) {
                // 🔧 Busca direto do BD, não usa populate
                const sessionDoc = await Session.findById(appointment.session)
                    .session(session);

                if (sessionDoc) {

                    const wasSessionPaid =
                        sessionDoc.paymentStatus === 'paid' ||
                        sessionDoc.isPaid === true ||
                        (sessionDoc.partialAmount && sessionDoc.partialAmount > 0);

                    sessionDoc._inFinancialTransaction = true;

                    // GUARDA dados financeiros
                    if (wasSessionPaid) {
                        sessionDoc.originalPartialAmount = sessionDoc.partialAmount;
                        sessionDoc.originalPaymentStatus = sessionDoc.paymentStatus;
                        sessionDoc.originalPaymentMethod = sessionDoc.paymentMethod;
                        sessionDoc.originalIsPaid = sessionDoc.isPaid;

                    } else {
                        console.log('⚠️ Sessão NÃO estava paga, não guarda original');
                    }

                    // Marca como cancelada
                    sessionDoc.status = 'canceled';
                    sessionDoc.paymentStatus = 'canceled';
                    sessionDoc.visualFlag = 'blocked';
                    sessionDoc.confirmedAbsence = confirmedAbsence;
                    sessionDoc.canceledAt = new Date();
                    sessionDoc.updatedAt = new Date();

                    if (!sessionDoc.history) sessionDoc.history = [];
                    sessionDoc.history.push({
                        action: 'cancelamento_via_agendamento',
                        changedBy: req.user._id,
                        timestamp: new Date(),
                        details: {
                            reason,
                            confirmedAbsence,
                            hadPayment: wasSessionPaid
                        }
                    });

                    await sessionDoc.save({
                        session,
                        validateBeforeSave: false
                    });

                    console.log('✅ Session cancelada e salva');
                }
            }

            // Atualizar Appointment
            const updated = await Appointment.findByIdAndUpdate(
                appointment._id,
                {
                    $set: {
                        operationalStatus: 'canceled',
                        clinicalStatus: confirmedAbsence ? 'missed' : 'pending',
                        paymentStatus: 'canceled',
                        visualFlag: 'blocked',
                        canceledReason: reason,
                        canceledAt: new Date(),
                        confirmedAbsence,
                        updatedAt: new Date()
                    },
                    $push: {
                        history: {
                            action: 'cancelamento',
                            newStatus: 'canceled',
                            changedBy: req.user._id,
                            timestamp: new Date(),
                            context: 'operacional',
                            details: { reason, confirmedAbsence }
                        }
                    }
                },
                { new: true, session }
            );

            console.log('✅ Appointment cancelado');

            return updated;
        });

        // Sincronizações
        setImmediate(async () => {
            try {
                await syncEvent(updatedAppointment, 'appointment');

                if (updatedAppointment.serviceType === 'package_session' && updatedAppointment.session) {
                    await handlePackageSessionUpdate(
                        updatedAppointment,
                        'cancel',
                        req.user,
                        { changes: { reason, confirmedAbsence } }
                    );
                } else if (updatedAppointment.session) {
                    const sess = await Session.findById(updatedAppointment.session);
                    if (sess) await syncEvent(sess, 'session');
                }
            } catch (error) {
                console.error('[sync-cancel] Erro:', error.message);
            }
        });

        return res.json({
            success: true,
            message: 'Agendamento cancelado. Dados preservados para reagendamento.',
            appointment: updatedAppointment
        });

    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({
                error: error.message,
                code: error.code
            });
        }

        console.error('[appointments/cancel] erro:', error);

        return res.status(500).json({
            error: 'Não foi possível cancelar o agendamento.',
            code: 'INTERNAL_SERVER_ERROR'
        });
    }
});

// routes/appointments.js (trecho)
router.patch('/:id/complete', auth, async (req, res) => {
    let session = null;
    try {
        const { id } = req.params;

        session = await mongoose.startSession();
        session.startTransaction();

        const appointment = await Appointment.findById(id)
            .populate('session package patient doctor payment')
            .populate({
                path: 'package',
                populate: { path: 'payments' }
            })
            .session(session);

        if (!appointment) {
            await session.abortTransaction();
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        /* if (appointment.operationalStatus === 'confirmed') {
            await session.abortTransaction();
            return res.status(400).json({ error: 'Este agendamento já está concluído' });
        } */

        // ✅ VERIFICAR DUPLICAÇÃO APENAS PARA PACOTE
        let shouldIncrementPackage = true;

        if (appointment.session) {
            const sessionDoc = await Session.findById(appointment.session._id).session(session);
            if (sessionDoc.status === 'completed' && appointment.package) {
                shouldIncrementPackage = false;
                console.log('⚠️ Sessão já estava completa - evitando duplicar pacote');
            }
        }

        // 1️⃣ ATUALIZAR SESSÃO (SEMPRE!)
        if (appointment.session) {
            const sessionResult = await Session.updateOne(
                { _id: appointment.session._id },
                {
                    status: 'completed',
                    isPaid: true,
                    paymentStatus: 'paid',
                    visualFlag: 'ok',
                    updatedAt: new Date()
                }
            ).session(session);

            console.log('✅ Session update:', {
                id: appointment.session._id,
                matched: sessionResult.matchedCount,
                modified: sessionResult.modifiedCount
            });
        }

        // 2️⃣ ATUALIZAR PAYMENT (BUSCA ÓRFÃO SE NÃO ESTIVER VINCULADO)
        let paymentId = appointment.payment?._id || appointment.payment;

        // ✅ FIX: Se não tem payment vinculado, busca pelo appointment ID
        if (!paymentId && !appointment.package) {
            const orphanPayment = await Payment.findOne({
                appointment: appointment._id
            }).session(session);

            if (orphanPayment) {
                paymentId = orphanPayment._id;
                console.log('🔗 Payment órfão encontrado:', paymentId);

                // Vincula de volta ao appointment
                await Appointment.updateOne(
                    { _id: appointment._id },
                    { $set: { payment: paymentId } }
                ).session(session);
            }
        }

        if (paymentId) {
            const paymentResult = await Payment.updateOne(
                { _id: paymentId },
                {
                    status: 'paid',
                    paymentDate: moment().tz("America/Sao_Paulo").format("YYYY-MM-DD"),
                    updatedAt: new Date()
                }
            ).session(session);

            console.log('✅ Payment update:', {
                id: paymentId,
                matched: paymentResult.matchedCount,
                modified: paymentResult.modifiedCount
            });
        } else if (!appointment.package) {
            console.log('⚠️ Nenhum payment encontrado para este appointment');
        }

        // 3️⃣ ATUALIZAR PACOTE (SE NECESSÁRIO)
        if (shouldIncrementPackage && appointment.package) {
            const packageDoc = await Package.findById(appointment.package._id).session(session);
            if (packageDoc.sessionsDone < packageDoc.totalSessions) {
                await Package.updateOne(
                    { _id: appointment.package._id },
                    {
                        $inc: { sessionsDone: 1 },
                        updatedAt: new Date()
                    }
                ).session(session);

                console.log('✅ Package incremented:', appointment.package._id);
            }
        }

        // 4️⃣ ATUALIZAR AGENDAMENTO
        const historyEntry = {
            action: 'confirmed',
            newStatus: 'confirmed',
            changedBy: req.user._id,
            timestamp: new Date(),
            context: 'operacional',
        };

        const updateData = {
            operationalStatus: 'confirmed',
            clinicalStatus: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
            visualFlag: 'ok',
            $push: { history: historyEntry }
        };

        if (appointment.package) {
            updateData.paymentStatus = 'package_paid';
        } else {
            updateData.paymentStatus = 'paid';
        }

        const appointmentResult = await Appointment.updateOne(
            { _id: id },
            updateData
        ).session(session);

        console.log('✅ Appointment update:', {
            id,
            matched: appointmentResult.matchedCount,
            modified: appointmentResult.modifiedCount
        });

        // ✅ BUSCAR DENTRO DA TRANSAÇÃO (antes do commit)
        const updatedAppointment = await Appointment.findById(id)
            .populate('session package patient doctor payment')
            .session(session);

        console.log('🔍 Status ANTES do commit:', {
            operationalStatus: updatedAppointment.operationalStatus,
            paymentStatus: updatedAppointment.paymentStatus
        });

        // 5️⃣ SINCRONIZAR DENTRO DA TRANSAÇÃO
        try {
            await syncEvent(updatedAppointment, 'appointment', session);
            console.log('✅ Sync completado dentro da transação');
        } catch (syncError) {
            console.error('⚠️ Erro no sync (não crítico):', syncError.message);
            // Não aborta a transação por erro de sync
        }

        // 6️⃣ COMMIT UMA ÚNICA VEZ
        await session.commitTransaction();
        console.log('✅ Transação commitada');

        // 7️⃣ BUSCAR NOVAMENTE APÓS COMMIT (para garantir)
        const finalAppointment = await Appointment.findById(id)
            .populate('session package patient doctor payment');

        console.log('🎯 Status APÓS commit:', {
            operationalStatus: finalAppointment.operationalStatus,
            paymentStatus: finalAppointment.paymentStatus,
            sessionPaid: finalAppointment.session?.isPaid
        });

        res.json(finalAppointment);

    } catch (error) {
        if (session) await session.abortTransaction();
        console.error('❌ Erro ao concluir:', error);
        res.status(500).json({
            error: 'Erro interno no servidor',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (session) session.endSession();
    }
});

// Busca todos os agendamentos de um paciente
router.get('/patient/:id', validateId, auth, async (req, res) => {

    const patient = req.params.id;
    try {
        const appointments = await Appointment.find({ patient }).populate([
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
            // Formatar sessões adiantadas
            if (appt.advancedSessions) {
                appt.advancedSessions = appt.advancedSessions.map(session => ({
                    ...session,
                    formattedDate: new Date(session.date).toLocaleDateString('pt-BR'),
                    formattedTime: session.time,
                }));
            }

            return {
                ...appt,
                paymentStatus:
                    appt.package
                        ? (appt.paymentStatus || 'package_paid')
                        : (appt.paymentStatus === 'paid' ? 'paid' : appt.paymentStatus || 'pending'),

                source: appt.package ? 'package' : 'individual'
            };
        });


        res.json(formattedAppointments);
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
            if (dateFrom) filter.date.$gte = new Date(dateFrom);
            if (dateTo) {
                const end = new Date(dateTo);
                end.setHours(23, 59, 59, 999);
                filter.date.$lte = end;
            }
        }

        // Filtro de especialidade
        if (specialty && specialty !== 'all') {
            filter.specialty = specialty;
        }

        // Agregação
        const counts = await Appointment.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$operationalStatus",
                    count: { $sum: 1 }
                }
            }
        ]);

        // Formatar resultado
        const result = {
            agendado: 0,
            confirmado: 0,
            cancelado: 0,
            pago: 0,
            faltou: 0
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
                price: 200.00 // Adicionado preço para cálculo de receita
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
            }
        };

        const stats = await Appointment.aggregate([
            { $match: { doctor } },
            {
                $facet: {
                    today: [
                        { $match: { date: { $gte: todayStart, $lte: todayEnd } } },
                        { $count: "count" }
                    ],
                    confirmed: [
                        { $match: { status: 'confirmed' } },
                        { $count: "count" }
                    ],
                    totalPatients: [
                        { $group: { _id: "$patientId" } },
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

router.patch('/:id/clinical-status', validateId, auth, async (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['pending', 'in_progress', 'completed', 'missed'];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Status clínico inválido' });
        }

        const appointment = await Appointment.findById(req.params.id);

        if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
            return res.status(403).json({ error: 'Acesso não autorizado' });
        }

        // Atualização segura que ignora validações problemáticas
        appointment.clinicalStatus = status;
        appointment.history.push({
            action: 'atualização_status_clínico',
            newStatus: status,
            changedBy: req.user._id,
            timestamp: new Date(),
            context: 'clínico'
        });

        if (status === 'concluído') {
            appointment.operationalStatus = 'pago';
            appointment.paymentStatus = appointment.package ? 'package_paid' : 'paid';
        }

        // Salva sem validar campos problemáticos
        const updatedAppointment = await appointment.save({ validateBeforeSave: false });

        res.json(updatedAppointment);

    } catch (error) {
        console.error('Erro ao atualizar status clínico:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// controllers/appointmentController.js
export const bookFromAmanda = async (req, res) => {
    try {
        const { leadId, doctorId, date, time, source = 'amanda' } = req.body;

        if (!leadId || !doctorId || !date || !time) {
            return res.status(400).json({ error: 'Campos obrigatórios: leadId, doctorId, date, time' });
        }

        // 1) garante que o slot ainda está livre
        const stillFree = await isSlotFree(doctorId, date, time);
        if (!stillFree) {
            return res.status(409).json({ error: 'Horário acabou de ser ocupado' });
        }

        // 2) cria Appointment
        const appointment = await Appointment.create({
            lead: leadId,
            doctor: doctorId,
            date,
            time,
            source,
            operationalStatus: 'scheduled',
            clinicalStatus: 'scheduled',
        });

        // 3) atualiza lead -> status/agendado
        await Leads.findByIdAndUpdate(leadId, {
            $set: { status: 'agendado' }
        });

        return res.json({ success: true, appointment });
    } catch (err) {
        console.error('❌ Erro bookFromAmanda:', err);
        return res.status(500).json({ error: err.message });
    }
};

export default router;