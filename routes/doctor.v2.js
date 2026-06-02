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
import mongoose from 'mongoose';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';
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

// Helper: calcula stats dos médicos
async function enrichDoctorsWithStats(doctors) {
  if (!doctors.length) return [];
  const doctorIds = doctors.map(d => d._id.toString());
  const objectIds = doctorIds.map(id => new mongoose.Types.ObjectId(id));

  // Mês atual
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  startOfMonth.setHours(0, 0, 0, 0);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  endOfMonth.setHours(23, 59, 59, 999);

  const [patientCounts, appointmentCounts] = await Promise.all([
    // Pacientes ÚNICOS atendidos por cada doctor (via appointments do mês)
    Appointment.aggregate([
      {
        $match: {
          doctor: { $in: objectIds, $exists: true, $ne: null },
          date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      { $group: { _id: '$doctor', patients: { $addToSet: '$patient' } } },
      { $project: { _id: 1, count: { $size: '$patients' } } }
    ]),

    // Appointments do MÊS por doctor
    Appointment.aggregate([
      {
        $match: {
          doctor: { $in: objectIds, $exists: true, $ne: null },
          date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      { $group: { _id: '$doctor', count: { $sum: 1 } } }
    ])
  ]);

  const patientMap = Object.fromEntries(patientCounts.map(p => [p._id.toString(), p.count]));
  const appointmentMap = Object.fromEntries(appointmentCounts.map(a => [a._id.toString(), a.count]));

  return doctors.map(d => {
    const dId = d._id.toString();
    const patients = patientMap[dId] || 0;
    const monthlySessions = appointmentMap[dId] || 0;
    const maxSlots = d.maxSlots || 30;
    return {
      ...d,
      _id: dId,
      status: d.status || (d.active === false ? 'inativo' : 'ativo'),
      maxSlots,
      patients,
      monthlySessions,
      occupancy: Math.round((monthlySessions / maxSlots) * 100)
    };
  });
}

/**
 * GET /api/v2/doctors - Lista médicos com paginação + stats
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
        .select('_id fullName email specialty licenseNumber phoneNumber active role status maxSlots weeklyAvailability createdAt updatedAt deactivatedAt')
        .sort({ fullName: 1 })
        .skip(parseInt(skip))
        .limit(parseInt(limit))
        .lean(),
      Doctor.countDocuments(query)
    ]);

    const enriched = await enrichDoctorsWithStats(doctors);

    return res.json(formatSuccess({
      doctors: enriched,
      pagination: {
        total,
        limit: parseInt(limit),
        skip: parseInt(skip),
        hasMore: parseInt(skip) + doctors.length < total
      },
      meta: { source: 'doctor_v2', duration: 'fast' }
    }));
    
  } catch (error) {
    console.error('[DoctorV2] Erro ao listar médicos:', error);
    return res.status(500).json(formatError(500, error.message));
  }
});

/**
 * GET /api/v2/doctors/active - Lista médicos ativos + stats
 */
router.get('/active', flexibleAuth, async (req, res) => {
  try {
    const doctors = await Doctor.find({ active: true })
      .select('_id fullName email specialty licenseNumber phoneNumber active role status maxSlots deactivatedAt')
      .sort({ fullName: 1 })
      .lean();
    
    const enriched = await enrichDoctorsWithStats(doctors);
    return res.json(formatSuccess({ doctors: enriched }));
  } catch (error) {
    return res.status(500).json(formatError(500, error.message));
  }
});

/**
 * GET /api/v2/doctors/inactive - Lista médicos inativos + stats
 */
router.get('/inactive', flexibleAuth, async (req, res) => {
  try {
    const doctors = await Doctor.find({ active: false })
      .select('_id fullName email specialty licenseNumber phoneNumber active role status maxSlots deactivatedAt')
      .sort({ fullName: 1 })
      .lean();
    
    const enriched = await enrichDoctorsWithStats(doctors);
    return res.json(formatSuccess({ doctors: enriched }));
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
 * GET /api/v2/doctors/stats - Lista médicos com estatísticas operacionais
 *
 * Retorna:
 * - patients: total de pacientes vinculados
 * - weeklySessions: sessões agendadas esta semana (seg-dom)
 * - occupancy: % de vagas preenchidas (weeklySessions / maxSlots * 100)
 */
router.get('/stats', flexibleAuth, async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    let query = {};
    if (status === 'active') query.active = true;
    if (status === 'inactive') query.active = false;

    const doctors = await Doctor.find(query)
      .select('_id fullName email specialty licenseNumber phoneNumber active role status maxSlots deactivatedAt')
      .sort({ fullName: 1 })
      .lean();

    if (!doctors.length) {
      return res.json(formatSuccess({ doctors: [] }));
    }

    const doctorIds = doctors.map(d => d._id.toString());

    // Semana atual (segunda a domingo)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    // Busca counts simples (sem aggregation)
    const patientCounts = {};
    const appointmentCounts = {};

    for (const id of doctorIds) {
      try {
        patientCounts[id] = await Patient.countDocuments({ doctor: id });
      } catch (e) {
        patientCounts[id] = 0;
      }
      try {
        appointmentCounts[id] = await Appointment.countDocuments({
          doctor: id,
          date: { $gte: startOfWeek, $lte: endOfWeek }
        });
      } catch (e) {
        appointmentCounts[id] = 0;
      }
    }

    const enriched = doctors.map(d => {
      const dId = d._id.toString();
      const patients = patientCounts[dId] || 0;
      const weeklySessions = appointmentCounts[dId] || 0;
      const maxSlots = d.maxSlots || 30;
      const occupancy = Math.round((weeklySessions / maxSlots) * 100);

      return {
        _id: dId,
        fullName: d.fullName,
        email: d.email,
        specialty: d.specialty,
        licenseNumber: d.licenseNumber,
        phoneNumber: d.phoneNumber,
        active: d.active,
        status: d.status || (d.active === false ? 'inativo' : 'ativo'),
        maxSlots,
        patients,
        weeklySessions,
        occupancy,
        deactivatedAt: d.deactivatedAt
      };
    });

    return res.json(formatSuccess({ doctors: enriched }));

  } catch (error) {
    console.error('[DoctorV2] Erro em /stats:', error);
    return res.status(500).json(formatError(500, error.message));
  }
});

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
