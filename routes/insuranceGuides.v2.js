/**
 * Insurance Guides V2 - Event-Driven
 * 
 * Rotas para criação e gerenciamento de guias de convênio
 * usando o padrão event-driven (event-store + outbox)
 */
import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import InsuranceGuideView from '../models/InsuranceGuideView.js';
import { v4 as uuidv4 } from 'uuid';
import { resolvePatientId } from '../utils/identityResolver.js';

const router = express.Router();

// Constantes de validação
const VALID_SPECIALTIES = [
  'fonoaudiologia',
  'psicologia', 
  'fisioterapia',
  'psicomotricidade',
  'terapia_ocupacional',
  'musicoterapia',
  'psicopedagogia'
];

const VALID_INSURANCES = [
  'unimed-anapolis',
  'unimed-goiania',
  'unimed',
  'bradesco-saude',
  'amil',
  'sulamerica',
  'outro'
];

/**
 * POST /api/v2/insurance-guides
 * Cria uma nova guia de convênio (Event-Driven)
 */
router.post('/', auth, async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  
  try {
    const {
      number,
      patientId,
      specialty,
      insurance,
      totalSessions,
      expiresAt,
      valor,
      notes
    } = req.body;

    // Validações
    if (!number || !patientId || !specialty || !insurance || !totalSessions || !expiresAt) {
      return res.status(400).json({
        success: false,
        errorCode: 'VALIDATION_ERROR',
        message: 'Campos obrigatórios: number, patientId, specialty, insurance, totalSessions, expiresAt',
        correlationId
      });
    }

    if (!VALID_SPECIALTIES.includes(specialty)) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_SPECIALTY',
        message: `Especialidade inválida. Válidas: ${VALID_SPECIALTIES.join(', ')}`,
        correlationId
      });
    }

    // Cria a guia
    const guideData = {
      number,
      patientId: patientId.toString(),
      specialty,
      insurance: insurance.toLowerCase().replace(' ', '-'),
      totalSessions: parseInt(totalSessions),
      sessionsUsed: 0,
      sessionsRemaining: parseInt(totalSessions),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      valor: valor || 0,
      notes,
      status: 'active',
      createdBy: req.user?.id,
      correlationId,
      metadata: {
        createdAt: new Date(),
        source: 'api-v2',
        idempotencyKey: req.headers['x-idempotency-key'] || uuidv4()
      }
    };

    const guide = await InsuranceGuide.create(guideData);

    // Publica evento (async)
    try {
      const { publishEvent } = await import('../infrastructure/events/eventPublisher.js');
      await publishEvent('INSURANCE_GUIDE_CREATED', {
        guideId: guide._id.toString(),
        patientId,
        number,
        insurance,
        totalSessions,
        correlationId,
        createdAt: new Date().toISOString()
      }, { correlationId });
    } catch (eventError) {
      console.warn('[InsuranceGuidesV2] Evento falhou (não crítico):', eventError.message);
    }

    // Retorna no formato V2
    res.status(201).json({
      success: true,
      data: {
        _id: guide._id.toString(),
        guideId: guide._id.toString(),
        number: guide.number,
        patientId: guide.patientId,
        specialty: guide.specialty,
        insurance: guide.insurance,
        totalSessions: guide.totalSessions,
        sessionsUsed: guide.sessionsUsed,
        sessionsRemaining: guide.sessionsRemaining,
        status: guide.status,
        expiresAt: guide.expiresAt,
        valor: guide.valor,
        correlationId
      },
      meta: {
        version: '2.0',
        eventDriven: true,
        correlationId
      }
    });

  } catch (error) {
    console.error('[InsuranceGuidesV2] Erro:', error);
    
    // Duplicado (número único)
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        errorCode: 'DUPLICATE_GUIDE_NUMBER',
        message: 'Número da guia já existe',
        correlationId
      });
    }

    res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: error.message,
      correlationId
    });
  }
});

/**
 * GET /api/v2/insurance-guides
 * Lista guias com filtros
 */
router.get('/', auth, async (req, res) => {
  try {
    const { patientId, insurance, status, limit = 20, page = 1 } = req.query;
    
    const query = {};
    
    // 🔑 V2: Resolve patientId (aceita patientId real ou _id da view)
    if (patientId) {
      try {
        const resolvedId = await resolvePatientId(patientId, { 
          correlationId: req.headers['x-correlation-id'] || `ig_${Date.now()}`
        });
        query.patientId = new mongoose.Types.ObjectId(resolvedId);
      } catch (error) {
        return res.status(400).json({
          success: false,
          errorCode: 'INVALID_PATIENT_ID',
          message: error.message
        });
      }
    }
    if (insurance) query.insurance = insurance.toLowerCase();
    if (status) query.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [guides, total] = await Promise.all([
      InsuranceGuide.find(query)
        .populate('patientId', 'fullName cpf')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      InsuranceGuide.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        guides: guides.map(g => ({
          _id: g._id.toString(),
          guideId: g._id.toString(),
          number: g.number,
          patientId: g.patientId,
          insurance: g.insurance,
          specialty: g.specialty,
          totalSessions: g.totalSessions,
          sessionsUsed: g.sessionsUsed,
          sessionsRemaining: g.sessionsRemaining,
          status: g.status,
          expiresAt: g.expiresAt
        })),
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit))
        }
      },
      meta: { version: '2.0' }
    });

  } catch (error) {
    console.error('[InsuranceGuidesV2] Erro ao listar:', error);
    res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * GET /api/v2/insurance-guides/:id
 * Busca guia por ID
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_ID',
        message: 'ID inválido'
      });
    }

    const guide = await InsuranceGuide.findById(id).lean();
    
    if (!guide) {
      return res.status(404).json({
        success: false,
        errorCode: 'NOT_FOUND',
        message: 'Guia não encontrada'
      });
    }

    res.json({
      success: true,
      data: {
        _id: guide._id.toString(),
        guideId: guide._id.toString(),
        number: guide.number,
        patientId: guide.patientId,
        insurance: guide.insurance,
        specialty: guide.specialty,
        totalSessions: guide.totalSessions,
        sessionsUsed: guide.sessionsUsed,
        sessionsRemaining: guide.sessionsRemaining,
        status: guide.status,
        expiresAt: guide.expiresAt,
        valor: guide.valor,
        notes: guide.notes
      },
      meta: { version: '2.0' }
    });

  } catch (error) {
    console.error('[InsuranceGuidesV2] Erro ao buscar:', error);
    res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * GET /api/v2/insurance-guides/patient/:patientId/balance
 * Retorna saldo de guias ativas do paciente (V2 com identity resolution)
 */
router.get('/patient/:patientId/balance', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { specialty } = req.query;
    const correlationId = req.headers['x-correlation-id'] || `igb_${Date.now()}`;

    // 🔑 V2: Resolve patientId (aceita patientId real ou _id da view)
    let resolvedPatientId;
    try {
      resolvedPatientId = await resolvePatientId(patientId, { correlationId });
    } catch (error) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_PATIENT_ID',
        message: error.message,
        correlationId
      });
    }

    // Usar método estático do model
    const balance = await InsuranceGuide.getBalance(resolvedPatientId, specialty);

    return res.status(200).json({
      success: true,
      data: balance,
      meta: { version: '2.0', correlationId }
    });

  } catch (error) {
    console.error('[InsuranceGuidesV2] Erro ao consultar saldo:', error);
    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

export default router;
