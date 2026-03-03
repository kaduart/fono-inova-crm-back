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
import PreAgendamento from '../models/PreAgendamento.js'; // 👈 Importado para unificação
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { runJourneyFollowups } from '../services/journeyFollowupEngine.js';
import { handlePackageSessionUpdate, syncEvent } from '../services/syncService.js';
import { updateAppointmentFromSession, updatePatientAppointments } from '../utils/appointmentUpdater.js';
import { runTransactionWithRetry } from '../utils/transactionRetry.js';
import billingOrchestrator from '../services/billing/BillingOrchestrator.js';
import { mapAppointmentToEvent, mapPreAgendamentoToEvent } from '../utils/appointmentMapper.js';
import PatientBalance from '../models/PatientBalance.js';
import { getIo } from '../config/socket.js';
import guideService from '../services/billing/guideService.js';
import Convenio from '../models/Convenio.js';
import { normalizeE164BR } from '../utils/phone.js';

// 🆕 HELPER: Cria lead automaticamente quando agendamento é feito direto
// SEMPRE cria novo lead (mesmo telefone pode ser pai com múltiplos filhos)
async function ensureLeadForAppointment(patientId, appointmentData, source = 'agenda_direta') {
    try {
        // Buscar dados do paciente
        const patient = await Patient.findById(patientId).lean();
        if (!patient) {
            console.log('[ensureLeadForAppointment] Paciente não encontrado:', patientId);
            return null;
        }

        const phoneE164 = patient.phone ? normalizeE164BR(patient.phone) : null;

        // 🆕 SEMPRE cria novo lead - não verifica duplicados
        // (mesmo telefone pode ser pai agendando para filhos diferentes)
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
            linkedPatientId: patientId // 🆕 Link para o paciente
        });

        console.log('[ensureLeadForAppointment] ✅ Novo lead criado:', newLead._id);
        return newLead._id;

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
                billingType,
                insurance,
                status: 'pending',
                paymentDate: req.body.date,
                serviceDate: req.body.date,
                createdAt: currentDate,
                updatedAt: currentDate,
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

        console.log(`[GET /appointments] Query:`, { patientId, doctorId, status, specialty, startDate, endDate, excludePreAgendamentos });

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

        if (status && status !== 'all') {
            if (status === 'Confirmado') {
                filter.operationalStatus = { $in: ['confirmed', 'paid'] };
            } else if (status === 'Pendente') {
                filter.operationalStatus = { $in: ['scheduled', 'pending'] };
            } else if (status === 'Cancelado') {
                filter.operationalStatus = { $in: ['canceled', 'missed'] };
            }
        }
        if (specialty && specialty !== 'all') filter.specialty = specialty;

        // 🔹 Filtro por período
        if (startDate && endDate) {
            filter.date = {
                $gte: startDate,  // string "2026-02-02"
                $lte: endDate     // string "2026-03-14"
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
            .select('date time duration specialty notes responsible operationalStatus clinicalStatus paymentStatus visualFlag patient doctor package session payment metadata billingType insuranceProvider insuranceValue authorizationCode serviceType sessionType sessionValue reason')
            .populate({ path: 'doctor', select: 'fullName specialty email phoneNumber specialties' })
            .populate({ path: 'patient', select: 'fullName dateOfBirth gender phone email cpf rg address' })
            .populate({ path: 'package', select: 'financialStatus totalPaid totalSessions balance sessionValue' })
            .populate({ path: 'session', select: 'isPaid paymentStatus partialAmount' })
            .populate({ path: 'payment', select: 'status amount paymentMethod' })
            .sort({ date: -1, time: 1 }) // Mais recentes primeiro, depois por hora
            .lean();

        // Verificar se o appointment específico está aqui
        const targetAppt = appointments.find(a => {
            const id = a._id?.toString?.() || a._id;
            return id === '69964dc81e0e9b385928bb06';
        });

        // 🔹 2. BUSCAR PRÉ-AGENDAMENTOS (INTERESSES) NÃO IMPORTADOS
        // Só mostra pré-agendamentos que ainda não viraram appointment
        const preFilter = {
            status: { $nin: ['importado', 'descartado', 'desistiu'] } // ❌ Não importados
        };

        // Aplicar filtro de data
        if (startDate && endDate) {
            preFilter.preferredDate = { $gte: startDate, $lte: endDate };
        }

        const preAgendamentos = await PreAgendamento.find(preFilter).lean();
        console.log(`[GET /appointments] PreAgendamentos não importados: ${preAgendamentos.length}`);

        // 🔹 Buscar saldos dos pacientes para mostrar no calendário
        const patientIds = appointments
            .map(appt => appt.patient?._id?.toString())
            .filter((id, index, arr) => id && arr.indexOf(id) === index); // únicos

        const patientBalances = await PatientBalance.find({
            patient: { $in: patientIds },
            currentBalance: { $gt: 0 } // só quem deve
        }).select('patient currentBalance').lean();

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

        // 🔹 3. JUNTAR APPOINTMENTS + PRÉ-AGENDAMENTOS (não importados)
        // Se excludePreAgendamentos=true, não inclui pré-agendamentos no resultado
        const shouldExcludePreAgendamentos = excludePreAgendamentos === 'true' || excludePreAgendamentos === true;
        
        let finalResults;
        if (shouldExcludePreAgendamentos) {
            // Só appointments reais (para o calendário)
            finalResults = calendarEvents.sort((a, b) => {
                return (a.date + a.time).localeCompare(b.date + b.time);
            });
            console.log(`[GET /appointments] Retornando ${finalResults.length} appointments (pré-agendamentos excluídos)`);
        } else {
            // Appointments + pré-agendamentos (para o painel de pré-agendamentos)
            const preEvents = preAgendamentos.map(pre => mapPreAgendamentoToEvent(pre));
            finalResults = [...calendarEvents, ...preEvents].sort((a, b) => {
                return (a.date + a.time).localeCompare(b.date + b.time);
            });
            console.log(`[GET /appointments] Retornando ${finalResults.length} eventos (${calendarEvents.length} appointments + ${preEvents.length} pré-agendamentos)`);
        }

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
            .populate('session', 'status paymentStatus');

        if (!appointment) {
            return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });
        }

        res.json({ success: true, data: appointment });
    } catch (error) {
        console.error('[APPOINTMENT] Erro ao buscar:', error);
        res.status(500).json({ success: false, error: error.message });
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
            } else if (!appointment.package && (updateData.billingType || updateData.paymentAmount > 0)) {
                // 🆕 Não tem pagamento ainda, mas recebeu dados de pagamento - cria novo!
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
                    kind: 'manual',
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
router.delete('/:id', validateId, flexibleAuth, async (req, res) => {
    try {
        const appt = await Appointment.findByIdAndDelete(req.params.id);

        if (!appt) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

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

// routes/appointments.js (trecho) - OTIMIZADO
router.patch('/:id/complete', auth, async (req, res) => {
    let session = null;
    const startTime = Date.now();

    try {
        const { id } = req.params;
        const { addToBalance = false, balanceAmount = 0, balanceDescription = '' } = req.body;

        console.log(`[complete] Iniciando - addToBalance: ${addToBalance}, patientId: ${req.body.patientId || 'n/a'}`);

        // ============================================================
        // FASE 1: BUSCAR DADOS FORA DA TRANSAÇÃO (sem lock)
        // ============================================================
        console.log(`[complete] Fase 1: Buscando dados (${Date.now() - startTime}ms)`);

        const appointment = await Appointment.findById(id)
            .populate('session patient doctor payment')
            .populate({
                path: 'package',
                populate: { path: 'payments' }
            })
            .lean(); // <-- SEM .session()! Sem transação!
        if (!appointment) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        console.log(`[complete] Dados carregados (${Date.now() - startTime}ms)`);

        // Guardar IDs para usar na transação
        const sessionId = appointment.session?._id || appointment.session;
        const paymentId = appointment.payment?._id || appointment.payment;
        const packageId = appointment.package?._id || appointment.package;
        const patientId = appointment.patient?._id || appointment.patient;

        // ✅ Só incrementa pacote se ainda não estiver concluído
        const shouldIncrementPackage =
            appointment.package &&
            appointment.clinicalStatus !== 'completed';
        console.log(`[complete] shouldIncrementPackage: ${shouldIncrementPackage}, hasPackage: ${!!appointment.package}, clinicalStatus: ${appointment.clinicalStatus}`);

        // ============================================================
        // FASE 2: TRANSAÇÃO MÍNIMA (apenas updates)
        // ============================================================
        console.log(`[complete] Fase 2: Iniciando transação (${Date.now() - startTime}ms)`);

        session = await mongoose.startSession();
        session.startTransaction();

        /* if (appointment.operationalStatus === 'confirmed') {
            await session.abortTransaction();
            return res.status(400).json({ error: 'Este agendamento já está concluído' });
        } */

        // 1️⃣ ATUALIZAR SESSÃO (SEMPRE!)
        console.log(`[complete] Etapa 1: Atualizando sessão (${Date.now() - startTime}ms)`);
        // 💰 Se for adicionar ao saldo devedor, não marca como pago
        const sessionUpdateData = addToBalance ? {
            status: 'completed',
            isPaid: false,  // ❌ Não está pago
            paymentStatus: 'pending',  // ⏳ Pendente
            addedToBalance: true,  // 📝 Flag indicando que foi pro saldo
            balanceAmount: balanceAmount || appointment.sessionValue || 0,
            visualFlag: 'pending',  // 🚩 Visual de pendente
            updatedAt: new Date()
        } : {
            status: 'completed',
            isPaid: true,
            paymentStatus: 'paid',
            visualFlag: 'ok',
            updatedAt: new Date()
        };

        // 2️⃣ ATUALIZAR PAYMENT (se não for saldo devedor)
        let finalPaymentId = paymentId; // 📜 Declarar fora do bloco para uso posterior

        if (!addToBalance) {
            // ✅ FIX: Se não tem payment vinculado, busca pelo appointment ID
            if (!finalPaymentId && !packageId) {
                const orphanPayment = await Payment.findOne(
                    { appointment: appointment._id },
                    { _id: 1 },
                    { session }
                );

                if (orphanPayment) {
                    finalPaymentId = orphanPayment._id;
                    await Appointment.updateOne(
                        { _id: appointment._id },
                        { $set: { payment: finalPaymentId } },
                        { session }
                    );
                }
            }

            // 🆕 CRIAR PAYMENT SE NÃO EXISTIR (e não for pacote NEM convênio)
            const isConvenio = appointment.billingType === 'convenio' ||
                appointment.insuranceProvider ||
                appointment.insuranceGuide;

            if (!finalPaymentId && !packageId && !isConvenio) {
                console.log(`[complete] ⚠️ Payment não encontrado, criando novo...`);

                const newPayment = await Payment.create([{
                    patient: appointment.patient?._id || appointment.patient,
                    doctor: appointment.doctor?._id || appointment.doctor,
                    appointment: appointment._id,
                    session: appointment.session?._id || appointment.session,
                    serviceType: appointment.serviceType || 'individual_session',
                    amount: appointment.sessionValue || 0,
                    paymentMethod: appointment.paymentMethod || 'pix',
                    status: 'paid',
                    paymentDate: moment().tz("America/Sao_Paulo").format("YYYY-MM-DD"),
                    serviceDate: appointment.date,
                    notes: '[CRIADO AUTOMATICAMENTE NO COMPLETE]',
                    createdAt: new Date(),
                    updatedAt: new Date()
                }], { session });

                finalPaymentId = newPayment[0]._id;

                // Vincular ao appointment
                await Appointment.updateOne(
                    { _id: appointment._id },
                    { $set: { payment: finalPaymentId } },
                    { session }
                );

                console.log(`[complete] ✅ Payment criado: ${finalPaymentId}`);
            } else if (isConvenio) {
                console.log(`[complete] ℹ️ Convênio detectado - não criando payment`);
            }

            if (finalPaymentId) {
                const existingPayment = await Payment.findOne(
                    { _id: finalPaymentId },
                    { status: 1 },
                    { session }
                );

                const paymentUpdateData = existingPayment?.status === 'paid'
                    ? { status: 'paid', updatedAt: new Date() }
                    : {
                        status: 'paid',
                        paymentDate: moment().tz("America/Sao_Paulo").format("YYYY-MM-DD"),
                        updatedAt: new Date()
                    };

                await Payment.updateOne(
                    { _id: finalPaymentId },
                    { $set: paymentUpdateData },
                    { session }
                );
            }
        } else {
            console.log(`[complete] Pulando atualização de payment (saldo devedor)`);
        }

        // 3️⃣ ATUALIZAR PACOTE (SE NECESSÁRIO)
        console.log(`[complete] Etapa 3: Verificando pacote (${Date.now() - startTime}ms)`);
        let packageDoc = null;
        if (packageId) {
            // Buscar packageDoc sempre que tiver pacote (necessário para convênio)
            packageDoc = await Package.findOne(
                { _id: packageId },
                { type: 1, sessionsDone: 1, totalSessions: 1, insuranceProvider: 1, insuranceGuide: 1 },
                { session }
            );

            // Só incrementa sessionsDone se ainda não estiver concluído
            if (shouldIncrementPackage) {
                await Package.updateOne(
                    { _id: packageId, $expr: { $lt: ["$sessionsDone", "$totalSessions"] } },
                    { $inc: { sessionsDone: 1 }, $set: { updatedAt: new Date() } },
                    { session }
                );
            }
        }

        console.log(`[complete] Etapa 4: Atualizando agendamento (${Date.now() - startTime}ms)`);
        // 3️⃣ ATUALIZAR AGENDAMENTO
        const historyEntry = {
            action: addToBalance ? 'confirmed_with_balance' : 'confirmed',
            newStatus: 'confirmed',
            changedBy: req.user._id,
            timestamp: new Date(),
            context: 'operacional',
            details: addToBalance ? {
                addedToBalance: true,
                amount: balanceAmount || appointment.sessionValue || 0
            } : undefined
        };

        const updateData = {
            operationalStatus: 'confirmed',
            clinicalStatus: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
            visualFlag: 'ok',
            $push: { history: historyEntry }
        };

        // 💰 Se for adicionar ao saldo devedor, não marca como pago
        if (addToBalance) {
            updateData.paymentStatus = 'pending';
            updateData.visualFlag = 'pending';
            updateData.addedToBalance = true;
            updateData.balanceAmount = balanceAmount || appointment.sessionValue || 0;
            updateData.balanceDescription = balanceDescription || 'Sessão utilizada - pagamento pendente';
        } else if (packageId) {
            // 🏥 Se for pacote de convênio, mantém pending_receipt
            if (packageDoc && packageDoc.type === 'convenio') {
                updateData.paymentStatus = 'pending_receipt';
                updateData.visualFlag = 'pending';
            } else {
                updateData.paymentStatus = 'package_paid';
            }
        } else {
            updateData.paymentStatus = 'paid';
        }

        // 💰 Atualizar sessionValue se estiver vazio
        if (!appointment.sessionValue || appointment.sessionValue === 0) {
            let valueToSet = 0;

            if (addToBalance && balanceAmount > 0) {
                // 💳 Saldo devedor: usar o valor informado
                valueToSet = balanceAmount;
            } else if (finalPaymentId) {
                // 💳 Pagamento normal: usar valor do payment
                const paymentDoc = await Payment.findOne(
                    { _id: finalPaymentId },
                    { amount: 1 },
                    { session }
                );
                valueToSet = paymentDoc?.amount || 0;
            }

            if (valueToSet > 0) {
                updateData.sessionValue = valueToSet;
                console.log(`[complete] Atualizando sessionValue: ${valueToSet}`);
            }
        }

        console.log(`[complete] Executando Appointment.updateOne (${Date.now() - startTime}ms)`);
        await Appointment.updateOne({ _id: id }, updateData, { session });
        console.log(`[complete] Appointment.updateOne concluído (${Date.now() - startTime}ms)`);

        // 5️⃣ COMMIT
        console.log(`[complete] Commitando transação... (${Date.now() - startTime}ms)`);
        await session.commitTransaction();
        console.log(`[complete] ✅ Transação commitada (${Date.now() - startTime}ms)`);

        // 🔔 Emitir evento socket para atualizar agenda externa
        try {
            const io = getIo();
            io.emit('appointmentUpdated', {
                _id: id,
                operationalStatus: 'confirmed',
                clinicalStatus: 'completed',
                paymentStatus: updateData.paymentStatus,
                visualFlag: 'ok',
                source: 'crm_complete'
            });
            console.log(`📡 Socket emitido: appointmentUpdated (completed) ${id}`);
        } catch (socketError) {
            console.error('⚠️ Erro ao emitir socket:', socketError.message);
        }

        // ============================================================
        // FASE 3: OPERAÇÕES PÓS-COMMIT (não bloqueiam resposta)
        // ============================================================

        // 🏥 CONSUMIR GUIA DE CONVÊNIO e CRIAR PAYMENT (se for pacote de convênio)
        if (packageId && packageDoc?.type === 'convenio') {
            try {
                // Consumir guia
                if (packageDoc?.insuranceGuide) {
                    console.log(`[complete] Consumindo guia de convênio... (${Date.now() - startTime}ms)`);
                    const guideResult = await guideService.consumeGuideSession(packageDoc.insuranceGuide);
                    console.log(`[complete] ✅ Guia consumida - Restam ${guideResult.remaining} sessões (${Date.now() - startTime}ms)`);
                }

                // Criar Payment para faturamento
                console.log(`[complete] Criando payment de convênio... (${Date.now() - startTime}ms)`);
                const InsuranceGuide = mongoose.model('InsuranceGuide');
                const guide = packageDoc?.insuranceGuide ? await InsuranceGuide.findById(packageDoc.insuranceGuide) : null;

                // Buscar valor do convênio
                const convenioValue = await Convenio.getSessionValue(packageDoc.insuranceProvider) || 0;
                console.log(`[complete] Valor do convênio ${packageDoc.insuranceProvider}: R$ ${convenioValue}`);

                const newPayment = new Payment({
                    patient: patientId,
                    doctor: appointment.doctor?._id || appointment.doctor,
                    appointment: appointment._id,
                    session: sessionId,
                    package: packageId,
                    amount: 0,
                    billingType: 'convenio',
                    insuranceProvider: packageDoc.insuranceProvider,
                    insuranceValue: convenioValue,
                    paymentMethod: 'convenio',
                    status: 'pending',
                    kind: 'manual',
                    insurance: {
                        provider: packageDoc.insuranceProvider,
                        grossAmount: convenioValue,
                        authorizationCode: guide?.authorizationCode || null,
                        status: 'pending_billing'
                    },
                    serviceDate: appointment.date,
                    notes: `Sessão de convênio - Guia ${guide?.number || 'N/A'} - Pacote ${packageId}`
                });

                await newPayment.save();

                // Vincular payment ao agendamento
                await Appointment.updateOne(
                    { _id: id },
                    { $set: { payment: newPayment._id } }
                );

                // Atualizar pacote com o valor do convênio (para relatórios de receita)
                if (convenioValue > 0 && packageId) {
                    await Package.updateOne(
                        { _id: packageId },
                        {
                            $set: {
                                insuranceGrossAmount: convenioValue,
                                sessionValue: convenioValue
                            }
                        }
                    );
                    console.log(`[complete] ✅ Pacote atualizado com valor do convênio: ${convenioValue} (${Date.now() - startTime}ms)`);
                }

                console.log(`[complete] ✅ Payment criado: ${newPayment._id} (${Date.now() - startTime}ms)`);
            } catch (guideError) {
                console.error(`[complete] ❌ Erro ao processar convênio (não crítico): ${guideError.message}`);
            }
        }

        // 1️⃣ ATUALIZAR SESSÃO (fora da transação - evita lock)
        if (sessionId) {
            try {
                console.log(`[complete] Atualizando session ${sessionId} (fora da transação)... (${Date.now() - startTime}ms)`);
                await Session.findOneAndUpdate(
                    { _id: sessionId },
                    sessionUpdateData
                );
                console.log(`[complete] Session atualizada (${Date.now() - startTime}ms)`);

                // 🏥 Consumir guia de convênio se a sessão tiver guia vinculada
                if (sessionUpdateData.status === 'completed') {
                    const session = await Session.findById(sessionId);
                    if (session?.insuranceGuide && !session.guideConsumed) {
                        try {
                            console.log(`[complete] Consumindo guia ${session.insuranceGuide} para sessão ${sessionId}...`);
                            const InsuranceGuide = mongoose.model('InsuranceGuide');
                            const guide = await InsuranceGuide.findById(session.insuranceGuide);

                            if (guide && guide.status === 'active' && guide.usedSessions < guide.totalSessions) {
                                guide.usedSessions += 1;
                                if (guide.usedSessions >= guide.totalSessions) {
                                    guide.status = 'exhausted';
                                }
                                await guide.save();

                                // Marcar sessão como consumida
                                await Session.updateOne(
                                    { _id: sessionId },
                                    { $set: { guideConsumed: true } }
                                );

                                console.log(`[complete] ✅ Guia consumida: ${guide.usedSessions}/${guide.totalSessions}`);
                            }
                        } catch (guideErr) {
                            console.error(`[complete] ❌ Erro ao consumir guia: ${guideErr.message}`);
                        }
                    }
                }
            } catch (err) {
                console.error('[complete] ❌ Erro ao atualizar session (não crítico):', err.message);
            }
        }

        // 6️⃣ ATUALIZAR SALDO DEVEDOR (fora da transação)
        console.log(`[complete] Verificando saldo devedor - addToBalance: ${addToBalance}, patientId: ${patientId} (${Date.now() - startTime}ms)`);
        if (addToBalance && patientId) {
            console.log(`[complete] Atualizando saldo devedor... (${Date.now() - startTime}ms)`);
            try {
                const patientBalance = await PatientBalance.getOrCreate(patientId);
                await patientBalance.addDebit(
                    balanceAmount || appointment.sessionValue || 0,
                    balanceDescription || `Sessão ${appointment.date} - pagamento pendente`,
                    sessionId,
                    appointment._id,
                    req.user?._id
                );
                console.log(`[complete] ✅ Débito adicionado (${Date.now() - startTime}ms)`);
            } catch (err) {
                console.error(`[complete] ❌ Erro ao atualizar saldo (não crítico): ${err.message}`);
            }
        }

        // 7️⃣ BUSCAR DADOS FINAIS (retorno idêntico ao original)
        console.log(`[complete] Buscando dados finais... (${Date.now() - startTime}ms)`);
        const finalAppointment = await Appointment.findById(id)
            .populate('session package patient doctor payment');

        // 💰 BUSCAR SALDO DEVEDOR DO PACIENTE
        let patientBalance = 0;
        if (finalAppointment?.patient?._id) {
            try {
                const balanceDoc = await PatientBalance.findOne({ patient: finalAppointment.patient._id });
                if (balanceDoc) {
                    patientBalance = balanceDoc.currentBalance;
                }
            } catch (err) {
                console.error('[complete] Erro ao buscar saldo (não crítico):', err.message);
            }
        }

        // 8️⃣ SINCRONIZAR (não bloqueia resposta)
        setImmediate(async () => {
            try {
                await syncEvent(finalAppointment, 'appointment');
                console.log(`[complete] Sync concluído`);
            } catch (syncError) {
                console.error('[complete] ⚠️ Erro no sync (não crítico):', syncError.message);
            }
        });

        console.log(`[complete] ✅ Respondendo em ${Date.now() - startTime}ms`);

        // Adicionar patientBalance ao objeto de resposta
        const responseData = finalAppointment.toObject ? finalAppointment.toObject() : finalAppointment;
        responseData.patientBalance = patientBalance;

        res.json(responseData);

    } catch (error) {
        if (session) {
            try {
                await session.abortTransaction();
                console.log(`[complete] Transação abortada (${Date.now() - startTime}ms)`);
            } catch (abortErr) {
                console.error('[complete] Erro ao abortar transação:', abortErr.message);
            }
        }
        console.error(`[complete] ❌ Erro ao concluir (${Date.now() - startTime}ms):`, error);
        res.status(500).json({
            error: 'Erro interno no servidor',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (session) {
            try {
                session.endSession();
            } catch (e) {
                // Silenciar erro ao fechar sessão
            }
        }
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
                    formattedDate: session.date && isValidDateString(session.date)
                        ? new Date(session.date).toLocaleDateString('pt-BR')
                        : 'Data não disponível',
                    formattedTime: session.time || '--:--',
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

        // 🎯 CONTAR PRÉ-AGENDAMENTOS (para mostrar na mesma contagem)
        const preFilter = {
            status: { $nin: ['importado', 'descartado'] }
        };
        if (dateFrom || dateTo) {
            preFilter.preferredDate = {};
            if (dateFrom) preFilter.preferredDate.$gte = dateFrom;
            if (dateTo) preFilter.preferredDate.$lte = dateTo;
        }
        if (specialty && specialty !== 'all') {
            preFilter.specialty = specialty;
        }

        const preAgendamentosCount = await PreAgendamento.countDocuments(preFilter);

        // Formatar resultado
        const result = {
            agendado: 0,
            confirmado: 0,
            cancelado: 0,
            pago: 0,
            faltou: 0,
            pre_agendado: preAgendamentosCount // 🎯 NOVO: Contagem de pré-agendamentos
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

// NOVO: Confirmação direta de agendamento (Pendente -> Confirmado)
router.patch('/:id/confirm', validateId, auth, async (req, res) => {
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
                    status: 'confirmed',
                    // isPaid: true, // REMOVIDO
                    updatedAt: new Date()
                }
            }, { session });
        }

        await session.commitTransaction();

        // Sincronização pós-commit (opcional, mas recomendado)
        setTimeout(() => syncEvent(updatedAppointment, 'appointment').catch(console.error), 100);

        res.json({ success: true, appointment: updatedAppointment });

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

        return res.json({ success: true, appointment });
    } catch (err) {
        console.error('❌ Erro bookFromAmanda:', err);
        return res.status(500).json({ error: err.message });
    }
};

export default router;