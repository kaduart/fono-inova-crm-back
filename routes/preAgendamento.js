import express from 'express';
import mongoose from 'mongoose';
import { auth, authorize } from '../middleware/auth.js';
import { agendaAuth } from '../middleware/agendaAuth.js';
import PreAgendamento from '../models/PreAgendamento.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import { bookFixedSlot } from '../services/amandaBookingService.js';
import { findDoctorByName } from '../utils/doctorHelper.js';

const router = express.Router();

/**
 * POST /api/pre-agendamento/webhook
 * Recebe da agenda externa (Firebase) - usa agendaAuth
 */
router.post('/webhook', agendaAuth, async (req, res) => {
  try {
    console.log('[WEBHOOK] Payload recebido:', JSON.stringify(req.body, null, 2));
    
    // Suporta dois formatos de payload:
    // 1. Formato antigo: patientName, patientPhone, preferredDate, etc.
    // 2. Formato agenda externa: patientInfo { fullName, phone }, date, time, etc.
    
    const payload = req.body;
    
    // Extrai dados do paciente (ambos os formatos)
    const patientName = payload.patientName || payload.patientInfo?.fullName;
    const patientPhone = payload.patientPhone || payload.patientInfo?.phone;
    const patientEmail = payload.patientEmail || payload.patientInfo?.email;
    const patientBirthDate = payload.patientBirthDate || payload.patientInfo?.birthDate;
    
    // Extrai datas e horários (ambos os formatos)
    const preferredDate = payload.preferredDate || payload.date;
    const preferredTime = payload.preferredTime || payload.time;
    
    // Outros campos
    const specialty = payload.specialty;
    const professionalName = payload.professionalName;
    const source = payload.source || 'agenda_externa';
    // Suporta externalId, id, ou firebaseAppointmentId (da agenda externa)
    const externalId = payload.externalId || payload.id || payload.firebaseAppointmentId || `ext_${Date.now()}`;
    
    // Validação
    if (!patientName || !patientPhone || !preferredDate) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatórios faltando: patientName/patientInfo.fullName, patientPhone/patientInfo.phone, preferredDate/date',
        received: payload
      });
    }

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
        phone: String(patientPhone).replace(/\D/g, ''),
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

    console.log(`[WEBHOOK] ✅ PreAgendamento criado: ${pre._id} - ${patientName}`);
    
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
 * POST /api/pre-agendamento/:id/importar-externo
 * Importar diretamente pela agenda externa (usa agendaAuth, não JWT)
 * A agenda externa confirma e já converte em Appointment definitivo
 */
router.post('/:id/importar-externo', agendaAuth, async (req, res) => {
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

    console.log(`[IMPORTAR-EXTERNO] Importando pré-agendamento ${id}`);

    // 1. Buscar pré-agendamento
    const pre = await PreAgendamento.findById(id).session(session);
    if (!pre) throw new Error('Pré-agendamento não encontrado');
    if (pre.status === 'importado') {
      return res.json({ success: true, message: 'Já importado', appointmentId: pre.importedToAppointment });
    }

    // 2. Buscar doutor (por ID ou por nome)
    let doctor = null;
    
    if (doctorId) {
      doctor = await Doctor.findById(doctorId).session(session);
    }
    
    // Se não achou por ID, tenta por nome usando o helper existente
    if (!doctor && pre.professionalName) {
      const doctorData = await findDoctorByName(pre.professionalName);
      if (doctorData) {
        doctor = await Doctor.findById(doctorData._id).session(session);
      }
    }
    
    if (!doctor) {
      throw new Error(`Doutor não encontrado. ID: ${doctorId}, Nome: ${pre.professionalName}`);
    }
    
    console.log(`[IMPORTAR-EXTERNO] Doutor encontrado: ${doctor.fullName} (${doctor._id})`);

    // 3. Importar usando bookFixedSlot
    const bookParams = {
      patientInfo: {
        fullName: pre.patientInfo.fullName,
        birthDate: pre.patientInfo.birthDate,
        phone: pre.patientInfo.phone,
        email: pre.patientInfo.email
      },
      doctorId: doctor._id.toString(),  // ✅ Usa o ID do doutor encontrado
      specialty: pre.specialty,
      date,
      time,
      sessionType: serviceType === 'evaluation' ? 'avaliacao' : 'sessao',
      serviceType,
      paymentMethod,
      sessionValue: Number(sessionValue),
      status: 'scheduled',
      notes: `[IMPORTADO DA AGENDA EXTERNA] ${notes || ''}\n${pre.secretaryNotes || ''}`
    };
    
    console.log('[IMPORTAR-EXTERNO] bookFixedSlot params:', JSON.stringify(bookParams, null, 2));
    
    const result = await bookFixedSlot(bookParams);

    if (!result.success) {
      console.error('[IMPORTAR-EXTERNO] bookFixedSlot erro:', result);
      throw new Error(result.error || 'Erro ao criar agendamento');
    }

    // 4. Atualizar pré-agendamento
    pre.status = 'importado';
    pre.importedToAppointment = result.appointment._id;
    pre.importedAt = new Date();
    await pre.save({ session });

    await session.commitTransaction();

    console.log(`[IMPORTAR-EXTERNO] ✅ Importado: ${result.appointment._id}`);

    res.json({
      success: true,
      message: 'Importado com sucesso!',
      appointmentId: result.appointment._id,
      patientId: result.patientId
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('[IMPORTAR-EXTERNO] Erro:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    session.endSession();
  }
});

// Middleware de auth para rotas protegidas (após as rotas públicas)
router.use(auth);

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

    // Se não especificou status, por padrão exclui importados e descartados
    // (só mostra os que precisam de ação)
    if (status) {
      filters.status = status;
    } else {
      filters.status = { $nin: ['importado', 'descartado'] };
    }
    
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
