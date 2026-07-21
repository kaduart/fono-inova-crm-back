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
  getEmailLogs
} from '../services/communication/CommunicationEmailService.js';
import { getQueue } from '../infrastructure/queue/queueConfig.js';
import { transition, CommunicationEvents } from '../services/communication/CommunicationStateMachine.js';
import { getRulesForInsurance, updateRulesForInsurance } from '../services/communication/InsuranceRuleService.js';

const router = express.Router();

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

// POST /api/v2/communications
router.post('/', auth, async (req, res) => {
  try {
    const { patientId, insuranceProvider, guideId, purpose, specialty, requestedSessions, notes } = req.body;
    const request = await createCommunicationRequest({
      patientId,
      insuranceProvider,
      guideId,
      purpose,
      specialty,
      requestedSessions,
      notes,
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
  try {
    const { to, subject, message, template } = req.body;

    const communication = await getCommunicationRequest(req.params.id);

    // Se ainda estiver em rascunho, marca como pronta antes de enviar
    if (communication.status === 'draft') {
      await transition(req.params.id, CommunicationEvents.MARK_READY);
    }

    // Transiciona para SENDING antes de enfileirar
    await transition(req.params.id, CommunicationEvents.SEND);

    const queue = getQueue('communication-email');
    const job = await queue.add(
      'send-communication-email',
      {
        communicationId: req.params.id,
        to,
        subject,
        message,
        template,
        userId: req.user.id
      },
      {
        jobId: `communication-email-${req.params.id}-${Date.now()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 }
      }
    );
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
