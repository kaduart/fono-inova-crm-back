/**
 * ============================================================================
 * BILLING CONSUMER WORKER - BullMQ
 * ============================================================================
 * 
 * Consome eventos da fila 'billing-orchestrator' e processa via
 * insuranceBillingService V2 existente.
 * 
 * Responsabilidades:
 * - Consumir SESSION_COMPLETED
 * - Delegar para InsuranceBillingService
 * - Gerenciar retry e DLQ
 * - Idempotência via correlationId
 * ============================================================================
 */

import { Worker } from 'bullmq';
import { insuranceBillingService } from '../services/insuranceBillingService.v2.js';
import EventStore from '../../../models/EventStore.js';
import Payment from '../../../models/Payment.js';
import Appointment from '../../../models/Appointment.js';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { validatePaymentEvent, generatePaymentIdempotencyKey } from '../contracts/PaymentEvents.contract.js';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// CONFIGURAÇÃO
// =============================================================================

const WORKER_CONFIG = {
  concurrency: 5,                    // Processa 5 jobs em paralelo
  lockDuration: 30000,               // 30s lock por job
  stalledInterval: 30000,            // Check de stalls a cada 30s
  maxStalledCount: 2                 // Max 2 stalls antes de falhar
};

const RETRY_CONFIG = {
  attempts: 4,                       // 4 tentativas totais
  backoff: {
    type: 'exponential',             // Espera cresce exponencialmente
    delay: 2000                      // 2s, 4s, 8s, 16s
  }
};

import { bullMqConnection as redisConnection } from '../../../config/redisConnection.js';
import { getQueue } from '../../../infrastructure/queue/queueConfig.js';

// =============================================================================
// WORKER
// =============================================================================

let worker = null;

export function startBillingConsumerWorker() {
  if (worker) {
    console.warn('[BillingWorker] Already started');
    return worker;
  }

  worker = new Worker(
    'billing-orchestrator',           // Queue name
    processJob,                       // Processor function
    {
      connection: redisConnection,
      ...WORKER_CONFIG
    }
  );

  // Event handlers
  worker.on('completed', (job, result) => {
    console.log(`[BillingWorker] Completed: ${job.id}`, {
      sessionId: job.data.payload?.sessionId,
      duplicate: result?.duplicate,
      duration: Date.now() - job.timestamp
    });
  });

  worker.on('failed', (job, err) => {
    console.error(`[BillingWorker] Failed: ${job?.id}`, {
      sessionId: job?.data?.payload?.sessionId,
      error: err.message,
      attempts: job?.attemptsMade
    });
  });

  worker.on('stalled', (jobId) => {
    console.warn(`[BillingWorker] Stalled: ${jobId}`);
  });

  worker.on('error', (err) => {
    console.error('[BillingWorker] Worker error:', err);
  });

  console.log('[BillingWorker] Started successfully');
  return worker;
}

export function stopBillingConsumerWorker() {
  if (worker) {
    worker.close();
    worker = null;
    console.log('[BillingWorker] Stopped');
  }
}

export function getBillingWorkerStatus() {
  return {
    isRunning: !!worker,
    queueName: 'billing-orchestrator'
  };
}

// =============================================================================
// PROCESSOR
// =============================================================================

/** Exportado apenas para testes — não usar em produção diretamente */
export { processJob };

async function processJob(job) {
  const { eventType, eventId, correlationId, payload, timestamp } = job.data;
  
  console.log(`[BillingWorker] Processing job ${job.id}: ${eventType}`);

  switch (eventType) {
    case 'SESSION_COMPLETED':
      return await handleSessionCompleted(payload, correlationId, job);
    
    case 'SESSION_BILLED':
      return await handleSessionBilled(payload, correlationId, job);
    
    case 'SESSION_RECEIVED':
      return await handleSessionReceived(payload, correlationId, job);
    
    case 'APPOINTMENT_BILLING_REQUESTED':
      return await handleAppointmentBillingRequested(payload, correlationId, job);

    case 'SESSION_BILLING_REQUESTED':
      // Sessões particular/pacote completadas — roteadas pelo IntegrationWorker
      // Por ora delegamos para o mesmo fluxo do appointment se houver appointmentId
      if (payload.appointmentId) {
        return await handleAppointmentBillingRequested(
          { ...payload, appointmentId: payload.appointmentId },
          correlationId,
          job
        );
      }
      return { status: 'skipped', reason: 'NO_APPOINTMENT_ID', sessionId: payload.sessionId };

    default:
      console.warn(`[BillingWorker] Unknown event type: ${eventType}`);
      return { status: 'ignored', reason: 'UNKNOWN_EVENT_TYPE' };
  }
}

/**
 * Handler principal: Session Completed → Billing
 */
async function handleSessionCompleted(payload, correlationId, job) {
  const { sessionId, patientId, specialty, paymentType } = payload;
  
  // Validações básicas
  if (!sessionId) {
    throw new Error('Missing sessionId in payload');
  }
  
  if (paymentType !== 'convenio') {
    return { 
      status: 'skipped', 
      reason: 'NOT_INSURANCE_SESSION',
      sessionId 
    };
  }

  try {
    // Delega para o service existente V2
    const result = await insuranceBillingService.processSessionCompleted(
      sessionId,
      { correlationId: correlationId || `worker_${job.id}_${uuidv4()}` }
    );

    // Se é duplicata, considera sucesso (idempotência)
    if (result.duplicate) {
      return {
        status: 'success',
        duplicate: true,
        source: result.source,
        billingId: result.billingId,
        sessionId
      };
    }

    return {
      status: 'success',
      billingId: result.billingId,
      paymentId: result.paymentId,
      guideId: result.guideId,
      amount: result.amount,
      sessionId
    };

  } catch (error) {
    // Classifica erro para retry ou não
    const isRetryable = isRetryableError(error);
    
    console.error(`[BillingWorker] Error processing session ${sessionId}:`, {
      error: error.message,
      code: error.code,
      retryable: isRetryable,
      attempt: job.attemptsMade + 1
    });

    if (!isRetryable) {
      // Move para DLQ imediatamente
      await moveToDLQ(job, error);
      return { status: 'failed', movedToDLQ: true, error: error.message };
    }

    // Deixa o BullMQ fazer retry
    throw error;
  }
}

const PAYMENT_METHOD_MAP = {
  dinheiro:              'cash',
  pix:                   'pix',
  cartao_credito:        'credit_card',
  cartao_debito:         'debit_card',
  cartão:                'credit_card',
  transferencia_bancaria:'bank_transfer',
  bank_transfer:         'bank_transfer',
  credit_card:           'credit_card',
  debit_card:            'debit_card',
  cash:                  'cash',
};
const mapPaymentMethod = (m) => PAYMENT_METHOD_MAP[m] || 'other';

/**
 * Handler: APPOINTMENT_BILLING_REQUESTED → decide e cria Payment
 *
 * paymentOrigin define o fluxo:
 *   auto_per_session → cria Payment 'attended' (particular avulso)
 *   package_prepaid  → skip (PackageProcessingWorker cuida do crédito)
 *   manual_balance   → skip (saldo já foi adicionado ao balance)
 *   convenio         → skip (billingConsumerWorker cuida via SESSION_COMPLETED)
 *   liminar          → skip (fluxo especial não implementado aqui)
 */
async function handleAppointmentBillingRequested(payload, correlationId, job) {
  const { appointmentId, patientId, paymentType, amount } = payload;

  if (!appointmentId) {
    throw new Error('Missing appointmentId in payload');
  }

  // ── 1. Busca appointment ──────────────────────────────────────────────────
  const appointment = await Appointment.findById(appointmentId)
    .select('paymentOrigin billingType patient doctor sessionValue paymentMethod serviceType session package date payment correlationId')
    .lean();

  if (!appointment) {
    const err = new Error(`Appointment not found: ${appointmentId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  const origin = appointment.paymentOrigin;

  // ── 2. Rotas que não são responsabilidade deste handler ───────────────────
  if (!origin || origin === 'convenio') {
    return { status: 'skipped', reason: 'HANDLED_ELSEWHERE', origin, appointmentId };
  }

  if (origin === 'package_prepaid') {
    return { status: 'skipped', reason: 'PACKAGE_HANDLES_CREDIT', origin, appointmentId };
  }

  if (origin === 'manual_balance') {
    return { status: 'skipped', reason: 'BALANCE_ALREADY_ADDED', origin, appointmentId };
  }

  if (origin === 'liminar') {
    return { status: 'skipped', reason: 'LIMINAR_NOT_IMPLEMENTED', origin, appointmentId };
  }

  // ── 3. auto_per_session: cria payment se ainda não existe ─────────────────
  if (origin !== 'auto_per_session') {
    console.warn(`[BillingWorker] Unknown paymentOrigin '${origin}' for appointment ${appointmentId}`);
    return { status: 'skipped', reason: 'UNKNOWN_ORIGIN', origin, appointmentId };
  }

  // Idempotência: só cria se não existe payment para este appointment
  const existing = await Payment.findOne({ appointmentId }).lean();
  if (existing) {
    return {
      status: 'success',
      duplicate: true,
      paymentId: existing._id,
      appointmentId,
    };
  }

  // ── 4. Cria Payment ───────────────────────────────────────────────────────
  const finalCorrelationId = correlationId || `worker_${job.id}_${uuidv4()}`;

  const payment = await Payment.create({
    patientId:     appointment.patient,
    appointmentId: appointment._id,
    sessionId:     appointment.session || null,
    amount:        appointment.sessionValue ?? amount ?? 0,
    paymentDate:   appointment.date || new Date(),
    paymentMethod: mapPaymentMethod(appointment.paymentMethod),
    billingType:   'particular',
    source:        'appointment',
    status:        'pending',
  });

  // ── 5. Publica evento PAYMENT_CREATED no bus ──────────────────────────────
  const eventPayload = {
    paymentId:     payment._id.toString(),
    patientId:     payment.patientId.toString(),
    appointmentId: appointmentId.toString(),
    amount:        payment.amount,
    status:        payment.status,
    source:        payment.source,
    sessionId:     payment.sessionId?.toString() ?? null,
    paymentMethod: payment.paymentMethod,
    billingType:   payment.billingType,
    correlationId: finalCorrelationId,
  };

  // Publicação no event bus é fire-and-forget: nunca faz rollback do payment
  try {
    const validation = validatePaymentEvent('PAYMENT_CREATED', eventPayload);
    if (!validation.valid) {
      console.warn('[BillingWorker] PAYMENT_CREATED payload inválido:', validation.errors);
    } else {
      await publishEvent(EventTypes.PAYMENT_CREATED, eventPayload, {
        correlationId:  finalCorrelationId,
        aggregateType:  'payment',
        aggregateId:    payment._id.toString(),
        idempotencyKey: generatePaymentIdempotencyKey('PAYMENT_CREATED', eventPayload),
        metadata:       { source: 'billing-consumer-worker' },
      });
    }
  } catch (eventErr) {
    // Redis indisponível ou falha no bus — loga mas não reverte o payment
    console.warn('[BillingWorker] PAYMENT_CREATED event não publicado (non-fatal):', eventErr.message);
  }

  console.log(`[BillingWorker] Payment created for appointment ${appointmentId}`, {
    paymentId: payment._id,
    amount: payment.amount,
    correlationId: finalCorrelationId,
  });

  return {
    status:        'success',
    paymentId:     payment._id,
    amount:        payment.amount,
    appointmentId,
    origin:        'auto_per_session',
  };
}

/**
 * Handler: Session Billed → Atualiza Payment
 */
async function handleSessionBilled(payload, correlationId, job) {
  const { sessionId, billedAmount, billedAt, invoiceNumber } = payload;
  
  if (!sessionId) {
    throw new Error('Missing sessionId in payload');
  }
  
  try {
    const result = await insuranceBillingService.processSessionBilled(
      sessionId,
      { billedAmount, billedAt, invoiceNumber },
      { correlationId: correlationId || `worker_${job.id}_${uuidv4()}` }
    );
    
    if (result.duplicate) {
      return {
        status: 'success',
        duplicate: true,
        paymentId: result.paymentId,
        status: result.status,
        sessionId
      };
    }
    
    return {
      status: 'success',
      paymentId: result.paymentId,
      status: result.status,
      sessionId
    };
    
  } catch (error) {
    const isRetryable = isRetryableError(error);
    
    console.error(`[BillingWorker] Error processing billed ${sessionId}:`, {
      error: error.message,
      code: error.code,
      retryable: isRetryable
    });
    
    if (!isRetryable) {
      await moveToDLQ(job, error);
      return { status: 'failed', movedToDLQ: true, error: error.message };
    }
    
    throw error;
  }
}

/**
 * Handler: Session Received → Fecha ciclo financeiro
 */
async function handleSessionReceived(payload, correlationId, job) {
  const { sessionId, receivedAmount, receivedAt, receiptNumber } = payload;
  
  if (!sessionId) {
    throw new Error('Missing sessionId in payload');
  }
  
  if (!receivedAmount) {
    throw new Error('Missing receivedAmount in payload');
  }
  
  try {
    const result = await insuranceBillingService.processSessionReceived(
      sessionId,
      { receivedAmount, receivedAt, receiptNumber },
      { correlationId: correlationId || `worker_${job.id}_${uuidv4()}` }
    );
    
    if (result.duplicate) {
      return {
        status: 'success',
        duplicate: true,
        paymentId: result.paymentId,
        status: result.status,
        sessionId
      };
    }
    
    return {
      status: 'success',
      paymentId: result.paymentId,
      status: result.status,
      sessionId
    };
    
  } catch (error) {
    const isRetryable = isRetryableError(error);
    
    console.error(`[BillingWorker] Error processing received ${sessionId}:`, {
      error: error.message,
      code: error.code,
      retryable: isRetryable
    });
    
    if (!isRetryable) {
      await moveToDLQ(job, error);
      return { status: 'failed', movedToDLQ: true, error: error.message };
    }
    
    throw error;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function isRetryableError(error) {
  // Erros que merecem retry
  const retryableCodes = [
    'ECONNREFUSED',      // Redis/DB down temporariamente
    'ETIMEDOUT',         // Timeout
    'LOCK_LOST',         // Lock de guia expirou
    'GUIDE_BUSY',        // Guia bloqueada (pode liberar)
    11000,               // MongoDB duplicate (pode ser race condition)
  ];

  // Erros que NÃO merecem retry (vão direto para DLQ)
  const nonRetryableCodes = [
    'NOT_FOUND',         // Sessão/pagamento não existe
    'NOT_INSURANCE',     // Não é sessão de convênio
    'GUIDE_NOT_FOUND',   // Guia não existe
    'VALIDATION_ERROR',  // Dados inválidos
    'INVALID_STATUS',    // Status não permite operação
  ];

  if (nonRetryableCodes.includes(error.code)) return false;
  if (retryableCodes.includes(error.code)) return true;
  
  // Default: retry se não for erro de validação
  return error.code !== 'VALIDATION_ERROR';
}

async function moveToDLQ(job, error) {
  const dlqQueue = getQueue('billing-dlq');
  
  await dlqQueue.add(
    'failed-job',
    {
      originalJob: job.data,
      error: {
        message: error.message,
        code: error.code,
        stack: error.stack
      },
      failedAt: new Date().toISOString(),
      worker: 'billing-consumer'
    },
    {
      jobId: `dlq_${job.id}_${Date.now()}`
    }
  );

  console.log(`[BillingWorker] Moved job ${job.id} to DLQ`);
}

// =============================================================================
// INICIALIZAÇÃO
// =============================================================================

// Auto-start se estiver em produção
if (process.env.NODE_ENV === 'production' && process.env.ENABLE_BILLING_WORKER === 'true') {
  startBillingConsumerWorker();
}

export default { startBillingConsumerWorker, stopBillingConsumerWorker, getBillingWorkerStatus };
