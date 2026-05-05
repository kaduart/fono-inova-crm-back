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
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import InsurancePlan from '../models/InsurancePlan.js';
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
          number: g.number,
          patientId: g.patientId?._id?.toString?.() || g.patientId?.toString?.() || g.patientId,
          insurance: g.insurance,
          specialty: g.specialty,
          totalSessions: g.totalSessions,
          usedSessions: g.usedSessions || 0,
          remaining: Math.max(0, (g.totalSessions || 0) - (g.usedSessions || 0)),
          status: g.status,
          expiresAt: g.expiresAt,
          createdAt: g.createdAt
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
        usedSessions: guide.usedSessions || 0,
        sessionsRemaining: (guide.totalSessions || 0) - (guide.usedSessions || 0),
        status: guide.status,
        expiresAt: guide.expiresAt,
        valor: guide.valor,
        notes: guide.notes,
        createdAt: guide.createdAt
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

/**
 * DELETE /api/v2/insurance-guides/:id
 * Cancela guia (soft delete)
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const guide = await InsuranceGuide.findById(id);
    if (!guide) {
      return res.status(404).json({
        success: false,
        errorCode: 'NOT_FOUND',
        message: 'Guia não encontrada'
      });
    }

    if (guide.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        errorCode: 'ALREADY_CANCELLED',
        message: 'Esta guia já está cancelada'
      });
    }

    guide.status = 'cancelled';
    await guide.save();

    return res.status(200).json({
      success: true,
      message: 'Guia cancelada com sucesso',
      data: {
        id: guide._id,
        number: guide.number,
        status: guide.status
      }
    });

  } catch (error) {
    console.error('[InsuranceGuidesV2] Erro ao cancelar guia:', error);
    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Erro ao cancelar guia. Tente novamente em alguns instantes.'
    });
  }
});

/**
 * GET /api/v2/insurance-guides/:id/appointments
 * Retorna todos os agendamentos atrelados a uma guia (usado pela secretaria).
 * Cobre dois caminhos:
 *   1. Appointment.insuranceGuide = guideId (criados via appointment.v2)
 *   2. Appointment.package em pacotes convênio cujo Package.insuranceGuide = guideId
 */
router.get('/:id/appointments', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_ID', message: 'ID inválido' });
    }

    const guideObjId = new mongoose.Types.ObjectId(id);

    // Busca a guia para obter o patientId (necessário para fallback legado)
    const guide = await InsuranceGuide.findById(guideObjId).select('patientId').lean();
    if (!guide) {
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Guia não encontrada' });
    }

    // Caminho 1: appointments com insuranceGuide direto
    // Caminho 2: appointments via pacotes convênio linkados a esta guia
    const linkedPackages = await Package.find({ insuranceGuide: guideObjId }).select('_id').lean();
    const packageIds = linkedPackages.map(p => p._id);

    const query = packageIds.length > 0
      ? { $or: [{ insuranceGuide: guideObjId }, { package: { $in: packageIds } }] }
      : { insuranceGuide: guideObjId };

    let appointments = await Appointment.find(query)
      .select('date time status operationalStatus serviceType sessionType notes doctor professionalName createdAt')
      .populate('doctor', 'fullName')
      .sort({ date: -1 })
      .lean();

    // Caminho 3 — fallback legado: pacotes convênio do paciente sem insuranceGuide vinculado
    // (dados criados antes do campo existir no schema)
    let isLegacyFallback = false;
    if (appointments.length === 0) {
      const legacyPackages = await Package.find({
        patient: guide.patientId,
        type: 'convenio',
        $or: [{ insuranceGuide: null }, { insuranceGuide: { $exists: false } }]
      }).select('_id').lean();

      if (legacyPackages.length > 0) {
        const legacyPackageIds = legacyPackages.map(p => p._id);
        appointments = await Appointment.find({ package: { $in: legacyPackageIds } })
          .select('date time status operationalStatus serviceType sessionType notes doctor professionalName createdAt')
          .populate('doctor', 'fullName')
          .sort({ date: -1 })
          .lean();
        if (appointments.length > 0) isLegacyFallback = true;
      }
    }

    return res.json({
      success: true,
      data: { appointments, total: appointments.length, isLegacyFallback },
      meta: { version: '2.0' }
    });

  } catch (error) {
    console.error('[InsuranceGuidesV2] Erro ao buscar agendamentos da guia:', error);
    return res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * POST /api/v2/insurance-guides/:id/inactivate
 * Inativa guia de convênio: cancela pendências, mantém histórico.
 * Mesmo padrão do pacote (POST /v2/packages/:id/inactivate).
 */
router.post('/:id/inactivate', auth, async (req, res) => {
  const correlationId = `ig_inactivate_${Date.now()}`;
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_ID', message: 'ID inválido' });
    }

    const guideObjId = new mongoose.Types.ObjectId(id);

    const guide = await InsuranceGuide.findById(guideObjId).lean();
    if (!guide) {
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Guia não encontrada' });
    }
    if (guide.status === 'cancelled') {
      return res.status(400).json({ success: false, errorCode: 'ALREADY_CANCELLED', message: 'Guia já está inativa' });
    }

    const pendingStatuses = ['scheduled', 'pending', 'unpaid', 'booked'];
    const today = new Date().toISOString().split('T')[0];

    // ── 1. Packages vinculados à guia ──
    const linkedPackages = await Package.find({ insuranceGuide: guideObjId }).select('_id').lean();
    const packageIds = linkedPackages.map(p => p._id);

    // Monta query de $or para guia direta + packages vinculados
    const guideOrPackageQuery = [
      { insuranceGuide: guideObjId },
      ...(packageIds.length > 0 ? [{ package: { $in: packageIds } }] : [])
    ];

    // ── 2. Deleta appointments futuros + sessions/payments vinculados ──
    // Busca IDs primeiro para deletar filhos de forma consistente
    const apptsToDelete = await Appointment.find({
      $or: guideOrPackageQuery,
      operationalStatus: { $nin: ['completed', 'canceled', 'cancelled'] },
      date: { $gte: today }
    }).select('_id').lean();
    const apptIdsToDelete = apptsToDelete.map(a => a._id);

    if (apptIdsToDelete.length > 0) {
      await Session.deleteMany({ appointment: { $in: apptIdsToDelete } });
      await Payment.deleteMany({ appointment: { $in: apptIdsToDelete } });
    }
    const appointmentsDeletedResult = await Appointment.deleteMany({ _id: { $in: apptIdsToDelete } });

    // ── 3. Cancela sessions pendentes diretamente ──
    const sessionsResult = await Session.updateMany(
      {
        $or: guideOrPackageQuery,
        status: { $in: pendingStatuses }
      },
      { status: 'canceled', updatedAt: new Date() }
    );

    // ── 4. Cancela payments pendentes ──
    const paymentsResult = await Payment.updateMany(
      {
        $or: guideOrPackageQuery,
        status: { $in: ['pending', 'scheduled', 'unpaid'] }
      },
      { status: 'canceled', updatedAt: new Date() }
    );

    // ── 5. Cancela InsurancePlan e DELETA seus appointments/sessions/payments futuros ──
    let planCanceled = false;
    let planAppointmentsDeleted = 0;
    const linkedPlan = await InsurancePlan.findOne({ guide: guideObjId }).lean();
    if (linkedPlan) {
      const planApptsToDelete = await Appointment.find({
        insurancePlan: linkedPlan._id, date: { $gte: today }, operationalStatus: 'scheduled'
      }).select('_id').lean();
      const planApptIds = planApptsToDelete.map(a => a._id);

      if (planApptIds.length > 0) {
        await Session.deleteMany({ appointment: { $in: planApptIds } });
        await Payment.deleteMany({ appointment: { $in: planApptIds } });
      }
      const planApptResult = await Appointment.deleteMany({ _id: { $in: planApptIds } });

      await Payment.updateMany(
        { insurancePlan: linkedPlan._id, status: { $in: ['pending', 'scheduled', 'unpaid'] } },
        { status: 'canceled', updatedAt: new Date() }
      );
      await InsurancePlan.findByIdAndUpdate(linkedPlan._id, { status: 'cancelled', updatedAt: new Date() });
      planCanceled = true;
      planAppointmentsDeleted = planApptResult.deletedCount;
    }

    // ── 6. Marca Package vinculado como cancelled (para aparecer na aba Inativas) ──
    let packageCanceled = false;
    if (linkedPackages.length > 0) {
      await Package.updateMany(
        { _id: { $in: packageIds } },
        { status: 'cancelled', updatedAt: new Date() }
      );
      packageCanceled = true;
    }

    // ── 7. Inativa a guia ──
    await InsuranceGuide.findByIdAndUpdate(
      guideObjId,
      { status: 'cancelled', updatedAt: new Date() }
    );

    console.log('[InsuranceGuidesV2] Guia inativada', {
      correlationId,
      guideId: id,
      sessionsCanceled: sessionsResult.modifiedCount,
      appointmentsDeleted: appointmentsDeletedResult.deletedCount,
      paymentsCanceled: paymentsResult.modifiedCount,
      planCanceled,
      planAppointmentsDeleted,
      packageCanceled
    });

    return res.json({
      success: true,
      data: {
        guideId: id,
        sessionsCanceled: sessionsResult.modifiedCount,
        appointmentsDeleted: appointmentsDeletedResult.deletedCount,
        paymentsCanceled: paymentsResult.modifiedCount,
        planCanceled,
        planAppointmentsDeleted,
        packageCanceled
      }
    });

  } catch (error) {
    console.error('[InsuranceGuidesV2] Erro ao inativar guia:', error);
    return res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  }
});

export default router;
