// workers/invoiceWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Invoice from '../models/Invoice.js';
import Appointment from '../models/Appointment.js';
import EventStore from '../models/EventStore.js';
import { createMonthlyInvoice, createPerSessionInvoice } from '../domain/invoice/index.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { 
  eventExists, 
  processWithGuarantees, 
  appendEvent 
} from '../infrastructure/events/eventStoreService.js';
import { createContextLogger } from '../utils/logger.js';

/**
 * Invoice Worker
 * 
 * Processa jobs relacionados a faturas:
 * - Gera faturas mensais em lote
 * - Gera faturas per-session
 * - Envia lembretes de vencimento
 * 
 * Usa Event Store para idempotência e garantias de processamento
 */

export function startInvoiceWorker() {
  console.log('[InvoiceWorker] 🚀 Iniciando worker');

  const worker = new Worker('invoice-processing', async (job) => {
    // Extrai dados do job (formato do eventPublisher)
    const { 
      eventId, 
      eventType, 
      type, 
      payload, 
      correlationId, 
      idempotencyKey,
      aggregateId 
    } = job.data;
    
    const jobType = type || eventType;
    const log = createContextLogger(correlationId || eventId, 'invoice_worker');

    log.info('job_start', 'Processando job de fatura', {
      jobId: job.id,
      eventId,
      type: jobType,
      correlationId,
      idempotencyKey
    });

    try {
      // 🛡️ IDEMPOTÊNCIA: Verifica se evento já foi processado
      if (idempotencyKey) {
        const alreadyProcessed = await eventExists(idempotencyKey);
        if (alreadyProcessed) {
          log.warn('job_idempotent', 'Job já processado (idempotencyKey)', {
            jobId: job.id,
            idempotencyKey
          });
          return { success: true, idempotent: true, message: 'Already processed' };
        }
      }

      // 🛡️ IDEMPOTÊNCIA: Verifica pelo eventId no Event Store
      if (eventId) {
        const existingEvent = await EventStore.findOne({ eventId });
        if (existingEvent && existingEvent.status === 'processed') {
          log.warn('job_idempotent', 'Job já processado (eventId)', {
            jobId: job.id,
            eventId,
            processedAt: existingEvent.processedAt
          });
          return { success: true, idempotent: true, message: 'Already processed' };
        }
      }

      // Processa de acordo com o tipo
      let result;
      
      switch (jobType) {
        case 'generate_monthly':
        case 'INVOICE_MONTHLY_CREATE_REQUESTED':
          result = await handleGenerateMonthly(payload, log);
          break;

        case 'generate_per_session':
        case 'INVOICE_PER_SESSION_CREATE':
        case 'INVOICE_PER_SESSION_CREATE_REQUESTED':
          result = await handleGeneratePerSession(payload, log);
          break;

        case 'send_reminders':
        case 'INVOICE_REMINDERS_REQUESTED':
          result = await handleSendReminders(payload, log);
          break;

        case 'mark_overdue':
        case 'INVOICE_MARK_OVERDUE_REQUESTED':
          result = await handleMarkOverdue(payload, log);
          break;
        
        default:
          throw new Error(`UNKNOWN_JOB_TYPE: ${jobType}`);
      }

      // 📦 REGISTRA EVENTO DE SUCESSO no Event Store
      if (eventId) {
        await appendEvent({
          eventType: `${jobType}_COMPLETED`,
          aggregateType: 'invoice',
          aggregateId: aggregateId || result?.invoiceId || 'unknown',
          payload: {
            originalEventId: eventId,
            jobType,
            result,
            jobId: job.id
          },
          correlationId: correlationId || eventId,
          metadata: {
            source: 'invoiceWorker',
            workerName: 'invoice_worker'
          }
        });
      }

      log.info('job_complete', 'Job processado com sucesso', {
        jobId: job.id,
        eventId,
        type: jobType
      });

      return result;

    } catch (error) {
      log.error('job_error', 'Erro no job de fatura', {
        jobId: job.id,
        eventId,
        type: jobType,
        error: error.message,
        stack: error.stack
      });

      if (job.attemptsMade >= 3) {
        await moveToDLQ(job, error);
      }
      
      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: 2
  });

  worker.on('completed', (job, result) => {
    console.log(`[InvoiceWorker] Job ${job.id} completado:`, result);
  });

  worker.on('failed', (job, error) => {
    console.error(`[InvoiceWorker] Job ${job?.id} falhou:`, error.message);
  });

  console.log('[InvoiceWorker] Worker iniciado');
  return worker;
}

/**
 * Gera faturas mensais para todos os pacientes com sessões
 */
async function handleGenerateMonthly(payload, log) {
  const { year, month, patientIds = [] } = payload;
  
  log.info('monthly_start', 'Gerando faturas mensais', { year, month });

  const results = {
    generated: 0,
    skipped: 0,
    errors: 0,
    invoices: []
  };

  // Se não passou pacientes específicos, busca todos com sessões no mês
  let targetPatients = patientIds;
  
  if (targetPatients.length === 0) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    
    const appointments = await Appointment.find({
      clinicalStatus: 'completed',
      date: { $gte: startDate, $lte: endDate },
      invoice: { $exists: false }
    }).distinct('patient');
    
    targetPatients = appointments;
  }

  log.info('monthly_patients', 'Pacientes a faturar', { 
    count: targetPatients.length 
  });

  // Gera fatura para cada paciente com garantias de processamento
  for (const patientId of targetPatients) {
    try {
      // Cria idempotencyKey única para cada paciente/mês
      const patientIdempotencyKey = `invoice_monthly_${patientId}_${year}_${month}`;
      
      // Verifica idempotência no Event Store
      const alreadyProcessed = await eventExists(patientIdempotencyKey);
      if (alreadyProcessed) {
        log.info('monthly_patient_idempotent', 'Fatura mensal já processada para paciente', {
          patientId,
          year,
          month
        });
        results.skipped++;
        continue;
      }

      // Processa com garantias
      const result = await processWithGuarantees(
        {
          eventId: patientIdempotencyKey,
          payload: { patientId, year, month }
        },
        async () => {
          return await createMonthlyInvoice({
            patientId,
            year,
            month
          });
        },
        'invoice_worker'
      );

      if (result.success && result.result.success) {
        results.generated++;
        results.invoices.push(result.result.invoice._id);
        
        // Registra evento de criação
        await appendEvent({
          eventType: EventTypes.INVOICE_CREATED,
          aggregateType: 'invoice',
          aggregateId: result.result.invoice._id.toString(),
          payload: {
            invoiceId: result.result.invoice._id,
            invoiceNumber: result.result.invoice.invoiceNumber,
            patientId,
            total: result.result.invoice.total,
            type: 'monthly',
            year,
            month
          },
          idempotencyKey: patientIdempotencyKey,
          metadata: {
            source: 'invoiceWorker',
            action: 'monthly_generation'
          }
        });
        
        log.info('monthly_patient_success', 'Fatura gerada', {
          patientId,
          invoiceId: result.result.invoice._id
        });
      } else {
        results.skipped++;
        log.info('monthly_patient_skipped', 'Paciente pulado', {
          patientId,
          reason: result.result?.reason || 'unknown'
        });
      }
    } catch (error) {
      results.errors++;
      log.error('monthly_patient_error', 'Erro ao gerar fatura', {
        patientId,
        error: error.message
      });
    }
  }

  log.info('monthly_complete', 'Geração mensal completa', results);

  return {
    type: 'monthly_generation',
    ...results
  };
}

/**
 * Gera fatura para uma sessão per-session específica
 */
async function handleGeneratePerSession(payload, log) {
  const { patientId, appointmentId, sessionValue } = payload;
  
  log.info('per_session_start', 'Gerando fatura per-session', {
    patientId,
    appointmentId
  });

  // 🛡️ IDEMPOTÊNCIA: Verifica se já existe invoice para este appointment
  const existingInvoice = await Invoice.findOne({ 
    'items.appointment': appointmentId 
  });
  
  if (existingInvoice) {
    log.info('per_session_idempotent_db', 'Invoice já existe para este appointment', {
      invoiceId: existingInvoice._id,
      appointmentId
    });
    return {
      type: 'per_session_generation',
      invoiceId: existingInvoice._id,
      total: existingInvoice.total,
      idempotent: true
    };
  }

  // 🛡️ IDEMPOTÊNCIA: Verifica no Event Store
  const idempotencyKey = `invoice_per_session_${appointmentId}`;
  const alreadyProcessed = await eventExists(idempotencyKey);
  
  if (alreadyProcessed) {
    log.info('per_session_idempotent_eventstore', 'Invoice per-session já processada', {
      appointmentId,
      idempotencyKey
    });
    return {
      type: 'per_session_generation',
      idempotent: true,
      message: 'Already processed in Event Store'
    };
  }

  // Processa com garantias
  const processResult = await processWithGuarantees(
    {
      eventId: idempotencyKey,
      payload: { patientId, appointmentId, sessionValue }
    },
    async () => {
      return await createPerSessionInvoice({
        patientId,
        appointmentId,
        sessionValue
      });
    },
    'invoice_worker'
  );

  if (!processResult.success) {
    throw processResult.error || new Error('Failed to create per-session invoice');
  }

  const result = processResult.result;

  // Registra evento de criação no Event Store
  await appendEvent({
    eventType: EventTypes.INVOICE_CREATED,
    aggregateType: 'invoice',
    aggregateId: result.invoice._id.toString(),
    payload: {
      invoiceId: result.invoice._id,
      invoiceNumber: result.invoice.invoiceNumber,
      patientId,
      appointmentId,
      total: result.total,
      type: 'per_session'
    },
    idempotencyKey,
    metadata: {
      source: 'invoiceWorker',
      action: 'per_session_generation'
    }
  });

  log.info('per_session_complete', 'Fatura per-session gerada', {
    invoiceId: result.invoice._id,
    total: result.total
  });

  return {
    type: 'per_session_generation',
    invoiceId: result.invoice._id,
    total: result.total
  };
}

/**
 * Envia lembretes de vencimento
 */
async function handleSendReminders(payload, log) {
  const { daysBefore = 3 } = payload;
  
  log.info('reminders_start', 'Enviando lembretes', { daysBefore });

  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + daysBefore);
  
  // Busca faturas que vencem em X dias
  const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
  const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));
  
  const invoices = await Invoice.find({
    dueDate: { $gte: startOfDay, $lte: endOfDay },
    status: { $in: ['sent', 'partial'] },
    remindersSent: { $lt: 3 } // Máximo 3 lembretes
  }).populate('patient', 'name phone email');

  const results = {
    sent: 0,
    errors: 0
  };

  for (const invoice of invoices) {
    try {
      // Idempotência por invoice/reminder
      const reminderIdempotencyKey = `invoice_reminder_${invoice._id}_${daysBefore}d`;
      const alreadySent = await eventExists(reminderIdempotencyKey);
      
      if (alreadySent) {
        log.info('reminder_idempotent', 'Lembrete já enviado', {
          invoiceId: invoice._id,
          daysBefore
        });
        continue;
      }

      // Aqui integraria com serviço de email/WhatsApp
      // await sendReminderEmail(invoice);
      // await sendReminderWhatsApp(invoice);
      
      await processWithGuarantees(
        {
          eventId: reminderIdempotencyKey,
          payload: { invoiceId: invoice._id, daysBefore }
        },
        async () => {
          invoice.remindersSent += 1;
          invoice.lastReminderAt = new Date();
          await invoice.save();
          return { success: true };
        },
        'invoice_worker'
      );

      results.sent++;

      // Registra evento de envio
      await appendEvent({
        eventType: EventTypes.NOTIFICATION_SENT,
        aggregateType: 'invoice',
        aggregateId: invoice._id.toString(),
        payload: {
          invoiceId: invoice._id,
          patientId: invoice.patient._id,
          type: 'reminder',
          daysBefore,
          reminderNumber: invoice.remindersSent
        },
        idempotencyKey: reminderIdempotencyKey,
        metadata: {
          source: 'invoiceWorker',
          action: 'send_reminder'
        }
      });

      log.info('reminder_sent', 'Lembrete enviado', {
        invoiceId: invoice._id,
        patient: invoice.patient.name
      });

    } catch (error) {
      results.errors++;
      log.error('reminder_error', 'Erro ao enviar lembrete', {
        invoiceId: invoice._id,
        error: error.message
      });
    }
  }

  log.info('reminders_complete', 'Lembretes enviados', results);

  return {
    type: 'reminders',
    ...results
  };
}

/**
 * Marca faturas vencidas
 */
async function handleMarkOverdue(payload, log) {
  log.info('overdue_start', 'Marcando faturas vencidas');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await Invoice.updateMany(
    {
      dueDate: { $lt: today },
      status: { $in: ['sent', 'partial'] }
    },
    {
      $set: { status: 'overdue' }
    }
  );

  log.info('overdue_complete', 'Faturas marcadas como vencidas', {
    modified: result.modifiedCount
  });

  // Publica eventos para cada fatura vencida
  const overdueInvoices = await Invoice.find({
    status: 'overdue',
    updatedAt: { $gte: new Date(Date.now() - 60000) } // último minuto
  });

  for (const invoice of overdueInvoices) {
    const idempotencyKey = `invoice_overdue_${invoice._id}`;
    
    // Verifica se já publicou este evento
    const alreadyPublished = await eventExists(idempotencyKey);
    if (alreadyPublished) {
      continue;
    }

    await publishEvent(
      EventTypes.INVOICE_OVERDUE,
      {
        invoiceId: invoice._id.toString(),
        invoiceNumber: invoice.invoiceNumber,
        patientId: invoice.patient.toString(),
        total: invoice.total,
        daysOverdue: invoice.daysOverdue
      },
      {
        idempotencyKey,
        aggregateType: 'invoice',
        aggregateId: invoice._id.toString()
      }
    );
  }

  return {
    type: 'mark_overdue',
    marked: result.modifiedCount
  };
}

// Exporta handlers para testes
export const handlers = {
  handleGenerateMonthly,
  handleGeneratePerSession,
  handleSendReminders,
  handleMarkOverdue
};
