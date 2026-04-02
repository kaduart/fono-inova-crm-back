// workers/preAgendamentoWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';

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
        
        // IDEMPOTÊNCIA
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
        type: 'pre-agendamento',
        patientInfo,
        preferredDate: new Date(preferredDate),
        preferredTime,
        specialty,
        notes,
        status: status || 'novo',
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
    
    // Cria o appointment real
    const appointment = new Appointment({
        type: 'consulta',
        patientId: preAgendamento.patientInfo?.patientId,
        patientName: preAgendamento.patientInfo?.name,
        patientPhone: preAgendamento.patientInfo?.phone,
        doctorId,
        date: new Date(date),
        time,
        specialty: preAgendamento.specialty,
        notes: notes || preAgendamento.notes,
        status: 'agendado',
        preAgendamentoId: preAgendamento._id,
        importedBy,
        importedAt: new Date()
    });
    
    await appointment.save();
    
    // Atualiza o pré-agendamento
    preAgendamento.status = 'agendado';
    preAgendamento.appointmentId = appointment._id;
    await preAgendamento.save();
    
    console.log(`[PreAgendamentoWorker] Importado: ${preAgendamentoId} -> ${appointment._id}`);
    
    return { 
        status: 'success', 
        eventId, 
        preAgendamentoId, 
        appointmentId: appointment._id 
    };
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
