// routes/communication.routes.js
import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  createCommunicationRequest,
  listCommunicationRequests,
  getCommunicationRequest,
  updateCommunicationStatus,
  getCommunicationsByPatient
} from '../services/communication/CommunicationRequestService.js';
import {
  setPackageDocuments,
  getPackageByCommunicationId
} from '../services/communication/CommunicationPackageService.js';
import {
  getEmailLogs,
  listCommunicationEmailLogs
} from '../services/communication/CommunicationEmailService.js';
import { EmailLogType } from '../models/CommunicationEmailLog.js';
import { getQueue } from '../infrastructure/queue/queueConfig.js';
import { transition, CommunicationEvents } from '../services/communication/CommunicationStateMachine.js';
import { getRulesForInsurance, updateRulesForInsurance } from '../services/communication/InsuranceRuleService.js';
import { createContextLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createContextLogger('communication_send_endpoint');

// GET /api/v2/communications
router.get('/', auth, async (req, res) => {
  try {
    const { status, insurance, patientId, purpose, month, page, limit } = req.query;
    const result = await listCommunicationRequests({
      status,
      insuranceProvider: insurance,
      patientId,
      purpose,
      month,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50
    });
    res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (error) {
    console.error('[CommunicationRoutes] list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v2/communications/email-logs — precisa vir ANTES de GET /:id, senão
// Express casa "email-logs" como valor do param :id.
router.get('/email-logs', auth, async (req, res) => {
  try {
    const { purpose, insurance, patientId, page, limit } = req.query;
    const result = await listCommunicationEmailLogs({
      purpose,
      insuranceProvider: insurance,
      patientId,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 100
    });
    res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (error) {
    console.error('[CommunicationRoutes] email-logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/v2/communications
router.post('/', auth, async (req, res) => {
  try {
    const { patientId, insuranceProvider, guideId, purpose, specialty, requestedSessions, notes, invoiceNumber, invoiceDate } = req.body;
    const request = await createCommunicationRequest({
      patientId,
      insuranceProvider,
      guideId,
      purpose,
      specialty,
      requestedSessions,
      notes,
      invoiceNumber,
      invoiceDate,
      userId: req.user.id
    });
    res.status(201).json({ success: true, data: request });
  } catch (error) {
    console.error('[CommunicationRoutes] create:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v2/communications/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const request = await getCommunicationRequest(req.params.id);
    const pkg = await getPackageByCommunicationId(req.params.id);
    const emailLogs = await getEmailLogs(req.params.id);
    res.json({ success: true, data: { ...request, package: pkg, emailLogs } });
  } catch (error) {
    console.error('[CommunicationRoutes] get:', error);
    res.status(error.message.includes('não encontrada') ? 404 : 500).json({ success: false, error: error.message });
  }
});

// PATCH /api/v2/communications/:id/status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const request = await updateCommunicationStatus(req.params.id, status);
    res.json({ success: true, data: request });
  } catch (error) {
    console.error('[CommunicationRoutes] status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/v2/communications/:id/package
router.post('/:id/package', auth, async (req, res) => {
  try {
    const { documentIds } = req.body;
    const pkg = await setPackageDocuments({
      communicationId: req.params.id,
      documentIds,
      userId: req.user.id
    });
    res.json({ success: true, data: pkg });
  } catch (error) {
    console.error('[CommunicationRoutes] package:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/v2/communications/:id/send
router.post('/:id/send', auth, async (req, res) => {
  const communicationId = req.params.id;
  logger.info('send_endpoint_entered', `Endpoint /send chamado para ${communicationId}`, { communicationId });

  try {
    const { to, subject, message, template, sendType, reason } = req.body;

    const communication = await getCommunicationRequest(communicationId);

    // Comunicação já em sent/approved: isto é reenvio ou complemento, não o 1º envio —
    // pular a máquina de estados por completo (sent/approved não têm transição SEND;
    // ver CommunicationEmailService.sendCommunicationEmail pro mesmo guard no worker).
    const alreadySent = ['sent', 'approved'].includes(communication.status);

    if (!alreadySent) {
      // Se ainda estiver em rascunho, marca como pronta antes de enviar
      if (communication.status === 'draft') {
        await transition(communicationId, CommunicationEvents.MARK_READY);
      }

      // Transiciona para SENDING antes de enfileirar
      await transition(communicationId, CommunicationEvents.SEND);
    }

    let job;
    try {
      const queue = getQueue('communication-email');
      logger.info('queue_add_started', `Enfileirando job de e-mail para ${communicationId}`, { communicationId });

      job = await queue.add(
        'send-communication-email',
        {
          communicationId,
          to,
          subject,
          message,
          template,
          sendType: sendType || (alreadySent ? EmailLogType.RESEND : undefined),
          reason: reason || undefined,
          ip: req.ip,
          userId: req.user.id
        },
        {
          jobId: `communication-email-${communicationId}-${Date.now()}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 3000 }
        }
      );

      logger.info('queue_add_completed', `Job ${job.id} enfileirado para ${communicationId}`, { communicationId, jobId: job.id });
    } catch (enqueueError) {
      // O enfileiramento falhou DEPOIS que o status já virou SENDING — sem isso,
      // a comunicação fica presa em "sending" pra sempre, sem job e sem log,
      // porque nada mais nesse fluxo teria como reverter esse status (achado
      // em produção em 2026-07-27: 3 comunicações órfãs em "sending" sem
      // nenhum job correspondente no Redis, ver InsuranceCommunication/back's
      // finance-integrity-audit da época).
      logger.error('queue_add_failed', `Falha ao enfileirar job para ${communicationId}: ${enqueueError.message}`, {
        communicationId,
        error: enqueueError.message
      });

      // Só reverte status se este ciclo chegou a mudá-lo (ver guard acima) — reenvio/
      // complemento nunca saem de sent/approved, e FAIL não é transição válida daí.
      if (!alreadySent) {
        await transition(communicationId, CommunicationEvents.FAIL, {
          statusReason: `Falha ao enfileirar envio: ${enqueueError.message}`
        });
      }

      throw enqueueError;
    }

    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: 'queued',
        message: 'Comunicação enfileirada para envio'
      }
    });
  } catch (error) {
    console.error('[CommunicationRoutes] send:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v2/communications/patient/:patientId
router.get('/patient/:patientId', auth, async (req, res) => {
  try {
    const data = await getCommunicationsByPatient(req.params.patientId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[CommunicationRoutes] patient:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v2/communications/insurance/:insurance/rules
router.get('/insurance/:insurance/rules', auth, async (req, res) => {
  try {
    const { purpose } = req.query;
    const rules = await getRulesForInsurance(req.params.insurance, purpose || 'authorization');
    res.json({ success: true, data: rules });
  } catch (error) {
    console.error('[CommunicationRoutes] rules:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/v2/communications/insurance/:insurance/rules
router.patch('/insurance/:insurance/rules', auth, async (req, res) => {
  try {
    const { purpose } = req.query;
    const rules = await updateRulesForInsurance(req.params.insurance, purpose || 'authorization', req.body);
    res.json({ success: true, data: rules });
  } catch (error) {
    console.error('[CommunicationRoutes] update rules:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v2/communications/:id/job/:jobId/status
router.get('/:id/job/:jobId/status', auth, async (req, res) => {
  try {
    const queue = getQueue('communication-email');
    const job = await queue.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job não encontrado' });
    }

    const state = await job.getState();
    const failedReason = job.failedReason || null;
    const attemptsMade = job.attemptsMade || 0;

    res.json({
      success: true,
      data: {
        jobId: job.id,
        state,
        attemptsMade,
        failedReason,
        updatedAt: job.processedOn || job.finishedOn || job.timestamp
      }
    });
  } catch (error) {
    console.error('[CommunicationRoutes] job status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
