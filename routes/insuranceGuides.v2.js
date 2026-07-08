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
import Convenio from '../models/Convenio.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import InsurancePlan from '../models/InsurancePlan.js';
import Doctor from '../models/Doctor.js';
import { v4 as uuidv4 } from 'uuid';
import { resolvePatientId } from '../utils/identityResolver.js';
import { replaceInsuranceGuideService } from '../services/replaceInsuranceGuideService.js';
import { buildGuideResponse } from '../services/guideLifecycle/guideResponseBuilder.js';

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
      sessionValue,
      doctorId,
      issuedAt,
      notes,
      evaluationAmount,
      generateEvaluationBilling,
      evaluationDate,
      evaluationTime
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

    // Busca billingMode do convênio (congela na guia para preservar histórico)
    const insuranceCode = insurance.toLowerCase().replace(' ', '-');
    const convenioDoc = await Convenio.findOne({ code: insuranceCode });
    const billingMode = convenioDoc?.billingMode || 'per_month';
    const resolvedSessionValue = sessionValue != null ? Number(sessionValue) : (convenioDoc?.sessionValue || 0);
    const totalAuthorizedValue = billingMode === 'per_guide'
      ? parseInt(totalSessions) * resolvedSessionValue
      : null;

    // Cria a guia
    const guideData = {
      number,
      patientId: patientId.toString(),
      specialty,
      insurance: insuranceCode,
      totalSessions: parseInt(totalSessions),
      sessionsUsed: 0,
      sessionsRemaining: parseInt(totalSessions),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      billingMode,
      totalAuthorizedValue,
      ...(sessionValue != null && { sessionValue: Number(sessionValue) }),
      ...(evaluationAmount != null && { evaluationAmount: Number(evaluationAmount) }),
      ...(generateEvaluationBilling != null && { generateEvaluationBilling: Boolean(generateEvaluationBilling) }),
      ...(doctorId && { doctorId }),
      ...(issuedAt && { issuedAt: new Date(issuedAt) }),
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

    // Cria agendamento de avaliação se houver valor e deve gerar cobrança
    if (guide.evaluationAmount > 0 && guide.generateEvaluationBilling !== false) {
      try {
        const evalDateStr = evaluationDate || (guide.issuedAt ? guide.issuedAt.toISOString().substring(0, 10) : new Date().toISOString().substring(0, 10));
        const evalTime = evaluationTime || '08:00';

        const appointment = await Appointment.create({
          patient: guide.patientId,
          doctor: guide.doctorId || null,
          specialty: guide.specialty,
          date: evalDateStr,
          time: evalTime,
          billingType: 'convenio',
          paymentMethod: 'convenio',
          insuranceGuide: guide._id,
          insuranceProvider: guide.insurance,
          sessionValue: guide.evaluationAmount,
          insuranceValue: guide.evaluationAmount,
          operationalStatus: 'pre_agendado',
          clinicalStatus: 'pending',
          paymentStatus: 'pending',
          status: 'pre_agendado',
          notes: 'Avaliação inicial de convênio',
          serviceType: 'evaluation',
          sessionType: guide.specialty,
          duration: 40,
          metadata: { origin: { source: 'insurance_guide' } },
          createdAt: new Date()
        });

        const session = await Session.create({
          patient: guide.patientId,
          doctor: guide.doctorId || null,
          specialty: guide.specialty,
          date: evalDateStr,
          time: evalTime,
          sessionType: guide.specialty,
          serviceType: 'evaluation',
          sessionValue: guide.evaluationAmount,
          appointmentId: appointment._id,
          appointment: appointment._id,
          paymentMethod: 'convenio',
          status: 'pending',
          isPaid: false,
          insuranceGuide: guide._id,
          insurancePlan: null,
          notes: 'Avaliação inicial de convênio',
          createdAt: new Date()
        });

        const payment = await Payment.create({
          patient: guide.patientId,
          doctor: guide.doctorId || null,
          appointment: appointment._id,
          session: session._id,
          specialty: guide.specialty,
          amount: 0,
          billingType: 'convenio',
          status: 'pending',
          financialDate: null,
          paymentDate: new Date(evalDateStr),
          paymentMethod: 'convenio',
          insurance: {
            provider: guide.insurance,
            status: 'pending_billing',
            grossAmount: guide.evaluationAmount,
            guideId: guide._id
          },
          insuranceGuide: guide._id,
          notes: `Avaliação inicial do convênio ${guide.insurance}`,
          kind: 'session_payment'
        });

        await Appointment.findByIdAndUpdate(appointment._id, { session: session._id, payment: payment._id });

        guide.evaluationSessionId = session._id;
        await guide.save();
      } catch (evalError) {
        console.error('[InsuranceGuidesV2] Erro ao criar avaliação:', evalError);
        // Rollback: remove a guide para não deixar estado inconsistente
        await InsuranceGuide.findByIdAndDelete(guide._id).catch(() => {});
        return res.status(500).json({
          success: false,
          errorCode: 'EVALUATION_CREATION_FAILED',
          message: `Guia não foi criada: falha ao gerar agendamento de avaliação. ${evalError.message}`,
          correlationId
        });
      }
    }

    // Salva evento no Outbox (publicado pelo dispatcher)
    try {
      const { saveToOutbox } = await import('../infrastructure/outbox/outboxPattern.js');
      await saveToOutbox({
        eventType: 'INSURANCE_GUIDE_CREATED',
        aggregateType: 'insurance_guide',
        aggregateId: guide._id.toString(),
        payload: {
          guideId: guide._id.toString(),
          patientId,
          number,
          insurance,
          totalSessions,
          correlationId,
          createdAt: new Date().toISOString()
        },
        correlationId
      });
    } catch (eventError) {
      console.warn('[InsuranceGuidesV2] Evento falhou (não crítico):', eventError.message);
    }

    // Retorna no contrato V2 { guide, lifecycle }
    const conv = await Convenio.findOne({ code: guide.insurance }).select('guidePolicy defaultSessions').lean();
    const response = await buildGuideResponse(guide, conv);

    res.status(201).json({
      success: true,
      data: response,
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
        .populate('doctorId', 'fullName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      InsuranceGuide.countDocuments(query)
    ]);

    // Agrega contagem de appointments por status para cada guia
    const guideIds = guides.map(g => g._id);
    const apptCounts = await Appointment.aggregate([
      { $match: { insuranceGuide: { $in: guideIds } } },
      { $group: {
        _id: '$insuranceGuide',
        canceledCount: { $sum: { $cond: [{ $in: ['$operationalStatus', ['canceled', 'cancelled', 'missed']] }, 1, 0] } },
        scheduledCount: { $sum: { $cond: [{ $in: ['$operationalStatus', ['pre_agendado', 'scheduled', 'confirmed']] }, 1, 0] } },
        completedCount: { $sum: { $cond: [{ $eq: ['$operationalStatus', 'completed'] }, 1, 0] } }
      }}
    ]);
    const apptCountMap = {};
    for (const c of apptCounts) apptCountMap[c._id.toString()] = c;

    // Carregar guidePolicy dos convênios em batch (uma query para todos)
    const insuranceCodes = [...new Set(guides.map(g => g.insurance).filter(Boolean))];
    const convenioMap = {};
    if (insuranceCodes.length > 0) {
      const convenios = await Convenio.find({ code: { $in: insuranceCodes } })
        .select('code guidePolicy defaultSessions').lean();
      for (const c of convenios) convenioMap[c.code] = c;
    }

    // Constrói respostas { guide, lifecycle } de forma paralela
    const guideResponses = await Promise.all(
      guides.map(async g => {
        const counts = apptCountMap[g._id.toString()] || { canceledCount: 0, scheduledCount: 0, completedCount: 0 };
        const conv = convenioMap[g.insurance] || null;
        const response = await buildGuideResponse(g, conv);
        return {
          ...response,
          guide: {
            ...response.guide,
            canceledCount: counts.canceledCount,
            scheduledCount: counts.scheduledCount,
            completedCount: counts.completedCount,
          }
        };
      })
    );

    res.json({
      success: true,
      data: {
        guides: guideResponses,
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

    const guide = await InsuranceGuide.findById(id).populate('doctorId', 'fullName').lean();

    if (!guide) {
      return res.status(404).json({
        success: false,
        errorCode: 'NOT_FOUND',
        message: 'Guia não encontrada'
      });
    }

    // Join com Convenio para incluir guidePolicy
    const conv = guide.insurance
      ? await Convenio.findOne({ code: guide.insurance }).select('guidePolicy defaultSessions').lean()
      : null;

    const response = await buildGuideResponse(guide, conv);

    res.json({
      success: true,
      data: response,
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
 * PUT /api/v2/insurance-guides/:id
 * Atualiza guia (specialty, insurance, totalSessions, expiresAt, notes, sessionValue)
 */
router.put('/:id', auth, async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || uuidv4();
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_ID', message: 'ID inválido', correlationId });
    }

    const guide = await InsuranceGuide.findById(id);
    if (!guide) {
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Guia não encontrada', correlationId });
    }

    const { specialty, insurance, totalSessions, expiresAt, notes, sessionValue, doctorId, issuedAt, evaluationAmount, generateEvaluationBilling, evaluationDate, evaluationTime } = req.body;

    if (specialty) {
      if (!VALID_SPECIALTIES.includes(specialty.toLowerCase().trim())) {
        return res.status(400).json({ success: false, errorCode: 'INVALID_SPECIALTY', message: `Especialidade inválida`, correlationId });
      }
      guide.specialty = specialty.toLowerCase().trim();
    }
    if (insurance) guide.insurance = insurance.toLowerCase().replace(' ', '-');
    if (totalSessions !== undefined) guide.totalSessions = parseInt(totalSessions);
    if (expiresAt) guide.expiresAt = new Date(expiresAt);
    if (notes !== undefined) guide.notes = notes;
    if (sessionValue !== undefined) guide.sessionValue = sessionValue != null ? Number(sessionValue) : null;
    if (doctorId !== undefined) guide.doctorId = doctorId || null;
    if (issuedAt !== undefined) guide.issuedAt = issuedAt ? new Date(issuedAt) : null;
    if (evaluationAmount !== undefined) guide.evaluationAmount = evaluationAmount != null ? Number(evaluationAmount) : null;
    if (generateEvaluationBilling !== undefined) guide.generateEvaluationBilling = Boolean(generateEvaluationBilling);

    await guide.save();

    // Se foi adicionada avaliação, ainda não existe sessão de avaliação e deve gerar cobrança
    if (guide.evaluationAmount > 0 && !guide.evaluationSessionId && guide.generateEvaluationBilling !== false) {
      try {
        const evalDateStr = evaluationDate || (guide.issuedAt ? guide.issuedAt.toISOString().substring(0, 10) : new Date().toISOString().substring(0, 10));
        const evalTime = evaluationTime || '08:00';

        const appointment = await Appointment.create({
          patient: guide.patientId,
          doctor: guide.doctorId || null,
          specialty: guide.specialty,
          date: evalDateStr,
          time: evalTime,
          billingType: 'convenio',
          paymentMethod: 'convenio',
          insuranceGuide: guide._id,
          insuranceProvider: guide.insurance,
          sessionValue: guide.evaluationAmount,
          insuranceValue: guide.evaluationAmount,
          operationalStatus: 'pre_agendado',
          clinicalStatus: 'pending',
          paymentStatus: 'pending',
          status: 'pre_agendado',
          notes: 'Avaliação inicial de convênio',
          serviceType: 'evaluation',
          sessionType: guide.specialty,
          duration: 40,
          metadata: { origin: { source: 'insurance_guide' } },
          createdAt: new Date()
        });

        const session = await Session.create({
          patient: guide.patientId,
          doctor: guide.doctorId || null,
          specialty: guide.specialty,
          date: evalDateStr,
          time: evalTime,
          sessionType: guide.specialty,
          serviceType: 'evaluation',
          sessionValue: guide.evaluationAmount,
          appointmentId: appointment._id,
          appointment: appointment._id,
          paymentMethod: 'convenio',
          status: 'pending',
          isPaid: false,
          insuranceGuide: guide._id,
          insurancePlan: null,
          notes: 'Avaliação inicial de convênio',
          createdAt: new Date()
        });

        const payment = await Payment.create({
          patient: guide.patientId,
          doctor: guide.doctorId || null,
          appointment: appointment._id,
          session: session._id,
          specialty: guide.specialty,
          amount: 0,
          billingType: 'convenio',
          status: 'pending',
          financialDate: null,
          paymentDate: new Date(evalDateStr),
          paymentMethod: 'convenio',
          insurance: {
            provider: guide.insurance,
            status: 'pending_billing',
            grossAmount: guide.evaluationAmount,
            guideId: guide._id
          },
          insuranceGuide: guide._id,
          notes: `Avaliação inicial do convênio ${guide.insurance}`,
          kind: 'session_payment'
        });

        await Appointment.findByIdAndUpdate(appointment._id, { session: session._id, payment: payment._id });

        guide.evaluationSessionId = session._id;
        await guide.save();
      } catch (evalError) {
        console.error('[InsuranceGuidesV2] Erro ao criar avaliação na edição:', evalError);
        return res.status(500).json({
          success: false,
          errorCode: 'EVALUATION_CREATION_FAILED',
          message: `Falha ao gerar agendamento de avaliação. ${evalError.message}`,
          correlationId
        });
      }
    }

    const conv = guide.insurance
      ? await Convenio.findOne({ code: guide.insurance }).select('guidePolicy defaultSessions').lean()
      : null;
    const response = await buildGuideResponse(guide, conv);

    return res.status(200).json({
      success: true,
      message: 'Guia atualizada com sucesso',
      data: response,
      meta: { version: '2.0', correlationId }
    });
  } catch (error) {
    console.error('[InsuranceGuidesV2] Erro ao atualizar:', error);
    return res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message, correlationId });
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

    const conv = guide.insurance
      ? await Convenio.findOne({ code: guide.insurance }).select('guidePolicy defaultSessions').lean()
      : null;
    const response = await buildGuideResponse(guide, conv);

    return res.status(200).json({
      success: true,
      message: 'Guia cancelada com sucesso',
      data: response
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
      .select('date time status operationalStatus serviceType sessionType notes doctor professionalName createdAt rescheduledFrom')
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
          .select('date time status operationalStatus serviceType sessionType notes doctor professionalName createdAt rescheduledFrom')
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
 * PATCH /api/v2/insurance-guides/:id/appointments/doctor
 * Bulk-atualiza terapeuta e/ou horário de todos os appointments pre_agendado/scheduled da guia.
 * Appointments confirmed/completed NÃO são alterados.
 * Body: { doctorId?, time? } — pelo menos um dos dois obrigatório.
 */
router.patch('/:id/appointments/doctor', auth, async (req, res) => {
  const { id } = req.params;
  const { doctorId, time, dayOfWeek } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: 'ID inválido' });
  }
  if (!doctorId && !time && dayOfWeek === undefined) {
    return res.status(400).json({ success: false, message: 'Informe doctorId, time e/ou dayOfWeek' });
  }
  if (doctorId && !mongoose.Types.ObjectId.isValid(doctorId)) {
    return res.status(400).json({ success: false, message: 'doctorId inválido' });
  }
  if (time && !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ success: false, message: 'time deve estar no formato HH:MM' });
  }
  if (dayOfWeek !== undefined && (dayOfWeek < 0 || dayOfWeek > 6)) {
    return res.status(400).json({ success: false, message: 'dayOfWeek deve ser 0 (dom) a 6 (sab)' });
  }

  const guideObjId = new mongoose.Types.ObjectId(id);
  const linkedPackages = await Package.find({ insuranceGuide: guideObjId }).select('_id').lean();
  const packageIds = linkedPackages.map(p => p._id);

  const baseQuery = packageIds.length > 0
    ? { $or: [{ insuranceGuide: guideObjId }, { package: { $in: packageIds } }] }
    : { insuranceGuide: guideObjId };

  const pendingFilter = { ...baseQuery, operationalStatus: { $in: ['pre_agendado', 'scheduled'] } };

  // Se dayOfWeek fornecido: recalcula data de cada appointment individualmente
  if (dayOfWeek !== undefined) {
    const appointments = await Appointment.find(pendingFilter).select('_id date').lean();
    let updated = 0;
    for (const appt of appointments) {
      const current = new Date(appt.date);
      const currentDay = current.getDay();
      let diff = dayOfWeek - currentDay;
      if (diff <= 0) diff += 7;
      const newDate = new Date(current);
      newDate.setDate(newDate.getDate() + diff);

      const setFields = { date: newDate.toISOString().substring(0, 10) };
      if (time) setFields.time = time;
      if (doctorId) setFields.doctor = new mongoose.Types.ObjectId(doctorId);

      const r = await Appointment.updateOne({ _id: appt._id }, { $set: setFields });
      updated += r.modifiedCount;
    }
    return res.json({ success: true, data: { updated } });
  }

  // Sem dayOfWeek: updateMany simples
  const patch = {};
  if (doctorId) patch.doctor = new mongoose.Types.ObjectId(doctorId);
  if (time) patch.time = time;

  const result = await Appointment.updateMany(pendingFilter, { $set: patch });
  return res.json({ success: true, data: { updated: result.modifiedCount } });
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
      await Session.deleteMany({ appointmentId: { $in: apptIdsToDelete } });
      await Payment.deleteMany({ appointment: { $in: apptIdsToDelete } });
    }
    const appointmentsDeletedResult = await Appointment.deleteMany({ _id: { $in: apptIdsToDelete } });

    // ── 3. Cancela sessions pendentes diretamente ──
    const sessionsResult = await Session.updateMany(
      {
        $or: guideOrPackageQuery,
        status: { $in: pendingStatuses }
      },
      { status: 'canceled', updatedAt: new Date(), _fromWriteGateway: true }
    );

    // ── 4. Cancela payments pendentes ──
    const paymentsResult = await Payment.updateMany(
      {
        $or: guideOrPackageQuery,
        status: { $in: ['pending', 'scheduled', 'unpaid'] }
      },
      { status: 'canceled', updatedAt: new Date(), _fromWriteGateway: true }
    );

    // ── 5. Cancela InsurancePlan e DELETA seus appointments/sessions/payments futuros ──
    let planCanceled = false;
    let planAppointmentsDeleted = 0;
    const linkedPlan = await InsurancePlan.findOne({ guide: guideObjId }).lean();
    if (linkedPlan) {
      const planApptsToDelete = await Appointment.find({
        insurancePlan: linkedPlan._id, date: { $gte: today }, operationalStatus: { $in: ['scheduled', 'pre_agendado'] }
      }).select('_id').lean();
      const planApptIds = planApptsToDelete.map(a => a._id);

      if (planApptIds.length > 0) {
        await Session.deleteMany({ appointmentId: { $in: planApptIds } });
        await Payment.deleteMany({ appointment: { $in: planApptIds } });
      }
      const planApptResult = await Appointment.deleteMany({ _id: { $in: planApptIds } });

      await Payment.updateMany(
        { insurancePlan: linkedPlan._id, status: { $in: ['pending', 'scheduled', 'unpaid'] } },
        { status: 'canceled', updatedAt: new Date(), _fromWriteGateway: true }
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

/**
 * POST /api/v2/insurance-guides/:id/supersede
 * Substitui uma guia por outra, com migração opcional de atendimentos pendentes.
 *
 * Body:
 *   newGuide: { number, expiresAt, totalSessions, sessionValue, issuedAt, doctorId, billingMode, ... }
 *   replacementTrigger: 'expiration' | 'new_authorization' | 'administrative_correction' | 'judicial_order' | 'manual'
 *   replacementNotes?: string
 *   migrationStrategy: 'none' | 'eligible' | 'manual'
 *   appointmentIds?: string[]   (apenas para migrationStrategy='manual')
 */
router.post('/:id/supersede', auth, async (req, res) => {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'ID inválido' });
    }

    const { newGuide: newGuideData, replacementTrigger, replacementNotes, migrationStrategy, appointmentIds } = req.body;

    if (!newGuideData) {
      return res.status(400).json({ success: false, code: 'MISSING_NEW_GUIDE', message: 'Dados da nova guia são obrigatórios' });
    }
    if (!replacementTrigger) {
      return res.status(400).json({ success: false, code: 'MISSING_TRIGGER', message: 'Motivo da substituição é obrigatório' });
    }
    if (!migrationStrategy) {
      return res.status(400).json({ success: false, code: 'MISSING_STRATEGY', message: 'Estratégia de migração é obrigatória' });
    }

    // Herdar patientId, insurance e specialty da guia original (imutáveis)
    const oldGuide = await InsuranceGuide.findById(id).lean();
    if (!oldGuide) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Guia não encontrada' });
    }

    const newGuidePayload = {
      ...newGuideData,
      patientId: oldGuide.patientId,
      insurance: oldGuide.insurance,
      specialty: oldGuide.specialty,
    };

    const result = await replaceInsuranceGuideService({
      oldGuideId: id,
      newGuideData: newGuidePayload,
      migrationStrategy: migrationStrategy || 'eligible',
      appointmentIds: appointmentIds || [],
      replacementTrigger,
      replacementNotes,
      performedBy: req.user._id,
    });

    return res.status(201).json({
      success: true,
      newGuide: result.newGuide,
      migrated: result.migrated,
      planCloned: result.planCloned,
      planGeneratedAppointmentsCount: result.planGeneratedAppointmentsCount,
      planAppointmentsCanceledCount: result.planAppointmentsCanceledCount,
    });

  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      code: error.code || 'INTERNAL_ERROR',
      message: error.message,
    });
  }
});

/**
 * PATCH /api/v2/insurance-guides/:id
 * Edição restrita de metadados administrativos.
 * Apenas campos da whitelist são aplicados — qualquer outro campo é ignorado silenciosamente.
 */
const PATCH_ALLOWED_FIELDS = ['number', 'expiresAt', 'notes', 'doctorId', 'replacementNotes',
  'totalSessions', 'sessionValue', 'billingMode', 'issuedAt',
  'evaluationAmount', 'generateEvaluationBilling'];

router.patch('/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'ID inválido' });
    }

    const allowed = PATCH_ALLOWED_FIELDS;

    const update = {};
    for (const field of allowed) {
      if (field in req.body) update[field] = req.body[field];
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, code: 'NO_FIELDS', message: 'Nenhum campo editável informado' });
    }

    const guide = await InsuranceGuide.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!guide) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Guia não encontrada' });
    }

    return res.json({ success: true, guide });

  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || 'INTERNAL_ERROR',
      message: error.message,
    });
  }
});

export default router;
