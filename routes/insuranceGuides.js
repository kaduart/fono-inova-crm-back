// routes/insuranceGuides.js
import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import InsuranceGuide from '../models/InsuranceGuide.js';

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
      notes
    } = req.body;

    // Validações básicas
    if (!number || !patientId || !specialty || !insurance || !totalSessions || !expiresAt) {
      return res.status(400).json({
        success: false,
        message: 'Campos obrigatórios faltando',
        required: ['number', 'patientId', 'specialty', 'insurance', 'totalSessions', 'expiresAt']
      });
    }

    // Validar enum de specialty
    if (!VALID_SPECIALTIES.includes(specialty.toLowerCase().trim())) {
      return res.status(400).json({
        success: false,
        message: `Especialidade inválida. Válidas: ${VALID_SPECIALTIES.join(', ')}`,
        code: 'INVALID_SPECIALTY'
      });
    }

    // Validar enum de insurance
    if (!VALID_INSURANCES.includes(insurance.toLowerCase().trim())) {
      return res.status(400).json({
        success: false,
        message: `Convênio inválido. Válidos: ${VALID_INSURANCES.join(', ')}`,
        code: 'INVALID_INSURANCE'
      });
    }

    // Validar totalSessions >= 1
    if (totalSessions < 1) {
      return res.status(400).json({
        success: false,
        message: 'Total de sessões deve ser ao menos 1'
      });
    }

    // Validar expiresAt > hoje
    const expiryDate = new Date(expiresAt);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (expiryDate <= today) {
      return res.status(400).json({
        success: false,
        message: 'Data de validade deve ser futura'
      });
    }

    // Verificar se número já existe
    const existing = await InsuranceGuide.findOne({ number: number.toUpperCase().trim() });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Guia ${number} já existe no sistema`,
        code: 'DUPLICATE_GUIDE_NUMBER'
      });
    }

    // Criar guia
    const guide = new InsuranceGuide({
      number,
      patientId,
      specialty,
      insurance,
      totalSessions,
      expiresAt,
      notes,
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
      return res.status(400).json({
        success: false,
        message: 'Erro de validação',
        errors: Object.fromEntries(
          Object.entries(error.errors || {}).map(([k, v]) => [k, v.message])
        )
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
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

    if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
      filter.patientId = new mongoose.Types.ObjectId(patientId);
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
      .populate('createdBy', 'name email')
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
    return res.status(500).json({
      success: false,
      message: error.message
    });
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
      return res.status(400).json({
        success: false,
        message: 'ID inválido'
      });
    }

    const guide = await InsuranceGuide.findById(id)
      .populate('patientId', 'fullName cpf phone email dateOfBirth')
      .populate('createdBy', 'name email');

    if (!guide) {
      return res.status(404).json({
        success: false,
        message: 'Guia não encontrada'
      });
    }

    return res.status(200).json({
      success: true,
      data: guide
    });

  } catch (error) {
    console.error('Erro ao buscar guia:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
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
    const { specialty, insurance, totalSessions, expiresAt, notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'ID inválido'
      });
    }

    // Buscar guia
    const guide = await InsuranceGuide.findById(id);

    if (!guide) {
      return res.status(404).json({
        success: false,
        message: 'Guia não encontrada'
      });
    }

    // Restrição: só edita se usedSessions === 0
    if (guide.usedSessions > 0) {
      return res.status(400).json({
        success: false,
        message: 'Não é possível editar guia já utilizada',
        code: 'GUIDE_ALREADY_USED',
        details: {
          usedSessions: guide.usedSessions
        }
      });
    }

    // Validar enum de specialty
    if (specialty && !VALID_SPECIALTIES.includes(specialty.toLowerCase().trim())) {
      return res.status(400).json({
        success: false,
        message: `Especialidade inválida. Válidas: ${VALID_SPECIALTIES.join(', ')}`,
        code: 'INVALID_SPECIALTY'
      });
    }

    // Validar enum de insurance
    if (insurance && !VALID_INSURANCES.includes(insurance.toLowerCase().trim())) {
      return res.status(400).json({
        success: false,
        message: `Convênio inválido. Válidos: ${VALID_INSURANCES.join(', ')}`,
        code: 'INVALID_INSURANCE'
      });
    }

    // Validar totalSessions >= 1
    if (totalSessions !== undefined && totalSessions < 1) {
      return res.status(400).json({
        success: false,
        message: 'Total de sessões deve ser ao menos 1'
      });
    }

    // Validar expiresAt > hoje
    if (expiresAt) {
      const expiryDate = new Date(expiresAt);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (expiryDate <= today) {
        return res.status(400).json({
          success: false,
          message: 'Data de validade deve ser futura'
        });
      }
    }

    // Atualizar campos permitidos
    if (specialty) guide.specialty = specialty;
    if (insurance) guide.insurance = insurance;
    if (totalSessions !== undefined) guide.totalSessions = totalSessions;
    if (expiresAt) guide.expiresAt = expiresAt;
    if (notes !== undefined) guide.notes = notes;

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
      return res.status(400).json({
        success: false,
        message: 'Erro de validação',
        errors: Object.fromEntries(
          Object.entries(error.errors || {}).map(([k, v]) => [k, v.message])
        )
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
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
      return res.status(400).json({
        success: false,
        message: 'ID inválido'
      });
    }

    const guide = await InsuranceGuide.findById(id);

    if (!guide) {
      return res.status(404).json({
        success: false,
        message: 'Guia não encontrada'
      });
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
    return res.status(500).json({
      success: false,
      message: error.message
    });
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
      return res.status(400).json({
        success: false,
        message: 'ID do paciente inválido'
      });
    }

    // Usar método estático do model
    const balance = await InsuranceGuide.getBalance(patientId, specialty);

    return res.status(200).json({
      success: true,
      data: balance
    });

  } catch (error) {
    console.error('Erro ao consultar saldo:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

export default router;
