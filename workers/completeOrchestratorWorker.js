/**
 * Worker: Complete Orchestrator
 * 
 * Responsabilidade: Processar eventos de completação de appointments
 * com garantias de idempotência, timeout e recuperação automática.
 * 
 * Arquitetura:
 * - Payment = autoridade financeira (única fonte da verdade)
 * - Session = autoridade clínica (status da sessão)
 * - Appointment = reflexo agregado (atualizado via eventos)
 */

import { Worker } from 'bullmq';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import EventStore from '../models/EventStore.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { withFinancialContext } from '../utils/financialContext.js';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

// ============ CONFIGURAÇÕES DE PROTEÇÃO ============
const WORKER_TIMEOUT_MS = 30000; // 30 segundos máximo
const MEMORY_THRESHOLD_PERCENT = 85; // Rejeita jobs se memória > 85%
const MAX_RETRY_ATTEMPTS = 3;

// ============ MONITORAMENTO DE MEMÓRIA ============
function checkMemoryPressure() {
    const usage = process.memoryUsage();
    const heapPercent = Math.round((usage.heapUsed / usage.heapTotal) * 100);
    
    if (heapPercent > MEMORY_THRESHOLD_PERCENT) {
        console.error(`[MEMORY ALERT] Heap usage: ${heapPercent}% - Rejeitando job`);
        return { pressure: true, heapPercent };
    }
    return { pressure: false, heapPercent };
}

// ============ IDEMPOTÊNCIA - VERIFICAÇÃO MULTI-CAMADA ============
async function checkIdempotency(appointmentId, idempotencyKey) {
    // Camada 1: EventStore (já processado?)
    const existingEvent = await EventStore.findOne({
        idempotencyKey,
        status: { $in: ['processed'] }
    });
    
    if (existingEvent) {
        return {
            shouldSkip: true,
            reason: 'idempotency_key_exists',
            eventId: existingEvent._id
        };
    }

    // Camada 2: Appointment já completed?
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
        return { shouldSkip: true, reason: 'appointment_not_found' };
    }
    
    if (appointment.clinicalStatus === 'completed') {
        return {
            shouldSkip: true,
            reason: 'appointment_already_completed',
            appointmentId
        };
    }

    // Camada 3: Session já completed?
    if (appointment.sessionId) {
        const session = await Session.findById(appointment.sessionId);
        if (session?.status === 'completed') {
            return {
                shouldSkip: true,
                reason: 'session_already_completed',
                sessionId: session._id
            };
        }
    }

    return { shouldSkip: false, appointment };
}

// ============ LIBERAÇÃO DE LOCK ============
async function releaseAppointmentLock(appointmentId) {
    try {
        await Appointment.findByIdAndUpdate(appointmentId, {
            $unset: { lock: 1 },
            $set: { lockedAt: null }
        });
        console.log(`[LOCK] Lock liberado para appointment ${appointmentId}`);
    } catch (err) {
        console.error(`[LOCK ERROR] Falha ao liberar lock:`, err.message);
    }
}

// ============ CRIAÇÃO/ATUALIZAÇÃO DE SESSION ============
async function ensureSessionCompleted(appointment, sessionData) {
    const sessionId = appointment.sessionId;
    
    if (!sessionId) {
        // Criar nova session
        console.log(`[SESSION] Criando nova session para appointment ${appointment._id}`);
        
        const newSession = await Session.create({
            patient: appointment.patient,
            patientId: appointment.patient,
            doctor: appointment.doctor,
            doctorId: appointment.doctor,
            appointment: appointment._id,
            appointmentId: appointment._id,
            date: appointment.date,
            time: appointment.time,
            status: 'completed',
            clinicalStatus: 'completed',
            serviceType: appointment.serviceType || 'session',
            notes: sessionData?.notes || `Sessão criada via completação em ${new Date().toISOString()}`,
            clinicId: appointment.clinicId || 'default',
            completedAt: new Date()
        });
        
        // Atualizar appointment com referência
        await Appointment.findByIdAndUpdate(appointment._id, {
            sessionId: newSession._id,
            session: newSession._id
        });
        
        return newSession;
    }
    
    // Atualizar session existente
    const existingSession = await Session.findById(sessionId);
    
    if (!existingSession) {
        throw new Error(`Session ${sessionId} referenciada mas não encontrada`);
    }
    
    if (existingSession.status === 'completed') {
        console.log(`[SESSION] Session ${sessionId} já está completed`);
        return existingSession;
    }
    
    // Atualizar para completed
    const updatedSession = await Session.findByIdAndUpdate(
        sessionId,
        {
            status: 'completed',
            clinicalStatus: 'completed',
            completedAt: new Date(),
            ...(sessionData?.notes && { notes: sessionData.notes })
        },
        { new: true }
    );
    
    console.log(`[SESSION] Session ${sessionId} atualizada para completed`);
    return updatedSession;
}

// ============ ATUALIZAÇÃO DE PAYMENT ============
async function ensurePaymentCompleted(appointment, paymentData) {
    if (!paymentData?.paymentId) {
        console.log(`[PAYMENT] Sem paymentId fornecido, pulando atualização`);
        return null;
    }
    
    const payment = await Payment.findById(paymentData.paymentId);
    
    if (!payment) {
        console.warn(`[PAYMENT] Payment ${paymentData.paymentId} não encontrado`);
        return null;
    }
    
    if (payment.status === 'paid') {
        console.log(`[PAYMENT] Payment ${payment._id} já está paid`);
        return payment;
    }
    
    // Atualizar payment com contexto financeiro (único permitido)
    const updatedPayment = await Payment.safeUpdate(
        { _id: payment._id },
        {
            status: 'paid',
            paidAt: new Date(),
            serviceDate: appointment.date,
            ...(paymentData.amount && { amount: paymentData.amount }),
            ...(paymentData.paymentMethod && { paymentMethod: paymentData.paymentMethod })
        }
    );
    
    console.log(`[PAYMENT] Payment ${payment._id} atualizado para paid`);
    return updatedPayment;
}

// ============ PROCESSAMENTO PRINCIPAL COM TIMEOUT ============
async function processCompleteJobInternal(jobData) {
    const { appointmentId, idempotencyKey, sessionData, paymentData, metadata } = jobData;
    
    console.log(`[PROCESS] Iniciando completação para appointment ${appointmentId}`);
    console.log(`[PROCESS] IdempotencyKey: ${idempotencyKey}`);
    
    // 1. Verificar idempotência
    const idempotencyCheck = await checkIdempotency(appointmentId, idempotencyKey);
    if (idempotencyCheck.shouldSkip) {
        console.log(`[IDEMPOTENCY] Pulando: ${idempotencyCheck.reason}`);
        return {
            status: 'skipped',
            reason: idempotencyCheck.reason,
            appointmentId
        };
    }
    
    const appointment = idempotencyCheck.appointment;
    
    // 2. Criar registro no EventStore
    let eventRecord = await EventStore.findOne({ idempotencyKey });
    if (!eventRecord) {
        eventRecord = await EventStore.create({
            idempotencyKey,
            type: EventTypes.APPOINTMENT_COMPLETED,
            status: 'processing',
            payload: jobData,
            aggregateType: 'appointment',
            aggregateId: appointmentId,
            attempts: 0
        });
    } else if (eventRecord.status === 'processing') {
        // Incrementar contador de tentativas
        eventRecord.attempts = (eventRecord.attempts || 0) + 1;
        await eventRecord.save();
    }
    
    try {
        // 3. Processar dentro de contexto financeiro
        await withFinancialContext('payment', async () => {
            // 3.1 Atualizar Session
            const session = await ensureSessionCompleted(appointment, sessionData);
            
            // 3.2 Atualizar Payment (se aplicável)
            const payment = await ensurePaymentCompleted(appointment, paymentData);
            
            // 3.3 Atualizar Appointment (reflexo agregado)
            await Appointment.findByIdAndUpdate(appointmentId, {
                clinicalStatus: 'completed',
                status: 'completed',
                completedAt: new Date(),
                completedBy: metadata?.userId || null,
                'financial.paymentStatus': payment?.status || 'pending'
            });
            
            // 3.4 Publicar evento de domínio
            await publishEvent(EventTypes.APPOINTMENT_COMPLETED, {
                appointmentId,
                sessionId: session._id,
                paymentId: payment?._id,
                patientId: appointment.patient,
                completedAt: new Date()
            });
        });
        
        // 4. Marcar evento como completo
        eventRecord.status = 'completed';
        eventRecord.completedAt = new Date();
        await eventRecord.save();
        
        // 5. Liberar lock
        await releaseAppointmentLock(appointmentId);
        
        console.log(`[SUCCESS] Appointment ${appointmentId} completado com sucesso`);
        
        return {
            status: 'success',
            appointmentId,
            eventId: eventRecord._id
        };
        
    } catch (error) {
        // Marcar erro no EventStore
        eventRecord.status = 'failed';
        eventRecord.error = error.message;
        await eventRecord.save();
        
        throw error;
    }
}

// ============ WRAPPER COM TIMEOUT ============
async function processCompleteJob(jobData) {
    const { appointmentId } = jobData;
    
    // Verificar memória antes de aceitar
    const memCheck = checkMemoryPressure();
    if (memCheck.pressure) {
        throw new Error(`MEMORY_PRESSURE: Heap ${memCheck.heapPercent}%`);
    }
    
    // Timeout de 30 segundos
    return Promise.race([
        processCompleteJobInternal(jobData),
        new Promise((_, reject) => 
            setTimeout(() => {
                reject(new Error(`PROCESS_TIMEOUT: Job excedeu ${WORKER_TIMEOUT_MS}ms`));
            }, WORKER_TIMEOUT_MS)
        )
    ]).catch(async (error) => {
        // Em caso de timeout ou erro, garantir liberação do lock
        await releaseAppointmentLock(appointmentId);
        throw error;
    });
}

// ============ INICIALIZAÇÃO DO WORKER ============
export function startCompleteOrchestratorWorker() {
    const worker = new Worker(
        'complete-orchestrator',
        async (job) => {
            console.log(`[WORKER] Job ${job.id} recebido:`, job.name);
            return processCompleteJob(job.data);
        },
        {
            connection: redis,
            concurrency: 3,
            limiter: {
                max: 10,
                duration: 1000
            }
        }
    );
    
    worker.on('completed', (job, result) => {
        console.log(`[WORKER] Job ${job.id} completado:`, result.status);
    });
    
    worker.on('failed', (job, err) => {
        console.error(`[WORKER] Job ${job?.id} falhou:`, err.message);
    });
    
    console.log('[WORKER] Complete Orchestrator Worker iniciado');
    return worker;
}

// Export para testes
export { processCompleteJob, checkMemoryPressure, checkIdempotency };
