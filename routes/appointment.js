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
import Leads from '../models/Leads.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { runJourneyFollowups } from '../services/journeyFollowupEngine.js';
import { handlePackageSessionUpdate, syncEvent } from '../services/syncService.js';
import { updateAppointmentFromSession, updatePatientAppointments } from '../utils/appointmentUpdater.js';
import { runTransactionWithRetry } from '../utils/transactionRetry.js';
import billingOrchestrator from '../services/billing/BillingOrchestrator.js';
import { mapAppointmentToEvent } from '../utils/appointmentMapper.js';
import PatientBalance from '../models/PatientBalance.js';
import PatientsView from '../models/PatientsView.js';
import { getIo } from '../config/socket.js';
import guideService from '../services/billing/guideService.js';
import Convenio from '../models/Convenio.js';
import { normalizeE164BR } from '../utils/phone.js';
import { normalizeSessionType } from '../utils/sessionTypeResolver.js';
import { mapAppointmentDTO } from '../utils/appointmentDto.js';
import { PRE_APPOINTMENT_STATUSES, CANCELED_STATUSES } from '../constants/appointmentStatus.js';

// 🆕 HELPER: Cria lead automaticamente quando agendamento é feito direto
// 🔧 FIX: Agora verifica duplicados primeiro para evitar erro de índice único
async function ensureLeadForAppointment(patientId, appointmentData, source = 'agenda_direta') {
    try {
        // Buscar dados do paciente
        const patient = await Patient.findById(patientId).lean();
        if (!patient) {
            console.log('[ensureLeadForAppointment] Paciente não encontrado:', patientId);
            return null;
        }

        const phoneE164 = patient.phone ? normalizeE164BR(patient.phone) : null;

        // 🔧 FIX: Primeiro verifica se já existe lead com este telefone
        // Isso evita o erro E11000 duplicate key error
        if (phoneE164) {
            const existingLead = await Leads.findOne({ 'contact.phone': phoneE164 }).lean();
            if (existingLead) {
                console.log('[ensureLeadForAppointment] ✅ Lead existente encontrado:', existingLead._id);
                return existingLead._id;
            }
        }

        // 🔧 FIX: Se não encontrou, cria novo com try-catch para race condition
        try {
            const newLead = await Leads.create({
                name: patient.fullName || patient.name || 'Paciente',
                contact: {
                    phone: phoneE164,
                    email: patient.email || null
                },
                origin: source === 'whatsapp' ? 'WhatsApp' : 'Agenda Direta',
                status: 'agendado',
                stage: 'interessado_agendamento',
                circuit: 'Circuito Padrão',
                conversionScore: 50,
                responded: true,
                autoReplyEnabled: false,
                manualControl: { active: false, autoResumeAfter: null }, // 🔧 FIX: não volta sozinha
                patientInfo: {
                    fullName: patient.fullName,
                    phone: phoneE164,
                    email: patient.email
                },
                appointment: {
                    seekingFor: 'Adulto +18 anos',
                    modality: 'Presencial',
                    healthPlan: 'Mensalidade'
                },
                interactions: [{
                    date: new Date(),
                    channel: 'manual',
                    direction: 'inbound',
                    message: `Lead criado do agendamento direto - ${appointmentData.serviceType || 'consulta'} em ${appointmentData.date}`,
                    status: 'completed'
                }],
                scoreHistory: [{
                    score: 50,
                    reason: 'Agendamento direto na agenda externa',
                    date: new Date()
                }],
                lastInteractionAt: new Date(),
                lastContactAt: new Date(),
                autoCreatedFromAppointment: true,
                appointmentSource: source,
                linkedPatientId: patientId
            });

            console.log('[ensureLeadForAppointment] ✅ Novo lead criado:', newLead._id);
            return newLead._id;
        } catch (createError) {
            // 🔧 FIX: Se der erro de duplicata (race condition), busca o lead que foi criado
            if (createError.code === 11000 && phoneE164) {
                console.log('[ensureLeadForAppointment] ⚠️ Race condition detectada, buscando lead existente...');
                const raceLead = await Leads.findOne({ 'contact.phone': phoneE164 }).lean();
                if (raceLead) {
                    console.log('[ensureLeadForAppointment] ✅ Lead encontrado após race condition:', raceLead._id);
                    return raceLead._id;
                }
            }
            throw createError; // Re-lança se não for erro de duplicata
        }

    } catch (error) {
        console.error('[ensureLeadForAppointment] Erro:', error);
        return null;
    }
}

dotenv.config();
const router = express.Router();

// ======================================================================
// HELPER: Validação segura de datas
// ======================================================================
function isValidDateString(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return false;
    const date = new Date(dateStr);
    return !isNaN(date.getTime());
}

function safeNewDate(dateStr, fallback = null) {
    if (!dateStr) return fallback;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return fallback;
    return date;
}

// ======================================================================
// HELPER: Detector de convênio
// ======================================================================
function isInsuranceAppointment(body) {
    return body.billingType === 'insurance' ||
        body.billingType === 'convenio' ||
        body.insuranceGuideId ||
        body.insurance;
}

// Verifica horários disponíveis
router.get('/available-slots', flexibleAuth, getAvailableTimeSlots);

// Cria um novo agendamento
router.post('/', flexibleAuth, checkAppointmentConflicts, async (req, res) => {
    const {
        patientId,
        doctorId,
        packageId,
        sessionId,
        date,
        time,
        specialty,
        sessionType,
        serviceType,
        notes,
        paymentAmount,
        paymentMethod,
        clinicalStatus,
        operationalStatus,
        billingType,      // ✅ <– ADICIONE ESTA LINHA
        insuranceProvider, // ✅ (se o front envia)
        insuranceValue,
        authorizationCode,
        isAdvancePayment,
        advanceSessions,
        source,             // 📈 ROI
        preAgendamentoId,    // 📈 ROI
    } = req.body;
    const leadId = req.body?.leadId || null;

    console.log("DEBUG IDSsssssssssss", req.body);
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
        // 🔹 NOVO: Detector de convênio (roteamento para BillingOrchestrator)
        if (isInsuranceAppointment(req.body)) {
            const result = await billingOrchestrator.handleBilling({
                ...req.body,
                createdBy: req.user?._id
            });
            return res.status(201).json({ success: true, ...result });
        }

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

                    // 🔥 CALCULA SE É PRIMEIRO AGENDAMENTO DO PACIENTE
                    const existingAppointments = await Appointment.countDocuments({ 
                        patient: newSession.patient 
                    }).session(mongoSession);
                    const isFirstAppointment = existingAppointments === 0;

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
                        notes: notes || '',
                        // 🔥 NOVO: Primeiro agendamento do paciente?
                        isFirstAppointment: isFirstAppointment
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

                    // 🔔 Emitir evento socket para atualizar agenda externa
                    try {
                        const io = getIo();
                        io.emit('appointmentCreated', {
                            _id: newAppointment._id,
                            patient: newAppointment.patient,
                            doctor: newAppointment.doctor,
                            date: newAppointment.date,
                            time: newAppointment.time,
                            specialty: newAppointment.specialty,
                            source: 'crm_package_session'
                        });
                        console.log(`📡 Socket emitido: appointmentCreated ${newAppointment._id}`);
                    } catch (socketError) {
                        console.error('⚠️ Erro ao emitir socket:', socketError.message);
                    }

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

            // ⚠️ V1 LEGADO — Cria Payment no agendamento (V2 NÃO faz isso)
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

                // ⚠️ V1 LEGADO: Pre-cria Payment no agendamento. V2 deixa para o handler no complete.
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
            let insurance = req.body.insurance || null;

            const amount = parseFloat(req.body.paymentAmount) || 0;
            const sessionValue = (paymentMethod === 'convenio')
                ? (req.body.insurance?.grossAmount || 0)
                : amount;

            // 🔹  cria a sessão (fluxo AVULSO — permanece exatamente como já estava)
            const newSession = await Session.create({
                patient: safeId(patientId),
                doctor: safeId(doctorId),
                serviceType,
                sessionType: normalizeSessionType(sessionType || specialty),
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
                billingType,
                insurance,
            });
            individualSessionId = newSession._id;

            const totalDone = await Session.countDocuments({ patient: safeId(patientId) });

            let effectiveLeadId = leadId;

            if (leadId) {
                await Leads.findByIdAndUpdate(leadId, { patientJourneyStage: "ativo" });

                // se quiser mandar nome, busca do banco (senão pode remover patientName)
                const patientDoc = await Patient.findById(patientId).select('fullName name').lean().catch(() => null);

                runJourneyFollowups(leadId, {
                    sessionNumber: totalDone,
                    patientName: patientDoc?.fullName || patientDoc?.name || ""
                });
            } else {
                // 🆕 Criar lead automaticamente se não houver (agendamento direto)
                const leadSource = source || 'agenda_direta';
                effectiveLeadId = await ensureLeadForAppointment(patientId, {
                    serviceType,
                    date: req.body.date,
                    time: req.body.time,
                    specialty
                }, leadSource);

                if (effectiveLeadId) {
                    console.log('[POST Appointment] Lead criado/vinculado automaticamente:', effectiveLeadId);
                }
            }

            // 🆕 Buscar dados do lead para snapshot (se houver)
            let leadSnapshotData = null;
            if (effectiveLeadId) {
                const leadDoc = await Leads.findById(effectiveLeadId).lean();
                if (leadDoc) {
                    leadSnapshotData = {
                        source: leadDoc.source || leadDoc.origin || null,
                        campaign: leadDoc.campaign || null,
                        origin: leadDoc.origin || null,
                        conversionScore: leadDoc.conversionScore || null,
                        capturedAt: leadDoc.createdAt || null
                    };
                    console.log('[POST Appointment] Lead snapshot capturado:', leadSnapshotData);
                }
            }

            // 🔥 CALCULA SE É PRIMEIRO AGENDAMENTO DO PACIENTE
            // (antes de criar, conta quantos ele já tem)
            const existingAppointments = await Appointment.countDocuments({ 
                patient: safeId(patientId) 
            });
            const isFirstAppointment = existingAppointments === 0;
            console.log(`[POST Appointment] isFirstAppointment para paciente ${patientId}:`, isFirstAppointment);

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
                // 🆕 NOVO: Atribuição de lead para tracking de receita
                lead: effectiveLeadId || null,
                leadSnapshot: leadSnapshotData || undefined,
                // 🔥 NOVO: Primeiro agendamento do paciente?
                isFirstAppointment: isFirstAppointment,
                metadata: {
                    origin: {
                        source: source || 'outro',
                        preAgendamentoId: safeId(preAgendamentoId),
                        convertedBy: req.user?._id || null,
                        convertedAt: new Date()
                    }
                }
            });
            createdAppointmentId = appointment._id;

            // 🔔 Emitir evento socket para atualizar agenda externa
            try {
                const io = getIo();
                io.emit('appointmentCreated', {
                    _id: appointment._id,
                    patient: appointment.patient,
                    doctor: appointment.doctor,
                    date: appointment.date,
                    time: appointment.time,
                    specialty: appointment.specialty,
                    source: 'crm_package'
                });
                console.log(`📡 Socket emitido: appointmentCreated ${appointment._id}`);
            } catch (socketError) {
                console.error('⚠️ Erro ao emitir socket:', socketError.message);
            }

            await Session.findByIdAndUpdate(individualSessionId, {
                appointmentId: createdAppointmentId
            });

            // 🔹 SEGUNDO cria o PAGAMENTO DE PROVISIONING (PENDENTE)
            const paymentData = {
                patient:     safeId(patientId),
                session:     safeId(individualSessionId),
                package:     safeId(packageId) || undefined,
                appointment: safeId(createdAppointmentId),
                kind:        'session_payment',
                amount,
                paymentMethod,
                description: notes || serviceType,
                billingType,
                status: 'pending',
                source: 'appointment',
                paymentDate: req.body.date,
            };


            console.log('[POST APPOINTMENT] Criando pagamento com dados:', paymentData);
            const payment = await Payment.create(paymentData);
            createdPaymentId = payment._id;
            console.log('[POST APPOINTMENT] ✅ Pagamento criado:', createdPaymentId);

            // após criar o appointment:
            await Patient.findByIdAndUpdate(
                patientId,
                { $addToSet: { appointments: createdAppointmentId } },
                { new: false }
            );

            // 🔹 ATUALIZA O PAGAMENTO COM O ID DO AGENDAMENTO
            await Payment.findByIdAndUpdate(createdPaymentId, {
                appointmentId: safeId(createdAppointmentId)
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

            // ⚠️ V1 LEGADO: Pre-cria Payment no agendamento. V2 deixa para o handler no complete.
            const payment = await Payment.create(paymentData);
            createdPaymentId = payment._id;

            await updateAppointmentFromSession(sessionDoc);
        }

        // 🔹 POPULA E RETORNA OS DADOS
        let populatedPayment = null;

        if (createdPaymentId) {
            populatedPayment = await Payment.findById(createdPaymentId)
                .populate('patientId sessionId packageId appointmentId');
        } else {
            // Fallback para outros casos
            const paymentData = {
                patientId: safeId(patientId),
                amount,
                paymentMethod,
                description: notes || serviceType,
                status: 'pending',
                source: 'appointment',
                paymentDate: req.body.date,
            };

            if (serviceType === 'session') paymentData.sessionId = safeId(sessionId);
            if (serviceType === 'individual_session') paymentData.sessionId = safeId(individualSessionId);
            if (serviceType === 'package_session') paymentData.packageId = safeId(packageId);
            if (createdAppointmentId) paymentData.appointmentId = safeId(createdAppointmentId);

            const payment = await Payment.create(paymentData);
            populatedPayment = await Payment.findById(payment._id)
                .populate('patientId sessionId packageId appointmentId');
        }

        console.log('✅ [POST] Agendamento criado com pagamento vinculado:', {
            appointmentId: createdAppointmentId,
            paymentId: populatedPayment._id,
            paymentStatus: populatedPayment.status,
            hasAppointmentField: !!populatedPayment.appointmentId
        });

        if (leadId) {
            await Leads.findByIdAndUpdate(leadId, { patientJourneyStage: "onboarding" });

            runJourneyFollowups(leadId, {
                appointment: { date: req.body.date, time: req.body.time }
            });
        }

        // 🛡️ SEGURANÇA: Verificar se pagamento foi criado, se não, criar fallback
        if (!createdPaymentId && createdAppointmentId) {
            console.warn('[POST APPOINTMENT] ⚠️ Pagamento não foi criado! Criando fallback...');

            const fallbackPaymentData = {
                patient: safeId(patientId),
                doctor: safeId(doctorId),
                appointment: safeId(createdAppointmentId),
                serviceType: serviceType || 'individual_session',
                amount: parseFloat(req.body.paymentAmount) || 0,
                paymentMethod: paymentMethod || 'pix',
                notes: notes || '[PAGAMENTO FALLBACK - CRIADO AUTOMATICAMENTE]',
                status: 'pending',
                paymentDate: req.body.date,
                serviceDate: req.body.date,
                createdAt: currentDate,
                updatedAt: currentDate,
            };

            const fallbackPayment = await Payment.create(fallbackPaymentData);
            createdPaymentId = fallbackPayment._id;

            // Vincular ao appointment
            await Appointment.findByIdAndUpdate(createdAppointmentId, {
                payment: createdPaymentId
            });

            console.log('[POST APPOINTMENT] ✅ Fallback payment criado:', createdPaymentId);
        }

        // Buscar o appointment criado para retornar completo
        const createdAppointment = await Appointment.findById(createdAppointmentId)
            .populate('patient doctor session payment');

        console.log('[POST APPOINTMENT] ✅ Retornando appointment:', createdAppointmentId, 'com payment:', createdPaymentId);

        return res.status(201).json({
            success: true,
            message: 'Agendamento criado (pagamento pendente)',
            data: {
                ...populatedPayment.toObject(),
                billingType: billingType || 'particular',
                appointment: createdAppointment
            }
        });

    } catch (err) {
        // 🔹 NOVO: Mapeamento de erros do convênio
        const errorMap = {
            'PACIENTE_SEM_GUIA_ATIVA': { status: 400, code: 'NO_INSURANCE_GUIDE' },
            'GUIA_ESGOTADA': { status: 400, code: 'GUIDE_DEPLETED' },
            'GUIA_VENCIDA': { status: 400, code: 'GUIDE_EXPIRED' },
            'CONFLITO_HORARIO': { status: 409, code: 'SCHEDULE_CONFLICT' }
        };

        const mapped = errorMap[err.code];
        if (mapped) {
            return res.status(mapped.status).json({
                success: false,
                message: err.message,
                code: mapped.code
            });
        }

        console.error("ERR:", err?.message);
        console.error("MODEL:", err?.model?.modelName);
        console.error("PATH:", err?.path);
        console.error("VALUE:", err?.value);
        console.error("KIND:", err?.kind);
        console.error(err?.errors);
        console.error(err?.stack);

        // se for validação, devolve 400 com detalhes
        if (err?.name === "ValidationError") {
            return res.status(400).json({
                success: false,
                message: "ValidationError",
                errors: Object.fromEntries(
                    Object.entries(err.errors || {}).map(([k, v]) => [k, v.message])
                ),
            });
        }

        return res.status(500).json({ success: false, message: err.message });
    }

});

// Busca agendamentos com filtros
router.get('/', flexibleAuth, async (req, res) => {
    try {
        const { patientId, doctorId, status, specialty, startDate, endDate, excludePreAgendamentos } = req.query;

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
        } else {
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

router.put('/:id', validateId, auth, checkPackageAvailability,
    checkAppointmentConflicts, async (req, res) => {

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
            console.log(`[PUT] Dados recebidos:`, {
                paymentAmount: req.body.paymentAmount,
                sessionValue: req.body.sessionValue,
                amount: req.body.amount,
                body: req.body
            });

            // Strip fields that must never overwrite the document (_id imutável no Mongoose)
            // e campos de UI que o backend não conhece
            const {
                _id: _bodyId,
                id: _bodyStringId,
                __v: _bodyV,
                isNewPatient: _isNewPatient,
                patientInfo: _patientInfo,
                ...safeBody
            } = req.body;

            // package pode chegar como objeto populado — extrai apenas o ObjectId
            if (safeBody.package && typeof safeBody.package === 'object') {
                safeBody.package = safeBody.package._id || safeBody.package.id || null;
            }

            const updateData = {
                ...safeBody,
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
                            sessionType: normalizeSessionType(updateData.sessionType || appointment.sessionType),
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

            // Atualizar ou Criar Pagamento (somente se NÃO for pacote)
            if (!appointment.package && appointment.payment) {
                // Pagamento existe - atualiza
                const paymentUpdate = Payment.findByIdAndUpdate(
                    appointment.payment,
                    {
                        $set: {
                            doctor: updateData.doctor || appointment.doctor,
                            amount: (updateData.amount ?? updateData.paymentAmount ?? appointment.paymentAmount),
                            paymentMethod: updateData.paymentMethod || appointment.paymentMethod,
                            serviceDate: updateData.date || appointment.date,
                            serviceType: updateData.serviceType || appointment.serviceType,
                            billingType: updateData.billingType || appointment.billingType || 'particular',
                            insuranceProvider: updateData.insuranceProvider || appointment.insuranceProvider,
                            insuranceValue: updateData.insuranceValue || appointment.insuranceValue,
                            authorizationCode: updateData.authorizationCode || appointment.authorizationCode,
                            updatedAt: currentDate
                        }
                    },
                    { session: mongoSession, new: true }
                );
                updatePromises.push(paymentUpdate);
            } else if (!appointment.package && !appointment.payment && (updateData.paymentAmount > 0 || updateData.billingType === 'convenio')) {
                // 🛡️ HARDENING: Só cria Payment no PUT se NÃO existir anterior E houver valor real ou convenio
                console.log(`[PUT V1 /appointments/${id}] Criando novo payment via edição: amount=${updateData.paymentAmount}, billingType=${updateData.billingType}`);
                const newPayment = new Payment({
                    patient: appointment.patient,
                    doctor: updateData.doctor || appointment.doctor,
                    appointment: appointment._id,
                    amount: updateData.paymentAmount || 0,
                    paymentMethod: updateData.paymentMethod || 'dinheiro',
                    serviceDate: updateData.date || appointment.date,
                    serviceType: updateData.serviceType || appointment.serviceType,
                    billingType: updateData.billingType || 'particular',
                    insuranceProvider: updateData.billingType === 'convenio' ? updateData.insuranceProvider : null,
                    insuranceValue: updateData.billingType === 'convenio' ? updateData.insuranceValue : 0,
                    authorizationCode: updateData.billingType === 'convenio' ? updateData.authorizationCode : null,
                    status: updateData.billingType === 'convenio' ? 'pending' : 'paid',
                    paymentDate: new Date(),
                    paidAt: updateData.billingType === 'convenio' ? undefined : new Date(),
                    kind: 'session_payment',
                    notes: `Pagamento registrado via edição de agendamento - ${new Date().toLocaleString('pt-BR')}`
                });

                await newPayment.save({ session: mongoSession });

                // Vincula o pagamento ao agendamento
                appointment.payment = newPayment._id;
                appointment.paymentStatus = updateData.billingType === 'convenio' ? 'pending' : 'paid';
                await appointment.save({ session: mongoSession });

                console.log(`✅ Novo pagamento criado: ${newPayment._id} para agendamento ${appointment._id}`);
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

            // 🔔 Emitir evento socket para atualizar agenda externa
            try {
                const io = getIo();
                io.emit('appointmentUpdated', {
                    _id: updatedAppointment._id,
                    patient: updatedAppointment.patient,
                    doctor: updatedAppointment.doctor,
                    date: updatedAppointment.date,
                    time: updatedAppointment.time,
                    specialty: updatedAppointment.specialty,
                    operationalStatus: updatedAppointment.operationalStatus,
                    source: 'crm_update'
                });
                console.log(`📡 Socket emitido: appointmentUpdated ${updatedAppointment._id}`);
            } catch (socketError) {
                console.error('⚠️ Erro ao emitir socket:', socketError.message);
            }

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

            res.json({ success: true, data: mapAppointmentDTO(updatedAppointment) });

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
router.delete('/:id', validateId, flexibleAuth, async (req, res) => {
    try {
        const appt = await Appointment.findById(req.params.id);

        if (!appt) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        // 🔒 BLOQUEIO V2: Não permitir deletar agendamentos de pacotes (evita corrupção de caixa/pacote)
        if (appt.package) {
            return res.status(400).json({
                error: 'Não é possível excluir agendamentos vinculados a pacotes. Use CANCELAR para manter integridade financeira.',
                code: 'PACKAGE_APPOINTMENT_DELETE_BLOCKED'
            });
        }

        await Appointment.findByIdAndDelete(req.params.id);

        // 🔔 Emitir evento socket para atualizar agenda externa
        try {
            const io = getIo();
            io.emit('appointmentDeleted', {
                _id: appt._id,
                patient: appt.patient,
                doctor: appt.doctor,
                date: appt.date,
                time: appt.time,
                source: 'crm_delete'
            });
            console.log(`📡 Socket emitido: appointmentDeleted ${appt._id}`);
        } catch (socketError) {
            console.error('⚠️ Erro ao emitir socket:', socketError.message);
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

// Cancela um agendamento
router.patch('/:id/cancel', validateId, flexibleAuth, async (req, res) => {
    try {
        const { reason, confirmedAbsence = false } = req.body;
        console.log('🔍 [Cancel] ID recebido:', req.params.id);

        if (!reason) {
            return res.status(400).json({
                error: 'O motivo do cancelamento é obrigatório'
            });
        }

        const updatedAppointment = await runTransactionWithRetry(async (session) => {

            const appointment = await Appointment.findById(req.params.id)
                .populate('session')
                .session(session);

            console.log('🔍 [Cancel] Appointment encontrado:', appointment ? 'SIM' : 'NÃO');

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

            // pre_agendados agora são Appointments — sem sync externo necessário

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

// ─────────────────────────────────────────────────────────────────────────
// V1 COMPLETE REMOVIDO — use PATCH /api/v2/appointments/:id/complete
// ─────────────────────────────────────────────────────────────────────────

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

        res.json({ success: true, data: mapAppointmentDTO(updatedAppointment) });

    } catch (error) {
        console.error('Erro ao atualizar status clínico:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// NOVO: Confirmação direta de agendamento (Pendente -> Confirmado)
router.patch('/:id/confirm', validateId, flexibleAuth, async (req, res) => {
    const session = await mongoose.startSession();
    try {
        await session.startTransaction();
        const appointment = await Appointment.findById(req.params.id).session(session);

        if (!appointment) {
            await session.abortTransaction();
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
            await session.abortTransaction();
            return res.status(403).json({ error: 'Acesso não autorizado' });
        }

        // Atualiza Status Operacional
        const oldStatus = appointment.operationalStatus;
        appointment.operationalStatus = 'confirmed';
        // appointment.paymentStatus = 'paid'; // REMOVIDO: pagamento é feito no CRM
        appointment.clinicalStatus = 'pending';

        if (!appointment.history) appointment.history = [];
        appointment.history.push({
            action: 'confirmação_presença_manual',
            changedBy: req.user._id,
            timestamp: new Date(),
            context: 'operacional',
            details: { from: oldStatus, to: 'confirmed' }
        });

        const updatedAppointment = await appointment.save({ session, validateBeforeSave: false });

        // Atualiza Sessão vinculada (apenas status, sem pagamento)
        if (appointment.session) {
            await Session.findByIdAndUpdate(appointment.session, {
                $set: {
                    status: 'completed',
                    updatedAt: new Date()
                }
            }, { session });
        }

        await session.commitTransaction();

        // Sincronização pós-commit (opcional, mas recomendado)
        setTimeout(() => syncEvent(updatedAppointment, 'appointment').catch(console.error), 100);

        res.json({ success: true, data: mapAppointmentDTO(updatedAppointment) });

    } catch (error) {
        if (session) await session.abortTransaction();
        console.error('Erro ao confirmar agendamento:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    } finally {
        if (session) session.endSession();
    }
});

// controllers/appointmentController.js
export const bookFromAmanda = async (req, res) => {
    try {
        const { doctorId, date, time, source = 'amanda' } = req.body;
        const leadId = req.body?.leadId || null;

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

        // 🔔 Emitir evento socket para atualizar agenda externa
        try {
            const io = getIo();
            io.emit('appointmentCreated', {
                _id: appointment._id,
                lead: appointment.lead,
                doctor: appointment.doctor,
                date: appointment.date,
                time: appointment.time,
                source: 'crm_lead'
            });
            console.log(`📡 Socket emitido: appointmentCreated ${appointment._id}`);
        } catch (socketError) {
            console.error('⚠️ Erro ao emitir socket:', socketError.message);
        }

        // 3) atualiza lead -> status/agendado
        await Leads.findByIdAndUpdate(leadId, {
            $set: { status: 'agendado' }
        });

        return res.json({ success: true, data: mapAppointmentDTO(appointment) });
    } catch (err) {
        console.error('❌ Erro bookFromAmanda:', err);
        return res.status(500).json({ error: err.message });
    }
};

router.patch('/:id/post-appointment', validateId, flexibleAuth, async (req, res) => {
    try {
        const { step } = req.body; // 'msg1' | 'msg2'
        const field = step === 'msg2' ? 'reviewRequestSentAt' : 'postAppointmentSentAt';
        const appointment = await Appointment.findByIdAndUpdate(
            req.params.id,
            { [field]: new Date() },
            { new: true, select: `${field}` }
        );
        if (!appointment) return res.status(404).json({ error: 'Agendamento não encontrado' });
        res.json({ ok: true, [field]: appointment[field] });
    } catch (err) {
        console.error('[PATCH /appointments/:id/post-appointment]', err);
        res.status(500).json({ error: 'Erro ao registrar envio' });
    }
});

export default router;