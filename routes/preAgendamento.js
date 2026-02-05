import express from 'express';
import mongoose from 'mongoose';
import { auth, authorize } from '../middleware/auth.js';
import PreAgendamento from '../models/PreAgendamento.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import { bookFixedSlot } from '../services/amandaBookingService.js';

const router = express.Router();

// Todas as rotas protegidas
router.use(auth);

/**
 * POST /api/pre-agendamento/webhook
 * Recebe da agenda externa (Firebase) - pode ter auth específica
 */
router.post('/webhook', async (req, res) => {
  try {
    const {
      externalId,
      patientName,
      patientPhone,
      patientEmail,
      patientBirthDate,
      specialty,
      preferredDate,
      preferredTime,
      professionalName,
      source = 'agenda_externa'
    } = req.body;

    // Verificar se já existe
    const existe = await PreAgendamento.findOne({ externalId });
    if (existe) {
      return res.json({ success: true, message: 'Já existe', id: existe._id });
    }

    // Buscar paciente existente
    const patient = await Patient.findOne({
      $or: [
        { phone: patientPhone?.replace(/\D/g, '') },
        { email: patientEmail }
      ]
    });

    // Criar pré-agendamento
    const pre = await PreAgendamento.create({
      source,
      externalId,
      patientInfo: {
        fullName: patientName,
        phone: patientPhone?.replace(/\D/g, ''),
        email: patientEmail,
        birthDate: patientBirthDate
      },
      patientId: patient?._id,
      specialty: specialty?.toLowerCase(),
      preferredDate,
      preferredTime,
      professionalName,
      status: 'novo'
    });

    res.status(201).json({
      success: true,
      id: pre._id,
      message: 'Pré-agendamento recebido',
      urgency: pre.urgency
    });

  } catch (error) {
    console.error('[PRE-AGENDAMENTO WEBHOOK] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pre-agendamento
 * Lista para a secretária (com filtros e paginação)
 */
router.get('/', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const {
      status,
      specialty,
      urgency,
      assignedTo,
      from,
      to,
      page = 1,
      limit = 20
    } = req.query;

    const filters = {};

    if (status) filters.status = status;
    if (specialty) filters.specialty = specialty;
    if (urgency) filters.urgency = urgency;
    if (assignedTo) filters.assignedTo = assignedTo;

    // Filtro de data
    if (from && to) {
      filters.preferredDate = { $gte: from, $lte: to };
    } else if (from) {
      filters.preferredDate = { $gte: from };
    } else if (to) {
      filters.preferredDate = { $lte: to };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [preAgendamentos, total, resumo] = await Promise.all([
      PreAgendamento.find(filters)
        .populate('patientId', 'fullName phone')
        .populate('assignedTo', 'fullName')
        .sort({ urgency: -1, preferredDate: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),

      PreAgendamento.countDocuments(filters),

      PreAgendamento.aggregate([
        { $match: { status: { $ne: 'importado' } } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    // Estatísticas por urgência
    const urgencias = await PreAgendamento.aggregate([
      { $match: { status: { $nin: ['importado', 'descartado'] } } },
      {
        $group: {
          _id: '$urgency',
          count: { $sum: 1 }
        }
      }
    ]);

    res.json({
      success: true,
      data: preAgendamentos,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      resumo: {
        porStatus: resumo.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        porUrgencia: urgencias.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {})
      }
    });

  } catch (error) {
    console.error('Erro ao listar pré-agendamentos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pre-agendamento/:id
 * Detalhes de um pré-agendamento
 */
router.get('/:id', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const pre = await PreAgendamento.findById(req.params.id)
      .populate('patientId')
      .populate('assignedTo', 'fullName')
      .populate('importedToAppointment')
      .populate('contactAttempts.madeBy', 'fullName');

    if (!pre) {
      return res.status(404).json({ success: false, error: 'Não encontrado' });
    }

    // Buscar médicos disponíveis para a especialidade
    const doctors = await Doctor.find({
      specialty: pre.specialty,
      active: true
    }).select('fullName specialty');

    res.json({
      success: true,
      data: pre,
      availableDoctors: doctors
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/assign
 * Atribuir a um usuário
 */
router.post('/:id/assign', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { userId } = req.body;

    const pre = await PreAgendamento.findByIdAndUpdate(
      req.params.id,
      {
        assignedTo: userId || req.user.id,
        status: 'em_analise',
        updatedAt: new Date()
      },
      { new: true }
    );

    res.json({ success: true, data: pre });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/contact
 * Registrar tentativa de contato
 */
router.post('/:id/contact', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { channel, success, notes } = req.body;

    const pre = await PreAgendamento.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          contactAttempts: {
            date: new Date(),
            channel,
            success,
            notes,
            madeBy: req.user.id
          }
        },
        $inc: { attemptCount: 1 },
        status: success ? 'contatado' : 'em_analise',
        updatedAt: new Date()
      },
      { new: true }
    );

    res.json({ success: true, data: pre });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/importar
 * Converter para Appointment definitivo
 */
router.post('/:id/importar', authorize(['admin', 'secretary']), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const {
      doctorId,
      date,
      time,
      sessionValue,
      serviceType = 'evaluation',
      paymentMethod = 'pix',
      notes
    } = req.body;

    // 1. Buscar pré-agendamento
    const pre = await PreAgendamento.findById(id).session(session);
    if (!pre) throw new Error('Pré-agendamento não encontrado');
    if (pre.status === 'importado') throw new Error('Já foi importado');

    // 2. Buscar doutor
    const doctor = await Doctor.findById(doctorId).session(session);
    if (!doctor) throw new Error('Doutor não encontrado');

    // 3. Importar usando bookFixedSlot
    const result = await bookFixedSlot({
      patientInfo: {
        fullName: pre.patientInfo.fullName,
        birthDate: pre.patientInfo.birthDate,
        phone: pre.patientInfo.phone,
        email: pre.patientInfo.email
      },
      doctorId,
      specialty: pre.specialty,
      date,
      time,
      sessionType: serviceType === 'evaluation' ? 'avaliacao' : 'sessao',
      serviceType,
      paymentMethod,
      sessionValue: Number(sessionValue),
      status: 'scheduled',
      notes: `[IMPORTADO DO PRE-AGENDAMENTO] ${notes || ''}\n${pre.secretaryNotes || ''}`
    });

    if (!result.success) {
      throw new Error(result.error || 'Erro ao criar agendamento');
    }

    // 4. Atualizar pré-agendamento
    pre.status = 'importado';
    pre.importedToAppointment = result.appointment._id;
    pre.importedAt = new Date();
    pre.importedBy = req.user.id;
    await pre.save({ session });

    await session.commitTransaction();

    res.json({
      success: true,
      message: 'Importado com sucesso!',
      appointmentId: result.appointment._id,
      patientId: result.patientId
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Erro ao importar:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    session.endSession();
  }
});

/**
 * POST /api/pre-agendamento/:id/descartar
 * Descartar pré-agendamento
 */
router.post('/:id/descartar', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { reason } = req.body;

    const pre = await PreAgendamento.findByIdAndUpdate(
      req.params.id,
      {
        status: 'descartado',
        discardReason: reason,
        discardedAt: new Date(),
        discardedBy: req.user.id,
        updatedAt: new Date()
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Descartado com sucesso',
      data: pre
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/pre-agendamento/:id
 * Atualizar dados do pré-agendamento
 */
router.patch('/:id', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const updates = req.body;
    delete updates.status; // Não permitir mudar status diretamente
    delete updates.importedToAppointment;

    const pre = await PreAgendamento.findByIdAndUpdate(
      req.params.id,
      { ...updates, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    res.json({ success: true, data: pre });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pre-agendamento/stats/dashboard
 * Estatísticas para dashboard
 */
router.get('/stats/dashboard', authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];

    const stats = await Promise.all([
      // Total por status
      PreAgendamento.aggregate([
        { $match: { status: { $ne: 'importado' } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),

      // Urgentes (próximos 2 dias)
      PreAgendamento.countDocuments({
        status: { $nin: ['importado', 'descartado'] },
        preferredDate: { $gte: hoje },
        $or: [
          { urgency: 'alta' },
          { urgency: 'critica' }
        ]
      }),

      // Por especialidade
      PreAgendamento.aggregate([
        { $match: { status: { $nin: ['importado', 'descartado'] } } },
        { $group: { _id: '$specialty', count: { $sum: 1 } } }
      ]),

      // Taxa de conversão (últimos 30 dias)
      PreAgendamento.aggregate([
        {
          $match: {
            createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            importados: {
              $sum: { $cond: [{ $eq: ['$status', 'importado'] }, 1, 0] }
            }
          }
        }
      ])
    ]);

    const conversao = stats[3][0] || { total: 0, importados: 0 };

    res.json({
      success: true,
      data: {
        porStatus: stats[0].reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        urgentes: stats[1],
        porEspecialidade: stats[2],
        conversao: {
          taxa: conversao.total > 0 ? Math.round((conversao.importados / conversao.total) * 100) : 0,
          total: conversao.total,
          importados: conversao.importados
        }
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
