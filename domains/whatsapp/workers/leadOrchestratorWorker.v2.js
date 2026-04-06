/**
 * ============================================================================
 * LEAD ORCHESTRATOR WORKER V2
 * ============================================================================
 *
 * Reage a eventos clínicos e financeiros para enviar WhatsApp inteligente.
 *
 * Diferença do V1:
 *   V1 → processa LEAD_CREATED / LEAD_UPDATED (captação de novos leads)
 *   V2 → processa APPOINTMENT_COMPLETED / PAYMENT_COMPLETED (ciclo clínico)
 *
 * Duas categorias de mensagem:
 *
 *   TRANSACIONAL  → NOTIFICATION_REQUESTED (imediato, não suprimido por stage)
 *     ex: confirmação de pagamento, lembrete de retorno
 *
 *   MARKETING     → FOLLOWUP_REQUESTED (via followupOrchestratorWorker, respeitando
 *     regras de supressão, manual control, etc.)
 *     ex: "como foi a sessão de hoje?" (24h depois)
 *
 * Regras de supressão:
 *   - Lead não encontrado via appointment.lead → ok, usa notificação direta ao paciente
 *   - lead.manualControl.active === true → não agenda follow-up (não interfere em transacional)
 * ============================================================================
 */

import { Worker } from 'bullmq';
import { publishEvent, EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import Appointment from '../../../models/Appointment.js';
import Followup    from '../../../models/Followup.js';
import Patient     from '../../../models/Patient.js';
import { v4 as uuidv4 } from 'uuid';
import { bullMqConnection as redisConnection } from '../../../config/redisConnection.js';

// =============================================================================
// CONFIGURAÇÃO
// =============================================================================

const QUEUE_NAME = 'lead-orchestrator-v2';

const WORKER_CONFIG = {
    concurrency: 3,
    lockDuration: 30000,
    stalledInterval: 30000,
    maxStalledCount: 2,
};

// Delay do follow-up pós-sessão (24h em ms)
const POST_SESSION_FOLLOWUP_DELAY_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// HANDLERS TABLE
// =============================================================================

const HANDLERS = {
    APPOINTMENT_COMPLETED: handleAppointmentCompleted,
    PAYMENT_COMPLETED:     handlePaymentCompleted,
};

// =============================================================================
// WORKER
// =============================================================================

let worker = null;

export function startLeadOrchestratorWorkerV2() {
    if (worker) {
        console.warn('[LeadOrchestratorV2] Already started');
        return worker;
    }

    worker = new Worker(QUEUE_NAME, processJob, {
        connection: redisConnection,
        ...WORKER_CONFIG,
    });

    worker.on('completed', (job, result) => {
        if (result?.skipped) return;
        console.log(`[LeadOrchestratorV2] Completed: ${job.id}`, {
            eventType: job.data.eventType,
            action:    result?.action,
        });
    });

    worker.on('failed', (job, err) => {
        console.error(`[LeadOrchestratorV2] Failed: ${job?.id}`, {
            eventType: job?.data?.eventType,
            error:     err.message,
        });
    });

    worker.on('error', (err) => {
        console.error('[LeadOrchestratorV2] Worker error:', err);
    });

    console.log('[LeadOrchestratorV2] Started successfully');
    return worker;
}

export function stopLeadOrchestratorWorkerV2() {
    if (worker) {
        worker.close();
        worker = null;
    }
}

// =============================================================================
// PROCESSOR
// =============================================================================

async function processJob(job) {
    const { eventType, correlationId, payload } = job.data;

    const handler = HANDLERS[eventType];
    if (!handler) {
        return { skipped: true, reason: 'NO_HANDLER', eventType };
    }

    return handler(payload, correlationId, job);
}

// =============================================================================
// APPOINTMENT_COMPLETED → follow-up 24h depois
// "Como foi a sessão de hoje?"
// =============================================================================

async function handleAppointmentCompleted(payload, correlationId) {
    const { appointmentId, patientId } = payload;

    if (!appointmentId) {
        return { skipped: true, reason: 'NO_APPOINTMENT_ID' };
    }

    // Busca appointment para pegar o lead vinculado
    const appointment = await Appointment.findById(appointmentId)
        .select('lead patient billingType operationalStatus')
        .lean();

    if (!appointment) {
        return { skipped: true, reason: 'APPOINTMENT_NOT_FOUND', appointmentId };
    }

    // Sem lead vinculado → nada a fazer aqui (paciente sem origem de lead)
    if (!appointment.lead) {
        return { skipped: true, reason: 'NO_LEAD_ON_APPOINTMENT', appointmentId };
    }

    const leadId = appointment.lead.toString();

    // Importa Lead dynamically para não criar dependência circular com V1
    const { default: Lead } = await import('../../../models/Leads.js');
    const lead = await Lead.findById(leadId).select('manualControl stage name contact').lean();

    if (!lead) {
        return { skipped: true, reason: 'LEAD_NOT_FOUND', leadId };
    }

    // Respeita controle manual — não agenda follow-up automático
    if (lead.manualControl?.active) {
        return { skipped: true, reason: 'MANUAL_CONTROL_ACTIVE', leadId };
    }

    // Cria Followup agendado para 24h depois
    const scheduledAt = new Date(Date.now() + POST_SESSION_FOLLOWUP_DELAY_MS);

    const followup = await Followup.create({
        lead:         leadId,
        stage:        'follow_up',
        scheduledAt,
        status:       'scheduled',
        origin:       'appointment_completed',
        playbook:     'post_session_24h',
        leadName:     lead.name || null,
        leadPhoneE164: lead.contact?.phone || null,
        note:         `Pós sessão — appointment ${appointmentId}`,
    });

    // Publica FOLLOWUP_REQUESTED com delay correto
    await publishEvent(
        EventTypes.FOLLOWUP_REQUESTED,
        {
            followupId:  followup._id.toString(),
            leadId,
            scheduledAt: scheduledAt.toISOString(),
            stage:       'follow_up',
            attempt:     1,
        },
        {
            correlationId: correlationId || uuidv4(),
            aggregateType: 'lead',
            aggregateId:   leadId,
            delay:         POST_SESSION_FOLLOWUP_DELAY_MS,
            metadata:      { source: 'lead-orchestrator-v2', trigger: 'appointment_completed' },
        }
    );

    return {
        action:      'scheduled_post_session_followup',
        followupId:  followup._id.toString(),
        leadId,
        scheduledAt: scheduledAt.toISOString(),
    };
}

// =============================================================================
// PAYMENT_COMPLETED → confirmação imediata (transacional)
// "Pagamento confirmado! ✅"
// =============================================================================

async function handlePaymentCompleted(payload, correlationId) {
    const { patientId, appointmentId, amount, paymentMethod } = payload;

    if (!patientId) {
        return { skipped: true, reason: 'NO_PATIENT_ID' };
    }

    // Busca phone do paciente
    const patient = await Patient.findById(patientId)
        .select('contact phone fullName')
        .lean();

    if (!patient) {
        return { skipped: true, reason: 'PATIENT_NOT_FOUND', patientId };
    }

    const phone = patient.contact?.phone || patient.phone;
    if (!phone) {
        return { skipped: true, reason: 'NO_PHONE', patientId };
    }

    const name = patient.fullName?.split(' ')[0] || 'você';

    // Monta mensagem transacional
    const message = buildPaymentConfirmationMessage({ name, amount, paymentMethod });

    // Publica NOTIFICATION_REQUESTED — não passa por supressão de lead
    await publishEvent(
        EventTypes.NOTIFICATION_REQUESTED,
        {
            channel:   'whatsapp',
            to:        phone,
            content:   message,
            template:  'payment_confirmation',
            patientId: patientId.toString(),
            metadata:  { appointmentId, source: 'lead-orchestrator-v2' },
        },
        {
            correlationId: correlationId || uuidv4(),
            aggregateType: 'patient',
            aggregateId:   patientId,
            metadata:      { source: 'lead-orchestrator-v2', trigger: 'payment_completed' },
        }
    );

    return {
        action:    'sent_payment_confirmation',
        patientId,
        phone,
    };
}

// =============================================================================
// HELPERS
// =============================================================================

function buildPaymentConfirmationMessage({ name, amount, paymentMethod }) {
    const methodLabel = {
        pix:               'Pix',
        dinheiro:          'dinheiro',
        cartao_credito:    'cartão de crédito',
        cartao_debito:     'cartão de débito',
        transferencia_bancaria: 'transferência',
    }[paymentMethod] || paymentMethod;

    const amountStr = amount
        ? `R$ ${Number(amount).toFixed(2).replace('.', ',')}`
        : null;

    if (amountStr) {
        return `Olá, ${name}! ✅ Recebemos seu pagamento de ${amountStr} via ${methodLabel}. Obrigado!`;
    }
    return `Olá, ${name}! ✅ Pagamento confirmado. Obrigado!`;
}
