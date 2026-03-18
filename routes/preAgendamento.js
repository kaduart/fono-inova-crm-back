import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { agendaAuth } from '../middleware/agendaAuth.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import { bookFixedSlot } from '../services/amandaBookingService.js';
import { findDoctorByName } from '../utils/doctorHelper.js';
import { getIo } from '../config/socket.js';

const router = express.Router();

/**
 * POST /api/pre-agendamento/webhook
 * Recebe da agenda externa — cria Appointment com operationalStatus: 'pre_agendado'
 */
router.post('/webhook', agendaAuth, async (req, res) => {
  try {
    const payload = req.body;
    const {
      _id,
      patientInfo,
      preferredDate,
      preferredTime,
      specialty,
      professionalName,
      professionalId: payloadProfessionalId,
      doctorId,
      source = 'agenda_externa'
    } = payload;

    if (!_id || !patientInfo?.fullName || !patientInfo?.phone || !preferredDate) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatórios: _id, patientInfo.fullName, patientInfo.phone, preferredDate',
        received: payload
      });
    }

    // Verificar se já existe
    const existe = await Appointment.findById(_id);
    if (existe) {
      return res.json({ success: true, message: 'Já existe', id: existe._id });
    }

    // Determinar doctor
    const resolvedDoctorId = payloadProfessionalId || doctorId;
    let doctor = null;
    if (resolvedDoctorId && mongoose.Types.ObjectId.isValid(resolvedDoctorId)) {
      doctor = await Doctor.findById(resolvedDoctorId);
    }
    if (!doctor && professionalName) {
      doctor = await findDoctorByName(professionalName);
    }

    const cleanPhone = (patientInfo.phone || '').replace(/\D/g, '');
    const appointmentData = {
      _id,
      operationalStatus: 'pre_agendado',
      patientInfo: {
        fullName: patientInfo.fullName,
        phone: cleanPhone,
        email: patientInfo.email,
        birthDate: patientInfo.birthDate
      },
      specialty: (specialty || doctor?.specialty || 'fonoaudiologia').toLowerCase(),
      date: preferredDate,
      time: preferredTime,
      professionalName,
      doctor: doctor?._id || undefined,
      metadata: { origin: { source } }
    };

    const appointment = await Appointment.create(appointmentData);

    try {
      const io = getIo();
      io.emit('preagendamento:new', {
        id: String(appointment._id),
        patientName: appointment.patientInfo.fullName,
        phone: appointment.patientInfo.phone,
        specialty: appointment.specialty,
        preferredDate: appointment.date,
        operationalStatus: 'pre_agendado',
        urgency: appointment.urgency,
        createdAt: appointment.createdAt
      });
    } catch (e) {}

    return res.status(201).json({
      success: true,
      message: 'Pré-agendamento criado',
      id: appointment._id
    });

  } catch (error) {
    console.error('[WEBHOOK] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/importar-externo
 * Confirma pré-agendamento vindo da agenda externa
 */
router.post('/:id/importar-externo', agendaAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { doctorId, date, time, sessionValue, serviceType = 'evaluation', paymentMethod = 'pix', notes } = req.body;

    const pre = await Appointment.findById(id).lean();
    if (!pre) return res.status(404).json({ success: false, error: 'Não encontrado' });

    if (['scheduled', 'confirmed', 'paid'].includes(pre.operationalStatus)) {
      return res.json({ success: true, message: 'Já confirmado', appointmentId: pre._id });
    }

    let doctor = null;
    if (doctorId) doctor = await Doctor.findById(doctorId);
    if (!doctor && pre.professionalName) doctor = await findDoctorByName(pre.professionalName);
    if (!doctor) return res.status(404).json({ success: false, error: 'Doutor não encontrado' });

    const normalizedServiceType = serviceType === 'session' ? 'individual_session' : serviceType;
    const result = await bookFixedSlot({
      patientInfo: pre.patientInfo,
      doctorId: doctor._id.toString(),
      specialty: pre.specialty,
      date: date || pre.date,
      time: time || pre.time,
      sessionType: serviceType === 'evaluation' ? 'avaliacao' : 'sessao',
      serviceType: normalizedServiceType,
      paymentMethod,
      sessionValue: Number(sessionValue || pre.sessionValue || 0),
      status: 'scheduled',
      notes: `[IMPORTADO DA AGENDA EXTERNA] ${notes || ''}\n${pre.secretaryNotes || ''}`
    });

    if (!result.success) return res.status(400).json({ success: false, error: result.error });

    await Appointment.findByIdAndDelete(id);

    try {
      const io = getIo();
      io.emit('appointmentCreated', result.appointment);
      io.emit('preagendamento:imported', { preAgendamentoId: String(id), appointmentId: result.appointment._id });
    } catch (e) {}

    return res.json({ success: true, appointmentId: result.appointment._id, patientId: result.patientId });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pre-agendamento
 * Lista Appointments com operationalStatus: 'pre_agendado'
 */
router.get('/', async (req, res) => {
  try {
    const {
      status,
      specialty,
      urgency,
      assignedTo,
      from,
      to,
      phone,
      search,
      page = 1,
      limit = 20
    } = req.query;

    const filters = { operationalStatus: 'pre_agendado' };

    // status override: se passar status explícito, usa ele
    if (status) {
      const statusList = status.split(',').map(s => s.trim());
      filters.operationalStatus = statusList.length > 1 ? { $in: statusList } : status;
    }

    if (specialty) filters.specialty = specialty;
    if (urgency) filters.urgency = urgency;
    if (assignedTo) filters.assignedTo = assignedTo;

    if (phone) {
      const cleanPhone = phone.replace(/\D/g, '');
      filters['patientInfo.phone'] = { $regex: cleanPhone };
    }

    if (search) {
      const regex = { $regex: search, $options: 'i' };
      filters.$or = [
        { 'patientInfo.fullName': regex },
        { 'patientInfo.phone': { $regex: search.replace(/\D/g, '') || search } },
        { professionalName: regex }
      ];
    }

    if (from && to) {
      filters.date = { $gte: from, $lte: to };
    } else if (from) {
      filters.date = { $gte: from };
    } else if (to) {
      filters.date = { $lte: to };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [preAgendamentos, total, resumo, urgencias] = await Promise.all([
      Appointment.find(filters)
        .populate('patient', 'fullName phone')
        .populate('doctor', 'fullName specialty')
        .populate('assignedTo', 'fullName')
        .sort({ urgency: -1, date: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),

      Appointment.countDocuments(filters),

      Appointment.aggregate([
        { $match: { operationalStatus: 'pre_agendado' } },
        { $group: { _id: '$urgency', count: { $sum: 1 } } }
      ]),

      Appointment.aggregate([
        { $match: { operationalStatus: 'pre_agendado' } },
        { $group: { _id: '$specialty', count: { $sum: 1 } } }
      ])
    ]);

    // Compatibilidade: adicionar aliases de campo para o frontend antigo
    const data = preAgendamentos.map(a => ({
      ...a,
      patientName: a.patient?.fullName || a.patientInfo?.fullName || '',
      preferredDate: a.date,
      preferredTime: a.time,
      status: a.operationalStatus,
      patientId: a.patient,
      professionalId: a.doctor,
      suggestedValue: a.sessionValue
    }));

    res.json({
      success: true,
      data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      resumo: {
        porUrgencia: resumo.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {}),
        porEspecialidade: urgencias.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {})
      }
    });

  } catch (error) {
    console.error('Erro ao listar pré-agendamentos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pre-agendamento/stats/dashboard
 */
router.get('/stats/dashboard', async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];

    const [porUrgencia, urgentes, porEspecialidade, conversao] = await Promise.all([
      Appointment.aggregate([
        { $match: { operationalStatus: 'pre_agendado' } },
        { $group: { _id: '$urgency', count: { $sum: 1 } } }
      ]),

      Appointment.countDocuments({
        operationalStatus: 'pre_agendado',
        date: { $gte: hoje },
        urgency: { $in: ['alta', 'critica'] }
      }),

      Appointment.aggregate([
        { $match: { operationalStatus: 'pre_agendado' } },
        { $group: { _id: '$specialty', count: { $sum: 1 } } }
      ]),

      Appointment.aggregate([
        {
          $match: {
            'metadata.origin.source': 'agenda_externa',
            createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            importados: {
              $sum: { $cond: [{ $in: ['$operationalStatus', ['scheduled', 'confirmed', 'paid']] }, 1, 0] }
            }
          }
        }
      ])
    ]);

    const conv = conversao[0] || { total: 0, importados: 0 };

    res.json({
      success: true,
      data: {
        porStatus: porUrgencia.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {}),
        urgentes,
        porEspecialidade,
        conversao: {
          taxa: conv.total > 0 ? Math.round((conv.importados / conv.total) * 100) : 0,
          total: conv.total,
          importados: conv.importados
        }
      }
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pre-agendamento/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const pre = await Appointment.findById(req.params.id)
      .populate('patient', 'fullName phone dateOfBirth')
      .populate('doctor', 'fullName specialty')
      .populate('assignedTo', 'fullName')
      .lean();

    if (!pre) return res.status(404).json({ success: false, error: 'Não encontrado' });

    const doctors = await Doctor.find({ specialty: pre.specialty, active: true }).select('fullName specialty');

    res.json({
      success: true,
      data: {
        ...pre,
        patientName: pre.patient?.fullName || pre.patientInfo?.fullName || '',
        preferredDate: pre.date,
        preferredTime: pre.time,
        status: pre.operationalStatus,
        patientId: pre.patient,
        professionalId: pre.doctor,
        suggestedValue: pre.sessionValue
      },
      availableDoctors: doctors
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/assign
 */
router.post('/:id/assign', async (req, res) => {
  try {
    const { userId } = req.body;
    const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
    const assignedUserId = (userId && isValidObjectId(userId)) ? userId :
      (isValidObjectId(req.user?.id) ? req.user.id : null);

    const pre = await Appointment.findByIdAndUpdate(
      req.params.id,
      { assignedTo: assignedUserId, updatedAt: new Date() },
      { new: true }
    );

    try {
      getIo().emit('preagendamento:updated', { id: String(pre._id), operationalStatus: pre.operationalStatus, action: 'assigned' });
    } catch (e) {}

    res.json({ success: true, data: pre });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/contact
 */
router.post('/:id/contact', async (req, res) => {
  try {
    const { channel, success, notes } = req.body;
    const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
    const madeByUserId = isValidObjectId(req.user?.id) ? req.user.id : null;

    const pre = await Appointment.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          contactAttempts: {
            date: new Date(),
            channel,
            success: !!success,
            notes,
            madeBy: madeByUserId
          }
        },
        $inc: { attemptCount: 1 },
        updatedAt: new Date()
      },
      { new: true }
    );

    try {
      getIo().emit('preagendamento:contact', { id: String(pre._id), attemptCount: pre.attemptCount });
    } catch (e) {}

    res.json({ success: true, data: pre });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/importar
 * Converter pré-agendamento em Appointment definitivo (Session + Payment)
 */
router.post('/:id/importar', async (req, res) => {
  const { id } = req.params;
  const {
    doctorId, date, time, sessionValue,
    serviceType = 'evaluation', paymentMethod = 'pix',
    notes, birthDate, phone, email, responsible
  } = req.body;

  try {
    const pre = await Appointment.findById(id).lean();

    if (!pre) return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });

    if (['scheduled', 'confirmed', 'paid'].includes(pre.operationalStatus)) {
      return res.json({ success: true, message: 'Já foi importado anteriormente', appointmentId: pre._id });
    }

    if (pre.operationalStatus !== 'pre_agendado') {
      return res.status(400).json({ success: false, error: `Status inválido para importação: ${pre.operationalStatus}` });
    }

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ success: false, error: 'Doutor não encontrado' });

    // Mesclar dados atualizados do formulário
    const patientInfo = {
      fullName: pre.patientInfo?.fullName,
      birthDate: birthDate || pre.patientInfo?.birthDate,
      phone: phone || pre.patientInfo?.phone,
      email: email || pre.patientInfo?.email
    };

    const result = await bookFixedSlot({
      patientInfo,
      doctorId,
      specialty: pre.specialty,
      date,
      time,
      sessionType: serviceType === 'evaluation' ? 'avaliacao' : 'sessao',
      serviceType,
      paymentMethod,
      sessionValue: Number(sessionValue),
      operationalStatus: 'scheduled',
      notes: `[IMPORTADO DO PRE-AGENDAMENTO] ${notes || ''}\n${pre.secretaryNotes || ''}`,
      source: pre.metadata?.origin?.source || 'outro'
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error || 'Erro ao criar agendamento' });
    }

    // Deletar o pré-agendamento original (agora existe o appointment real)
    await Appointment.findByIdAndDelete(id);

    try {
      const io = getIo();
      io.emit('preagendamento:confirmed', { id: String(id), appointmentId: result.appointment._id });
      io.emit('appointmentCreated', result.appointment);
    } catch (e) {}

    res.json({
      success: true,
      message: 'Importado com sucesso!',
      appointmentId: result.appointment._id,
      patientId: result.patientId
    });

  } catch (error) {
    console.error('[IMPORTAR] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/cancelar
 */
router.post('/:id/cancelar', async (req, res) => {
  try {
    const pre = await Appointment.findByIdAndUpdate(
      req.params.id,
      { operationalStatus: 'canceled' },
      { new: true }
    );

    if (!pre) return res.status(404).json({ success: false, error: 'Não encontrado' });

    try {
      const io = getIo();
      io.emit('preagendamento:updated', { id: String(pre._id), status: 'cancelado' });
      io.emit('preagendamento:discarded', { id: String(pre._id), status: 'cancelado' });
    } catch (e) {}

    res.json({ success: true, message: 'Pré-agendamento cancelado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/descartar
 */
router.post('/:id/descartar', async (req, res) => {
  try {
    const { reason } = req.body;
    const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

    const pre = await Appointment.findByIdAndUpdate(
      req.params.id,
      {
        operationalStatus: 'canceled',
        discardReason: reason,
        discardedAt: new Date(),
        discardedBy: (req.user?.id && isValidObjectId(req.user.id)) ? req.user.id : undefined
      },
      { new: true }
    );

    res.json({ success: true, message: 'Descartado com sucesso', data: pre });

    try {
      getIo().emit('preagendamento:discarded', { id: String(pre._id), reason });
    } catch (e) {}

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/pre-agendamento/:id
 */
router.patch('/:id', async (req, res) => {
  try {
    const updates = req.body;
    // Mapear campos do formato antigo para o novo
    if (updates.preferredDate) { updates.date = updates.preferredDate; delete updates.preferredDate; }
    if (updates.preferredTime) { updates.time = updates.preferredTime; delete updates.preferredTime; }
    if (updates.status) { updates.operationalStatus = updates.status; delete updates.status; }
    if (updates.suggestedValue !== undefined) { updates.sessionValue = updates.suggestedValue; delete updates.suggestedValue; }

    const pre = await Appointment.findByIdAndUpdate(
      req.params.id,
      { ...updates, updatedAt: new Date() },
      { new: true, runValidators: false }
    );

    res.json({ success: true, data: pre });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/migrar-novos
 * Migra PreAgendamentos com status 'novo' (e similares) para Appointments com operationalStatus 'pre_agendado'
 * Idempotente: pula se já existe Appointment com mesmo _id
 */
router.post('/migrar-novos', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const preAgs = await db.collection('preagendamentos')
      .find({ status: { $in: ['novo', 'em_analise', 'contatado', 'confirmado'] } })
      .toArray();

    const results = { migrated: 0, skipped: 0, errors: [] };

    for (const pre of preAgs) {
      try {
        const exists = await Appointment.findById(pre._id);
        if (exists) { results.skipped++; continue; }

        await Appointment.create({
          _id: pre._id,
          operationalStatus: 'pre_agendado',
          patientInfo: pre.patientInfo,
          patient: (pre.patientId && mongoose.Types.ObjectId.isValid(pre.patientId)) ? pre.patientId : undefined,
          specialty: pre.specialty,
          date: pre.preferredDate,
          time: pre.preferredTime,
          preferredPeriod: pre.preferredPeriod,
          professionalName: pre.professionalName,
          doctor: (pre.professionalId && mongoose.Types.ObjectId.isValid(pre.professionalId)) ? pre.professionalId : undefined,
          serviceType: pre.serviceType,
          sessionValue: pre.suggestedValue || 0,
          urgency: pre.urgency || 'media',
          assignedTo: (pre.assignedTo && mongoose.Types.ObjectId.isValid(pre.assignedTo)) ? pre.assignedTo : undefined,
          contactAttempts: pre.contactAttempts || [],
          attemptCount: pre.attemptCount || 0,
          secretaryNotes: pre.secretaryNotes,
          expiresAt: pre.expiresAt,
          metadata: { origin: { source: pre.source || 'agenda_externa' } },
          createdAt: pre.createdAt,
          updatedAt: pre.updatedAt
        });
        results.migrated++;
      } catch (err) {
        results.errors.push({ id: String(pre._id), error: err.message });
      }
    }

    res.json({ success: true, total: preAgs.length, ...results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
