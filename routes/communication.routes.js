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
import { sendCommunication } from '../services/communication/CommunicationService.js';
import CommunicationEmailLog from '../models/CommunicationEmailLog.js';
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
//
// Entrega a comunicação pelo canal configurado (email, external, portal...).
// A escolha do canal vem de `deliveryMethod` no payload; se omitido, usa o valor
// persistido na InsuranceCommunication (default: email).
//
// O orquestrador CommunicationService coordena o estado e delega a execução ao
// DeliveryProvider apropriado. Para e-mail, o provider enfileira um job BullMQ;
// para external, a entrega é síncrona e já marca a comunicação como sent.
router.post('/:id/send', auth, async (req, res) => {
  const communicationId = req.params.id;
  logger.info('send_endpoint_entered', `Endpoint /send chamado para ${communicationId}`, { communicationId });

  try {
    const {
      to,
      subject,
      message,
      template,
      sendType,
      reason,
      deliveryMethod
    } = req.body;

    const result = await sendCommunication(communicationId, {
      to,
      subject,
      message,
      template,
      sendType,
      reason,
      deliveryMethod,
      userId: req.user.id,
      ip: req.ip
    });

    if (result.status === 'queued') {
      res.json({
        success: true,
        data: {
          jobId: result.jobId,
          status: 'queued',
          message: 'Comunicação enfileirada para envio'
        }
      });
    } else if (result.status === 'sent') {
      res.json({
        success: true,
        data: {
          logId: result.log?._id,
          status: 'sent',
          message: 'Comunicação registrada como enviada'
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Resultado inesperado do provider de entrega'
      });
    }
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

// POST /api/v2/communications/webhooks/resend
// Webhook da Resend para atualizar o Message-ID real do e-mail quando ele sai de
// 'queued' (evento email.sent). Sem isso não conseguimos fazer thread de conversa
// nos reenvios/complementos, pois o message_id só é disponibilizado pela Resend
// após o envio efetivo.
router.post('/webhooks/resend', async (req, res) => {
  try {
    const { type, data } = req.body || {};

    logger.info('resend_webhook_received', 'Webhook Resend recebido', {
      type,
      hasData: !!data,
      emailId: data?.email_id,
      hasMessageId: !!data?.message_id,
      headerNames: Array.isArray(data?.headers) ? data.headers.map(h => h.name) : []
    });

    if (type === 'email.sent' && data?.email_id && data?.message_id) {
      // 1ª tentativa: pelo protocol (email_id). Pode falhar se o webhook chegar
      // antes do job completar e persistir o log.
      let updated = await CommunicationEmailLog.findOneAndUpdate(
        { protocol: data.email_id },
        { $set: { messageId: data.message_id } },
        { new: true }
      ).lean();

      logger.info('resend_webhook_protocol_lookup', 'Busca por protocol', {
        emailId: data.email_id,
        found: !!updated
      });

      // 2ª tentativa: pelo header X-Entity-Ref-ID, que é o jobId salvo no log
      // PENDING antes do envio. Isso cobre a race condition webhook vs. job.
      if (!updated && Array.isArray(data.headers)) {
        const refHeader = data.headers.find(h => h.name === 'X-Entity-Ref-ID');
        const jobId = refHeader?.value;
        if (jobId) {
          updated = await CommunicationEmailLog.findOneAndUpdate(
            { jobId },
            { $set: { messageId: data.message_id } },
            { new: true }
          ).lean();

          logger.info('resend_webhook_jobid_lookup', 'Busca por jobId', {
            jobId,
            found: !!updated
          });
        }
      }

      if (updated) {
        logger.info('resend_webhook_message_id_updated', `Message-ID atualizado para log ${updated._id}`, {
          logId: updated._id,
          communicationId: updated.communicationId,
          emailId: data.email_id,
          messageId: data.message_id
        });
      } else {
        logger.warn('resend_webhook_log_not_found', `Log não encontrado para email_id ${data.email_id}`, {
          emailId: data.email_id,
          messageId: data.message_id
        });
      }
    }

    // Sempre retorna 200 para a Resend não reenviar o webhook.
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[CommunicationRoutes] Resend webhook:', error);
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
