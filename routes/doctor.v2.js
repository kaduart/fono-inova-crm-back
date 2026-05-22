// back/routes/doctor.v2.js
/**
 * Rotas V2 - Doctors (CQRS-style, Event-Driven)
 * 
 * Endpoints:
 * - GET /api/v2/doctors - Listar médicos com paginação
 * - GET /api/v2/doctors/active - Listar ativos
 * - GET /api/v2/doctors/inactive - Listar inativos
 * - GET /api/v2/doctors/:id - Buscar por ID
 * - POST /api/v2/doctors - Criar médico (async)
 * - PUT /api/v2/doctors/:id - Atualizar médico (async)
 * - DELETE /api/v2/doctors/:id - Deletar médico (async)
 * - PATCH /api/v2/doctors/:id/deactivate - Inativar (async)
 * - PATCH /api/v2/doctors/:id/reactivate - Reativar (async)
 */

import express from 'express';
import Doctor from '../models/Doctor.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { formatSuccess, formatError } from '../utils/apiMessages.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

const FIELD_LABELS = {
  fullName: 'Nome completo',
  email: 'E-mail',
  specialty: 'Especialidade',
  licenseNumber: 'Número de registro',
  phoneNumber: 'Telefone',
  active: 'Status',
  password: 'Senha',
};

function translateMongooseError(error) {
  if (error.name === 'ValidationError') {
    const msgs = Object.values(error.errors).map(e => {
      const field = FIELD_LABELS[e.path] || e.path;
      if (e.kind === 'required') return `${field} é obrigatório`;
      if (e.kind === 'enum') return `Valor inválido para ${field}: "${e.value}"`;
      if (e.kind === 'unique') return `${field} já cadastrado`;
      return `${field}: ${e.message}`;
    });
    return msgs.join('. ');
  }
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0];
    const label = FIELD_LABELS[field] || field;
    return `${label} já está cadastrado`;
  }
  return error.message;
}

// ============================================
// READ SIDE (Síncrono - direto do DB)
// ============================================

/**
 * GET /api/v2/doctors - Lista médicos com paginação
 */
router.get('/', flexibleAuth, async (req, res) => {
  try {
    const { search, limit = 50, skip = 0, status = 'all' } = req.query;
    
    let query = {};
    
    if (status === 'active') query.active = true;
    if (status === 'inactive') query.active = false;
    
    if (search && search.trim()) {
      const term = search.trim();
      query.$or = [
        { fullName: { $regex: term, $options: 'i' } },
        { specialty: { $regex: term, $options: 'i' } }
      ];
    }
    
    const [doctors, total] = await Promise.all([
      Doctor.find(query)
        .select('_id fullName email specialty licenseNumber phoneNumber active role weeklyAvailability createdAt updatedAt')
        .sort({ fullName: 1 })
        .skip(parseInt(skip))
        .limit(parseInt(limit))
        .lean(),
      Doctor.countDocuments(query)
    ]);

    return res.json(formatSuccess({
      doctors: doctors.map(d => ({
        _id: d._id.toString(),
        fullName: d.fullName,
        email: d.email,
        specialty: d.specialty,
        licenseNumber: d.licenseNumber,
        phoneNumber: d.phoneNumber,
        active: d.active,
        role: d.role || 'doctor',
        weeklyAvailability: d.weeklyAvailability || [],
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
      })),
      pagination: {
        total,
        limit: parseInt(limit),
        skip: parseInt(skip),
        hasMore: parseInt(skip) + doctors.length < total
      },
      meta: {
        source: 'doctor_v2',
        duration: 'fast'
      }
    }));
    
  } catch (error) {
    console.error('[DoctorV2] Erro ao listar médicos:', error);
    return res.status(500).json(formatError(500, error.message));
  }
});

/**
 * GET /api/v2/doctors/active - Lista médicos ativos
 */
router.get('/active', flexibleAuth, async (req, res) => {
  try {
    const doctors = await Doctor.find({ active: true })
      .select('_id fullName email specialty licenseNumber phoneNumber active role')
      .sort({ fullName: 1 })
      .lean();
    
    return res.json(formatSuccess({ doctors }));
  } catch (error) {
    return res.status(500).json(formatError(500, error.message));
  }
});

/**
 * GET /api/v2/doctors/inactive - Lista médicos inativos
 */
router.get('/inactive', flexibleAuth, async (req, res) => {
  try {
    const doctors = await Doctor.find({ active: false })
      .select('_id fullName email specialty licenseNumber phoneNumber active role')
      .sort({ fullName: 1 })
      .lean();
    
    return res.json(formatSuccess({ doctors }));
  } catch (error) {
    return res.status(500).json(formatError(500, error.message));
  }
});

/**
 * GET /api/v2/doctors/:id - Busca médico por ID
 */
router.get('/:id', flexibleAuth, async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id).lean();
    
    if (!doctor) {
      return res.status(404).json(formatError(404, 'Médico não encontrado'));
    }
    
    return res.json(formatSuccess({
      _id: doctor._id.toString(),
      fullName: doctor.fullName,
      email: doctor.email,
      specialty: doctor.specialty,
      licenseNumber: doctor.licenseNumber,
      phoneNumber: doctor.phoneNumber,
      active: doctor.active,
      role: doctor.role || 'doctor',
      weeklyAvailability: doctor.weeklyAvailability || [],
      createdAt: doctor.createdAt,
      updatedAt: doctor.updatedAt
    }));
    
  } catch (error) {
    return res.status(500).json(formatError(500, error.message));
  }
});

// ============================================
// WRITE SIDE (Async - via Fila)
// ============================================

/**
 * POST /api/v2/doctors - Criar médico (síncrono)
 */
router.post('/', flexibleAuth, async (req, res) => {
  const correlationId = `doc_create_${Date.now()}_${uuidv4().slice(0, 8)}`;

  try {
    const { fullName, email, password, specialty, licenseNumber, phoneNumber, active } = req.body;

    if (!fullName || !email || !specialty) {
      return res.status(400).json(formatError(400, 'Nome, e-mail e especialidade são obrigatórios'));
    }
    if (!licenseNumber) {
      return res.status(400).json(formatError(400, 'Número de registro (CRM/CRP/etc) é obrigatório'));
    }

    const doctor = await Doctor.create({
      fullName: fullName.trim(),
      email: email.toLowerCase().trim(),
      password,
      specialty,
      licenseNumber,
      phoneNumber,
      active: active !== undefined ? active : true,
      role: 'doctor',
      createdBy: req.user?.id
    });

    console.log(`[DoctorV2] Médico criado: ${doctor._id} (${doctor.fullName})`);

    return res.status(201).json(formatSuccess({
      jobId: correlationId,
      eventId: correlationId,
      correlationId,
      doctorId: doctor._id.toString(),
      status: 'completed',
      doctor
    }, 'Médico criado com sucesso', 201));

  } catch (error) {
    console.error('[DoctorV2] Erro ao criar médico:', error);
    const msg = translateMongooseError(error);
    return res.status(400).json(formatError(400, msg));
  }
});

/**
 * PUT /api/v2/doctors/:id - Atualizar médico (síncrono)
 */
router.put('/:id', flexibleAuth, async (req, res) => {
  const correlationId = `doc_upd_${Date.now()}_${uuidv4().slice(0, 8)}`;

  try {
    const doctor = await Doctor.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date(), updatedBy: req.user?.id },
      { new: true }
    );

    if (!doctor) {
      return res.status(404).json(formatError(404, 'Médico não encontrado'));
    }

    console.log(`[DoctorV2] Médico atualizado: ${doctor._id}`);

    return res.json(formatSuccess({
      jobId: correlationId,
      eventId: correlationId,
      correlationId,
      doctorId: doctor._id.toString(),
      status: 'completed',
      doctor
    }, 'Médico atualizado com sucesso'));

  } catch (error) {
    return res.status(500).json(formatError(500, error.message));
  }
});

/**
 * DELETE /api/v2/doctors/:id - Deletar médico (síncrono)
 */
router.delete('/:id', flexibleAuth, async (req, res) => {
  const correlationId = `doc_del_${Date.now()}_${uuidv4().slice(0, 8)}`;

  try {
    const doctor = await Doctor.findByIdAndDelete(req.params.id);

    if (!doctor) {
      return res.status(404).json(formatError(404, 'Médico não encontrado'));
    }

    console.log(`[DoctorV2] Médico deletado: ${req.params.id}`);

    return res.json(formatSuccess({
      jobId: correlationId,
      eventId: correlationId,
      correlationId,
      status: 'completed'
    }, 'Médico deletado com sucesso'));

  } catch (error) {
    return res.status(500).json(formatError(500, error.message));
  }
});

/**
 * PATCH /api/v2/doctors/:id/deactivate - Inativar médico (síncrono)
 */
router.patch('/:id/deactivate', flexibleAuth, async (req, res) => {
  const correlationId = `doc_deact_${Date.now()}_${uuidv4().slice(0, 8)}`;

  try {
    const doctor = await Doctor.findByIdAndUpdate(
      req.params.id,
      { active: false, updatedAt: new Date() },
      { new: true }
    );

    if (!doctor) {
      return res.status(404).json(formatError(404, 'Médico não encontrado'));
    }

    console.log(`[DoctorV2] Médico inativado: ${doctor._id}`);

    return res.json(formatSuccess({
      jobId: correlationId,
      eventId: correlationId,
      correlationId,
      doctorId: doctor._id.toString(),
      status: 'completed',
      doctor
    }, 'Médico inativado com sucesso'));

  } catch (error) {
    return res.status(500).json(formatError(500, error.message));
  }
});

/**
 * PATCH /api/v2/doctors/:id/reactivate - Reativar médico (síncrono)
 */
router.patch('/:id/reactivate', flexibleAuth, async (req, res) => {
  const correlationId = `doc_react_${Date.now()}_${uuidv4().slice(0, 8)}`;

  try {
    const doctor = await Doctor.findByIdAndUpdate(
      req.params.id,
      { active: true, updatedAt: new Date() },
      { new: true }
    );

    if (!doctor) {
      return res.status(404).json(formatError(404, 'Médico não encontrado'));
    }

    console.log(`[DoctorV2] Médico reativado: ${doctor._id}`);

    return res.json(formatSuccess({
      jobId: correlationId,
      eventId: correlationId,
      correlationId,
      doctorId: doctor._id.toString(),
      status: 'completed',
      doctor
    }, 'Médico reativado com sucesso'));

  } catch (error) {
    return res.status(500).json(formatError(500, error.message));
  }
});

// ============================================
// STATUS & MONITORING
// ============================================

/**
 * GET /api/v2/doctors/status/:jobId - Legado (operações agora síncronas)
 */
router.get('/status/:jobId', flexibleAuth, async (req, res) => {
  return res.json(formatSuccess({
    jobId: req.params.jobId,
    status: 'completed',
    message: 'Operações de doutor agora são síncronas'
  }));
});

export default router;
