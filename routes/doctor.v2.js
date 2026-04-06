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
import { auth } from '../middleware/auth.js';
import { formatSuccess, formatError } from '../utils/apiMessages.js';
import { doctorQueue } from '../config/bullConfig.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

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
    
    if (status === 'active') query.active = 'true';
    if (status === 'inactive') query.active = 'false';
    
    if (search && search.trim()) {
      const term = search.trim();
      query.$or = [
        { fullName: { $regex: term, $options: 'i' } },
        { specialty: { $regex: term, $options: 'i' } }
      ];
    }
    
    const [doctors, total] = await Promise.all([
      Doctor.find(query)
        .select('_id fullName email specialty licenseNumber phoneNumber active role createdAt updatedAt')
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
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * GET /api/v2/doctors/active - Lista médicos ativos
 */
router.get('/active', flexibleAuth, async (req, res) => {
  try {
    const doctors = await Doctor.find({ active: 'true' })
      .select('_id fullName email specialty licenseNumber phoneNumber active role')
      .sort({ fullName: 1 })
      .lean();
    
    return res.json(formatSuccess({ doctors }));
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * GET /api/v2/doctors/inactive - Lista médicos inativos
 */
router.get('/inactive', flexibleAuth, async (req, res) => {
  try {
    const doctors = await Doctor.find({ active: 'false' })
      .select('_id fullName email specialty licenseNumber phoneNumber active role')
      .sort({ fullName: 1 })
      .lean();
    
    return res.json(formatSuccess({ doctors }));
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * GET /api/v2/doctors/:id - Busca médico por ID
 */
router.get('/:id', flexibleAuth, async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id).lean();
    
    if (!doctor) {
      return res.status(404).json(formatError('Médico não encontrado', 404));
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
      createdAt: doctor.createdAt,
      updatedAt: doctor.updatedAt
    }));
    
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

// ============================================
// WRITE SIDE (Async - via Fila)
// ============================================

/**
 * POST /api/v2/doctors - Criar médico (async)
 */
router.post('/', auth, async (req, res) => {
  const correlationId = `doc_create_${Date.now()}_${uuidv4().slice(0, 8)}`;
  
  try {
    const { fullName, email, password, specialty, licenseNumber, phoneNumber, active } = req.body;
    
    if (!fullName || !email || !specialty) {
      return res.status(400).json(formatError('Nome, email e especialidade são obrigatórios', 400));
    }
    
    // Gera ID provisório
    const mongoose = await import('mongoose');
    const doctorId = new mongoose.default.Types.ObjectId().toString();
    
    // Adiciona job na fila
    const job = await doctorQueue.add(
      'DOCTOR_CREATE',
      {
        eventType: 'DOCTOR_CREATE_REQUESTED',
        payload: {
          doctorId,
          fullName: fullName.trim(),
          email: email.toLowerCase().trim(),
          password,
          specialty,
          licenseNumber,
          phoneNumber,
          active: active || 'true',
          createdBy: req.user?.id
        },
        correlationId
      },
      {
        jobId: correlationId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      }
    );
    
    return res.status(202).json(formatSuccess({
      jobId: job.id,
      correlationId,
      doctorId,
      status: 'pending',
      checkStatusUrl: `/api/v2/doctors/status/${job.id}`,
      estimatedTime: '1-2s'
    }, 'Médico em processamento', 202));
    
  } catch (error) {
    console.error('[DoctorV2] Erro ao criar médico:', error);
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * PUT /api/v2/doctors/:id - Atualizar médico (async)
 */
router.put('/:id', auth, async (req, res) => {
  const correlationId = `doc_upd_${Date.now()}_${uuidv4().slice(0, 8)}`;
  
  try {
    const doctorExists = await Doctor.exists({ _id: req.params.id });
    if (!doctorExists) {
      return res.status(404).json(formatError('Médico não encontrado', 404));
    }
    
    const job = await doctorQueue.add(
      'DOCTOR_UPDATE',
      {
        eventType: 'DOCTOR_UPDATE_REQUESTED',
        payload: {
          doctorId: req.params.id,
          updates: req.body,
          updatedBy: req.user?.id
        },
        correlationId
      },
      {
        jobId: correlationId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      }
    );
    
    return res.status(202).json(formatSuccess({
      jobId: job.id,
      correlationId,
      status: 'pending',
      checkStatusUrl: `/api/v2/doctors/status/${job.id}`
    }, 'Atualização em processamento', 202));
    
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * DELETE /api/v2/doctors/:id - Deletar médico (async)
 */
router.delete('/:id', auth, async (req, res) => {
  const correlationId = `doc_del_${Date.now()}_${uuidv4().slice(0, 8)}`;
  
  try {
    const doctorExists = await Doctor.exists({ _id: req.params.id });
    if (!doctorExists) {
      return res.status(404).json(formatError('Médico não encontrado', 404));
    }
    
    const job = await doctorQueue.add(
      'DOCTOR_DELETE',
      {
        eventType: 'DOCTOR_DELETE_REQUESTED',
        payload: {
          doctorId: req.params.id,
          deletedBy: req.user?.id,
          reason: req.body?.reason
        },
        correlationId
      },
      {
        jobId: correlationId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      }
    );
    
    return res.status(202).json(formatSuccess({
      jobId: job.id,
      correlationId,
      status: 'pending'
    }, 'Deleção em processamento', 202));
    
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * PATCH /api/v2/doctors/:id/deactivate - Inativar médico (async)
 */
router.patch('/:id/deactivate', auth, async (req, res) => {
  const correlationId = `doc_deact_${Date.now()}_${uuidv4().slice(0, 8)}`;
  
  try {
    const doctorExists = await Doctor.exists({ _id: req.params.id });
    if (!doctorExists) {
      return res.status(404).json(formatError('Médico não encontrado', 404));
    }
    
    const job = await doctorQueue.add(
      'DOCTOR_DEACTIVATE',
      {
        eventType: 'DOCTOR_DEACTIVATE_REQUESTED',
        payload: {
          doctorId: req.params.id,
          deactivatedBy: req.user?.id
        },
        correlationId
      },
      {
        jobId: correlationId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      }
    );
    
    return res.status(202).json(formatSuccess({
      jobId: job.id,
      correlationId,
      status: 'pending'
    }, 'Inativação em processamento', 202));
    
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

/**
 * PATCH /api/v2/doctors/:id/reactivate - Reativar médico (async)
 */
router.patch('/:id/reactivate', auth, async (req, res) => {
  const correlationId = `doc_react_${Date.now()}_${uuidv4().slice(0, 8)}`;
  
  try {
    const doctorExists = await Doctor.exists({ _id: req.params.id });
    if (!doctorExists) {
      return res.status(404).json(formatError('Médico não encontrado', 404));
    }
    
    const job = await doctorQueue.add(
      'DOCTOR_REACTIVATE',
      {
        eventType: 'DOCTOR_REACTIVATE_REQUESTED',
        payload: {
          doctorId: req.params.id,
          reactivatedBy: req.user?.id
        },
        correlationId
      },
      {
        jobId: correlationId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      }
    );
    
    return res.status(202).json(formatSuccess({
      jobId: job.id,
      correlationId,
      status: 'pending'
    }, 'Reativação em processamento', 202));
    
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

// ============================================
// STATUS & MONITORING
// ============================================

/**
 * GET /api/v2/doctors/status/:jobId - Status de job
 */
router.get('/status/:jobId', flexibleAuth, async (req, res) => {
  try {
    const job = await doctorQueue.getJob(req.params.jobId);
    
    if (!job) {
      return res.status(404).json(formatError('Job não encontrado', 404));
    }
    
    const state = await job.getState();
    
    return res.json(formatSuccess({
      jobId: job.id,
      state,
      data: job.data,
      result: job.returnvalue,
      failedReason: job.failedReason,
      processedOn: job.processedOn,
      completedOn: job.completedOn
    }));
    
  } catch (error) {
    return res.status(500).json(formatError(error.message, 500));
  }
});

export default router;
