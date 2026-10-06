// routes/insuranceGuides.js
import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import { resolvePatientId } from '../utils/identityResolver.js';
import { GuideLifecycleService } from '../services/guideLifecycle/GuideLifecycleService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

// ======================================================================
// CONSTANTES DE VALIDAÇÃO
// ======================================================================
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
  'unimed-campinas',
  'unimed-central',
  'bradesco-saude',
  'amil',
  'sulamerica',
  'outro'
];

/**
 * ======================================================================
 * POST /api/insurance-guides
 * Cria uma nova guia de convênio
 * ======================================================================
 */
router.post('/', auth, async (req, res) => {
  try {
    const {
      number,
      patientId,
      specialty,
      insurance,
      totalSessions,
      expiresAt,
      notes,
      sessionValue
    } = req.body;

    // Validações básicas
    if (!number || !patientId || !specialty || !insurance || !totalSessions || !expiresAt) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Campos obrigatórios faltando', {
          status: 400,
          extra: { required: ['number', 'patientId', 'specialty', 'insurance', 'totalSessions', 'expiresAt'] },
        }),
        req
      );
    }

    // Validar enum de specialty
    if (!VALID_SPECIALTIES.includes(specialty.toLowerCase().trim())) {
      return sendApiError(
        res,
        new AppError('INVALID_SPECIALTY', `Especialidade inválida. Válidas: ${VALID_SPECIALTIES.join(', ')}`, {
          status: 400,
        }),
        req
      );
    }

    // Validar enum de insurance
    if (!VALID_INSURANCES.includes(insurance.toLowerCase().trim())) {
      return sendApiError(
        res,
        new AppError('INVALID_INSURANCE', `Convênio inválido. Válidos: ${VALID_INSURANCES.join(', ')}`, {
          status: 400,
        }),
        req
      );
    }

    // Validar totalSessions >= 1
    if (totalSessions < 1) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Total de sessões deve ser ao menos 1', {
          status: 400,
        }),
        req
      );
    }

    // Validar expiresAt > hoje
    const expiryDate = new Date(expiresAt);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (expiryDate <= today) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Data de validade deve ser futura', { status: 400 }), req);
    }

    // Resolver patientId: pode vir como ID da patients_view — buscar o ID real
    let resolvedPatientId = patientId;
    const patientExists = await mongoose.connection.db.collection('patients').findOne(
      { _id: new mongoose.Types.ObjectId(patientId) },
      { projection: { _id: 1 } }
    );
    if (!patientExists) {
      const viewDoc = await mongoose.connection.db.collection('patients_view').findOne(
        { _id: new mongoose.Types.ObjectId(patientId) },
        { projection: { patientId: 1 } }
      );
      if (viewDoc?.patientId) {
        resolvedPatientId = viewDoc.patientId.toString();
      }
    }

    // Verificar se número já existe PARA ESTE PACIENTE.
    // Unicidade é por paciente: pacientes diferentes (de convênios/locais diferentes)
    // podem legitimamente ter o mesmo número de guia.
    const existing = await InsuranceGuide.findOne({
      patientId: resolvedPatientId,
      number: number.toUpperCase().trim()
    });
    if (existing) {
      return sendApiError(
        res,
        new AppError('DUPLICATE_GUIDE_NUMBER', `Este paciente já possui a guia ${number} cadastrada`, {
          status: 400,
        }),
        req
      );
    }

    // Criar guia
    const guide = new InsuranceGuide({
      number,
      patientId: resolvedPatientId,
      specialty,
      insurance,
      totalSessions,
      expiresAt,
      notes,
      ...(sessionValue != null && { sessionValue: Number(sessionValue) }),
      createdBy: req.user._id
    });

    await guide.save();

    // Retornar com remaining calculado
    const result = await InsuranceGuide.findById(guide._id)
      .populate('patientId', 'fullName cpf phone')
      .populate('createdBy', 'name email');

    return res.status(201).json({
      success: true,
      message: 'Guia criada com sucesso',
      data: result
    });

  } catch (error) {
    console.error('Erro ao criar guia:', error);

    if (error.name === 'ValidationError') {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Erro de validação', {
          status: 400,
          extra: { errors: Object.fromEntries(
          Object.entries(error.errors || {}).map(([k, v]) => [k, v.message])
        ) },
        }),
        req
      );
    }

    return sendApiError(res, error, req);
  }
});

/**
 * ======================================================================
 * GET /api/insurance-guides
 * Lista guias com filtros opcionais
 * ======================================================================
 */
router.get('/', auth, async (req, res) => {
  try {
    const { patientId, specialty, status, insurance } = req.query;

    // Construir filtro
    const filter = {};

    // 🔑 Resolve patientId (aceita patientId real ou _id da view)
    if (patientId) {
      try {
        const resolvedId = await resolvePatientId(patientId, {
          correlationId: `ig_${Date.now()}`
        });
        filter.patientId = resolvedId;
        console.log(`[InsuranceGuides] Buscando guias para patientId: ${resolvedId}`);
      } catch (error) {
        return sendApiError(res, new AppError('INVALID_PATIENT_ID', error.message, { status: 400 }), req);
      }
    }

    if (specialty) {
      filter.specialty = specialty.toLowerCase().trim();
    }

    if (status) {
      filter.status = status;
    }

    if (insurance) {
      filter.insurance = { $regex: insurance, $options: 'i' };
    }

    // Buscar guias ordenadas por expiresAt ASC
    const guides = await InsuranceGuide.find(filter)
      .populate('patientId', 'fullName cpf phone')
      .sort({ expiresAt: 1 })
      .lean();

    // Adicionar remaining calculado
    const guidesWithRemaining = guides.map(g => ({
      ...g,
      remaining: Math.max(0, g.totalSessions - g.usedSessions)
    }));

    return res.status(200).json({
      success: true,
      count: guidesWithRemaining.length,
      data: {
        guides: guidesWithRemaining
      }
    });

  } catch (error) {
    console.error('Erro ao listar guias:', error);
    return sendApiError(res, error, req);
  }
});

/**
 * ======================================================================
 * GET /api/insurance-guides/:id
 * Busca uma guia específica por ID
 * ======================================================================
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'ID inválido', { status: 400 }), req);
    }

    const guide = await InsuranceGuide.findById(id)
      .populate('patientId', 'fullName cpf phone email dateOfBirth')
      .populate('createdBy', 'name email');

    if (!guide) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Guia não encontrada', { status: 404 }), req);
    }

    return res.status(200).json({
      success: true,
      data: guide
    });

  } catch (error) {
    console.error('Erro ao buscar guia:', error);
    return sendApiError(res, error, req);
  }
});

/**
 * ======================================================================
 * PUT /api/insurance-guides/:id
 * Atualiza uma guia (somente se não foi utilizada)
 * ======================================================================
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { specialty, insurance, totalSessions, expiresAt, notes, sessionValue } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'ID inválido', { status: 400 }), req);
    }

    // Buscar guia
    const guide = await InsuranceGuide.findById(id);

    if (!guide) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Guia não encontrada', { status: 404 }), req);
    }

    // Restrição: só edita se lifecycle permitir
    const lifecycle = await GuideLifecycleService.evaluate(guide, new Date());
    if (!lifecycle.eligibility.canEdit) {
      return sendApiError(
        res,
        new AppError('GUIDE_NOT_EDITABLE', 'Não é possível editar guia já utilizada ou em estado bloqueado', {
          status: 400,
          details: {
          usedSessions: guide.usedSessions,
          status: guide.status,
          lifecycle
        },
        }),
        req
      );
    }

    // Validar enum de specialty
    if (specialty && !VALID_SPECIALTIES.includes(specialty.toLowerCase().trim())) {
      return sendApiError(
        res,
        new AppError('INVALID_SPECIALTY', `Especialidade inválida. Válidas: ${VALID_SPECIALTIES.join(', ')}`, {
          status: 400,
        }),
        req
      );
    }

    // Validar enum de insurance
    if (insurance && !VALID_INSURANCES.includes(insurance.toLowerCase().trim())) {
      return sendApiError(
        res,
        new AppError('INVALID_INSURANCE', `Convênio inválido. Válidos: ${VALID_INSURANCES.join(', ')}`, {
          status: 400,
        }),
        req
      );
    }

    // Validar totalSessions >= 1
    if (totalSessions !== undefined && totalSessions < 1) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Total de sessões deve ser ao menos 1', {
          status: 400,
        }),
        req
      );
    }

    // Validar expiresAt > hoje
    if (expiresAt) {
      const expiryDate = new Date(expiresAt);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (expiryDate <= today) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Data de validade deve ser futura', {
            status: 400,
          }),
          req
        );
      }
    }

    // Atualizar campos permitidos
    if (specialty) guide.specialty = specialty;
    if (insurance) guide.insurance = insurance;
    if (totalSessions !== undefined) guide.totalSessions = totalSessions;
    if (expiresAt) guide.expiresAt = expiresAt;
    if (notes !== undefined) guide.notes = notes;
    if (sessionValue !== undefined) guide.sessionValue = sessionValue != null ? Number(sessionValue) : null;

    await guide.save();

    // Retornar guia atualizada
    const updated = await InsuranceGuide.findById(id)
      .populate('patientId', 'fullName cpf phone')
      .populate('createdBy', 'name email');

    return res.status(200).json({
      success: true,
      message: 'Guia atualizada com sucesso',
      data: updated
    });

  } catch (error) {
    console.error('Erro ao atualizar guia:', error);

    if (error.name === 'ValidationError') {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Erro de validação', {
          status: 400,
          extra: { errors: Object.fromEntries(
          Object.entries(error.errors || {}).map(([k, v]) => [k, v.message])
        ) },
        }),
        req
      );
    }

    return sendApiError(res, error, req);
  }
});

/**
 * ======================================================================
 * DELETE /api/insurance-guides/:id
 * Soft delete - marca guia como cancelada
 * ======================================================================
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'ID inválido', { status: 400 }), req);
    }

    const guide = await InsuranceGuide.findById(id);

    if (!guide) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Guia não encontrada', { status: 404 }), req);
    }

    // Soft delete: status = 'cancelled'
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
    console.error('Erro ao cancelar guia:', error);
    return sendApiError(res, error, req);
  }
});

/**
 * ======================================================================
 * GET /api/insurance-guides/patient/:patientId/balance
 * Retorna saldo de guias ativas do paciente
 * ======================================================================
 */
router.get('/patient/:patientId/balance', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { specialty } = req.query;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'ID do paciente inválido', { status: 400 }), req);
    }

    // Resolver patientId: pode vir como ID da patients_view — buscar o ID real
    let resolvedPatientId = patientId;
    const patientExists = await mongoose.connection.db.collection('patients').findOne(
      { _id: new mongoose.Types.ObjectId(patientId) },
      { projection: { _id: 1 } }
    );
    if (!patientExists) {
      const viewDoc = await mongoose.connection.db.collection('patients_view').findOne(
        { _id: new mongoose.Types.ObjectId(patientId) },
        { projection: { patientId: 1 } }
      );
      if (viewDoc?.patientId) {
        resolvedPatientId = viewDoc.patientId.toString();
      }
    }

    // Usar método estático do model
    const balance = await InsuranceGuide.getBalance(resolvedPatientId, specialty);

    return res.status(200).json({
      success: true,
      data: balance
    });

  } catch (error) {
    console.error('Erro ao consultar saldo:', error);
    return sendApiError(res, error, req);
  }
});

export default router;
