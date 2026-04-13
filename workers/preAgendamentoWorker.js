// workers/preAgendamentoWorker.js
import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import { appointmentHybridService } from '../services/appointmentHybridService.js';
import { buildDateTime } from '../utils/datetime.js';

const processedEvents = new Map();
const EVENT_CACHE_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [eventId, timestamp] of processedEvents) {
        if (now - timestamp > EVENT_CACHE_TTL) {
            processedEvents.delete(eventId);
        }
    }
}, 60 * 60 * 1000);

export function startPreAgendamentoWorker() {
    const worker = new Worker('preagendamento-processing', async (job) => {
        const { eventId, eventType, correlationId, payload } = job.data;
        
        console.log(`[PreAgendamentoWorker] Processando ${eventType}: ${eventId}`);
        
        // IDEMPOTÊNCIA local (cache em memória do worker)
        if (processedEvents.has(eventId)) {
            console.log(`[PreAgendamentoWorker] Evento já processado: ${eventId}`);
            return { status: 'already_processed' };
        }
        
        try {
            let result;
            
            switch (eventType) {
                case 'PREAGENDAMENTO_CREATED':
                    result = await handleCreated(payload, eventId);
                    break;
                case 'PREAGENDAMENTO_IMPORTED':
                    result = await handleImported(payload, eventId);
                    break;
                case 'PREAGENDAMENTO_STATUS_CHANGED':
                    result = await handleStatusChanged(payload, eventId);
                    break;
                default:
                    throw new Error(`Tipo de evento desconhecido: ${eventType}`);
            }
            
            processedEvents.set(eventId, Date.now());
            return result;
            
        } catch (error) {
            console.error(`[PreAgendamentoWorker] Erro:`, error.message);
            
            if (job.attemptsMade >= 4) {
                await moveToDLQ(job, error);
            }
            
            throw error;
        }
        
    }, {
        connection: redisConnection,
        concurrency: 5,
        limiter: { max: 10, duration: 1000 }
    });
    
    worker.on('completed', (job, result) => {
        console.log(`[PreAgendamentoWorker] Job ${job.id} completado:`, result.status);
    });
    
    worker.on('failed', (job, error) => {
        console.error(`[PreAgendamentoWorker] Job ${job?.id} falhou:`, error.message);
    });
    
    console.log('[PreAgendamentoWorker] Worker iniciado');
    return worker;
}

async function handleCreated(payload, eventId) {
    const { patientInfo, preferredDate, preferredTime, specialty, notes, status, createdBy } = payload;
    
    const preAgendamento = new Appointment({
        patientInfo,
        date: preferredDate ? new Date(preferredDate) : undefined,
        time: preferredTime,
        specialty,
        notes,
        operationalStatus: 'pre_agendado',
        clinicalStatus: 'pending',
        paymentStatus: 'pending',
        createdBy,
        createdAt: new Date()
    });
    
    await preAgendamento.save();
    
    console.log(`[PreAgendamentoWorker] Criado: ${preAgendamento._id}`);
    
    return { 
        status: 'success', 
        eventId, 
        preAgendamentoId: preAgendamento._id 
    };
}

async function handleImported(payload, eventId) {
    const { preAgendamentoId, doctorId, date, time, notes, importedBy } = payload;
    
    // Busca o pré-agendamento
    const preAgendamento = await Appointment.findById(preAgendamentoId);
    if (!preAgendamento) {
        throw new Error(`Pré-agendamento não encontrado: ${preAgendamentoId}`);
    }
    
    // IDEMPOTÊNCIA: já foi importado?
    if (preAgendamento.operationalStatus !== 'pre_agendado' && preAgendamento.appointmentId) {
        console.log(`[PreAgendamentoWorker] Já importado anteriormente: ${preAgendamentoId} -> ${preAgendamento.appointmentId}`);
        return {
            status: 'already_imported',
            preAgendamentoId,
            appointmentId: preAgendamento.appointmentId
        };
    }
    
    // Resolve Patient
    let patientId = preAgendamento.patient;
    let patient = null;
    
    if (patientId) {
        patient = await Patient.findById(patientId);
    }
    
    if (!patient && preAgendamento.patientInfo?.phone) {
        const cleanPhone = preAgendamento.patientInfo.phone.replace(/\D/g, '');
        patient = await Patient.findOne({ phone: { $regex: cleanPhone.slice(-10) } }).lean();
        if (patient) patientId = patient._id.toString();
    }
    
    if (!patient && preAgendamento.patientInfo?.name) {
        const newPatient = await Patient.create({
            fullName: preAgendamento.patientInfo.name,
            phone: preAgendamento.patientInfo.phone || '',
            birthDate: preAgendamento.patientInfo.birthDate || null,
            email: preAgendamento.patientInfo.email || null,
            source: 'pre-agendamento-v2'
        });
        patientId = newPatient._id.toString();
        patient = newPatient;
    }
    
    if (!patientId) {
        throw new Error(`Não foi possível resolver paciente para pré-agendamento ${preAgendamentoId}`);
    }
    
    // Transação MongoDB + CRM Core V2 (appointmentHybridService)
    const mongoSession = await mongoose.startSession();
    mongoSession.startTransaction();
    
    try {
        const hybridResult = await appointmentHybridService.create({
            patientId,
            doctorId,
            date: buildDateTime(date, time),
            time,
            specialty: preAgendamento.specialty || 'fonoaudiologia',
            serviceType: 'evaluation', // Pré-agendamento da agenda externa = avaliação inicial
            billingType: 'particular',
            paymentMethod: 'pix',
            amount: 0,
            notes: notes || preAgendamento.notes || '',
            userId: importedBy
        }, mongoSession);
        
        // Atualiza operationalStatus para scheduled (padrão CRM)
        hybridResult.appointment.operationalStatus = 'scheduled';
        await hybridResult.appointment.save({ session: mongoSession });
        
        // Vincula pré-agendamento ao appointment real
        if (!hybridResult.appointment?._id) {
            throw new Error('Falha ao criar agendamento: appointment._id não retornado pelo hybridService');
        }
        preAgendamento.operationalStatus = 'converted';
        preAgendamento.doctor = null; // libera o slot para o appointment real
        preAgendamento.appointmentId = hybridResult.appointment._id;
        preAgendamento.importedBy = importedBy;
        preAgendamento.importedAt = new Date();
        await preAgendamento.save({ session: mongoSession });
        
        await mongoSession.commitTransaction();
        
        console.log(`[PreAgendamentoWorker] Importado via CRM Core: ${preAgendamentoId} -> ${hybridResult.appointment._id}`);
        
        return { 
            status: 'success', 
            eventId, 
            preAgendamentoId, 
            appointmentId: hybridResult.appointment._id,
            sessionId: hybridResult.session?._id || null,
            paymentId: hybridResult.payment?._id || null
        };
        
    } catch (error) {
        await mongoSession.abortTransaction().catch(() => {});
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

async function handleStatusChanged(payload, eventId) {
    const { preAgendamentoId, status, reason, changedBy } = payload;
    
    const preAgendamento = await Appointment.findById(preAgendamentoId);
    if (!preAgendamento) {
        throw new Error(`Pré-agendamento não encontrado: ${preAgendamentoId}`);
    }
    
    const oldStatus = preAgendamento.status;
    preAgendamento.status = status;
    
    if (reason) {
        preAgendamento.statusReason = reason;
    }
    
    preAgendamento.statusHistory = preAgendamento.statusHistory || [];
    preAgendamento.statusHistory.push({
        from: oldStatus,
        to: status,
        reason,
        changedBy,
        changedAt: new Date()
    });
    
    await preAgendamento.save();
    
    console.log(`[PreAgendamentoWorker] Status: ${preAgendamentoId} ${oldStatus} -> ${status}`);
    
    return { 
        status: 'success', 
        eventId, 
        preAgendamentoId,
        oldStatus,
        newStatus: status
    };
}
