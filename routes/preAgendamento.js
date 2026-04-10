import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { agendaAuth } from '../middleware/agendaAuth.js';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import { findDoctorByName } from '../utils/doctorHelper.js';
import { getIo } from '../config/socket.js';
import { NON_BLOCKING_OPERATIONAL_STATUSES } from '../constants/appointmentStatus.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

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

    // Classificar se é paciente novo ou recorrente pelo telefone
    let patientType = 'novo';
    if (cleanPhone.length >= 8) {
      const suffix = cleanPhone.slice(-8);
      const hasHistory = await Appointment.exists({
        $or: [
          { 'patientInfo.phone': { $regex: suffix } },
          // patient vinculado: busca via Patient
        ],
        _id: { $ne: _id }
      });
      if (!hasHistory) {
        // Tenta também via Patient vinculado
        const existingPatient = await Patient.findOne({ phone: { $regex: suffix } }).lean();
        if (existingPatient) {
          const hasLinkedHistory = await Appointment.exists({ patient: existingPatient._id, _id: { $ne: _id } });
          if (hasLinkedHistory) patientType = 'recorrente';
        }
      } else {
        patientType = 'recorrente';
      }
    }

    const appointmentData = {
      _id,
      operationalStatus: 'pre_agendado',
      patientType,
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
 * Confirma pré-agendamento vindo da agenda externa (update in-place)
 */
router.post('/:id/importar-externo', agendaAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { doctorId, date, time, sessionValue, serviceType = 'evaluation', paymentMethod = 'pix', notes } = req.body;

    const pre = await Appointment.findById(id);
    if (!pre) return res.status(404).json({ success: false, error: 'Não encontrado' });

    if (['scheduled', 'confirmed', 'paid'].includes(pre.operationalStatus)) {
      return res.json({ success: true, message: 'Já confirmado', appointmentId: pre._id });
    }

    let doctor = null;
    if (doctorId) doctor = await Doctor.findById(doctorId);
    if (!doctor && pre.professionalName) doctor = await findDoctorByName(pre.professionalName);
    if (!doctor) return res.status(404).json({ success: false, error: 'Doutor não encontrado' });

    // Resolver ou criar paciente
    let resolvedPatientId = pre.patient;
    if (!resolvedPatientId && pre.patientInfo?.fullName && pre.patientInfo?.phone) {
      const cleanPhone = pre.patientInfo.phone.replace(/\D/g, '');
      let patient = await Patient.findOne({ phone: { $regex: cleanPhone.slice(-10) } }).lean();
      if (!patient) {
        patient = await Patient.create({
          fullName: pre.patientInfo.fullName,
          phone: cleanPhone,
          email: pre.patientInfo.email || undefined,
          dateOfBirth: pre.patientInfo.birthDate || undefined,
          source: pre.metadata?.origin?.source || 'agenda_externa'
        });
      }
      resolvedPatientId = patient._id;
    }

    const oldStatus = pre.operationalStatus;
    const confirmedDate = date || pre.date;
    const confirmedTime = time || pre.time;
    const confirmedValue = Number(sessionValue || pre.sessionValue || 0);
    const normalizedServiceType = serviceType === 'session' ? 'individual_session' : serviceType;

    // Update in-place — mesmo documento, sem criar duplicata
    pre.patient = resolvedPatientId || pre.patient;
    pre.doctor = doctor._id;
    pre.date = confirmedDate;
    pre.time = confirmedTime;
    pre.sessionValue = confirmedValue;
    pre.serviceType = normalizedServiceType;
    pre.paymentMethod = paymentMethod;
    pre.operationalStatus = 'scheduled';
    pre.notes = notes ? `[AGENDA EXTERNA] ${notes}\n${pre.secretaryNotes || ''}` : pre.notes;
    pre.history.push({
      action: 'convertido_para_agendamento',
      newStatus: 'scheduled',
      timestamp: new Date(),
      context: `De: ${oldStatus} → scheduled via agenda-externa`
    });

    await pre.save({ validateBeforeSave: false });

    // Criar pagamento pendente se houver valor
    if (confirmedValue > 0) {
      await Payment.create({
        patient: resolvedPatientId,
        doctor: doctor._id,
        appointment: pre._id,
        amount: confirmedValue,
        serviceType: normalizedServiceType,
        paymentMethod,
        status: 'pending',
        paymentDate: confirmedDate
      }).catch(() => {});
    }

    try {
      const io = getIo();
      io.emit('appointmentCreated', pre.toObject());
      io.emit('preagendamento:imported', { preAgendamentoId: String(id), appointmentId: pre._id });
    } catch (e) {}

    return res.json({ success: true, appointmentId: pre._id, patientId: resolvedPatientId });

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
      semContato,
      from,
      to,
      phone,
      search,
      page = 1,
      limit = 20
    } = req.query;

    const filters = { operationalStatus: 'pre_agendado' };

    // status override: se passar status explícito, usa ele
    if (status === 'importados') {
      // Appointments originados da agenda externa/amanda que já foram convertidos
      filters.operationalStatus = { $in: ['scheduled', 'confirmed', 'paid'] };
      filters['metadata.origin.source'] = { $in: ['agenda_externa', 'amandaAI'] };
    } else if (status) {
      const statusList = status.split(',').map(s => s.trim());
      filters.operationalStatus = statusList.length > 1 ? { $in: statusList } : status;
    }

    if (specialty) filters.specialty = specialty;
    if (urgency) {
      const urgencies = urgency.split(',').map(u => u.trim());
      filters.urgency = urgencies.length > 1 ? { $in: urgencies } : urgency;
    }
    if (assignedTo) filters.assignedTo = assignedTo;
    if (semContato === '1' || semContato === 'true') filters.attemptCount = 0;

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

    const [porUrgencia, urgentes, semContato, total, porEspecialidade, conversao, porPatientType] = await Promise.all([
      Appointment.aggregate([
        { $match: { operationalStatus: 'pre_agendado' } },
        { $group: { _id: '$urgency', count: { $sum: 1 } } }
      ]),

      Appointment.countDocuments({
        operationalStatus: 'pre_agendado',
        urgency: { $in: ['alta', 'critica'] }
      }),

      Appointment.countDocuments({
        operationalStatus: 'pre_agendado',
        $or: [{ attemptCount: 0 }, { attemptCount: { $exists: false } }]
      }),

      Appointment.countDocuments({ operationalStatus: 'pre_agendado' }),

      Appointment.aggregate([
        { $match: { operationalStatus: 'pre_agendado' } },
        { $group: { _id: '$specialty', count: { $sum: 1 } } }
      ]),

      Appointment.aggregate([
        {
          $match: {
            'metadata.origin.source': { $in: ['agenda_externa', 'amandaAI'] },
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
      ]),

      // Contagem de pacientes por tipo — últimos 30 dias, por createdAt (quando entraram)
      Appointment.aggregate([
        {
          $match: {
            patientType: { $in: ['novo', 'retorno', 'recorrente'] },
            createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          }
        },
        { $group: { _id: '$patientType', count: { $sum: 1 } } }
      ])
    ]);

    const conv = conversao[0] || { total: 0, importados: 0 };
    const porUrgenciaMap = porUrgencia.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {});
    const patientTypeMap = porPatientType.reduce((acc, item) => { acc[item._id] = item.count; return acc; }, {});

    res.json({
      success: true,
      data: {
        porUrgencia: porUrgenciaMap,
        porStatus: porUrgenciaMap, // compat
        urgentes,
        semContato,
        total,
        porEspecialidade,
        conversao: {
          taxa: conv.total > 0 ? Math.round((conv.importados / conv.total) * 100) : 0,
          total: conv.total,
          importados: conv.importados
        },
        // Pacientes por tipo nos últimos 30 dias (apenas importados/confirmados)
        novos: patientTypeMap['novo'] || 0,
        retornos: patientTypeMap['retorno'] || 0,
        recorrentes: patientTypeMap['recorrente'] || 0
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
 * Converte pré-agendamento em agendamento definitivo — update in-place no mesmo documento
 */
router.post('/:id/importar', async (req, res) => {
  const { id } = req.params;
  const {
    doctorId, date, time, sessionValue,
    serviceType = 'evaluation', paymentMethod = 'pix',
    notes, birthDate, phone, email, responsible
  } = req.body;

  try {
    const pre = await Appointment.findById(id);

    if (!pre) return res.status(404).json({ success: false, error: 'Pré-agendamento não encontrado' });

    if (['scheduled', 'confirmed', 'paid'].includes(pre.operationalStatus)) {
      return res.json({ success: true, message: 'Já foi importado anteriormente', appointmentId: pre._id });
    }

    if (pre.operationalStatus !== 'pre_agendado') {
      return res.status(400).json({ success: false, error: `Status inválido para importação: ${pre.operationalStatus}` });
    }

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ success: false, error: 'Doutor não encontrado' });

    // Resolver ou criar paciente com dados atualizados do formulário
    const mergedPhone = (phone || pre.patientInfo?.phone || '').replace(/\D/g, '');
    let resolvedPatientId = pre.patient;
    if (!resolvedPatientId) {
      let patient = await Patient.findOne({ phone: { $regex: mergedPhone.slice(-10) } }).lean();
      if (!patient) {
        patient = await Patient.create({
          fullName: pre.patientInfo?.fullName,
          phone: mergedPhone || undefined,
          email: email || pre.patientInfo?.email || undefined,
          dateOfBirth: birthDate || pre.patientInfo?.birthDate || undefined,
          source: pre.metadata?.origin?.source || 'outro'
        });
        
        // 🚀 Publicar evento para criar a view do paciente (CQRS)
        await publishEvent(EventTypes.PATIENT_CREATED, {
          patientId: patient._id.toString(),
          fullName: patient.fullName,
          phone: patient.phone,
          email: patient.email,
          dateOfBirth: patient.dateOfBirth,
          source: 'agenda_externa'
        });
      }
      resolvedPatientId = patient._id;
    }

    // ── Verificação de conflito de horário ──────────────────────────
    const doctorConflict = await Appointment.findOne({
      doctor: doctor._id,
      date,
      time,
      operationalStatus: { $nin: NON_BLOCKING_OPERATIONAL_STATUSES },
      _id: { $ne: pre._id }
    }).populate('patient', 'fullName').lean();

    if (doctorConflict) {
      return res.status(409).json({
        success: false,
        error: 'Conflito de agenda',
        message: `${doctor.fullName} já tem agendamento neste horário com ${doctorConflict.patient?.fullName || 'outro paciente'}`,
      });
    }
    // ────────────────────────────────────────────────────────────────

    const oldStatus = pre.operationalStatus;
    const confirmedValue = Number(sessionValue) || 0;
    const normalizedServiceType = serviceType === 'session' ? 'individual_session' : serviceType;

    // Update in-place — mesma coleção, mesmo _id, rastreabilidade preservada
    pre.patient = resolvedPatientId;
    pre.doctor = doctor._id;
    pre.date = date;
    pre.time = time;
    pre.sessionValue = confirmedValue;
    pre.serviceType = normalizedServiceType;
    pre.paymentMethod = paymentMethod;
    pre.operationalStatus = 'scheduled';
    if (birthDate) pre.patientInfo = { ...pre.patientInfo?.toObject?.() || pre.patientInfo, birthDate };
    if (phone) pre.patientInfo = { ...pre.patientInfo?.toObject?.() || pre.patientInfo, phone: mergedPhone };
    if (email) pre.patientInfo = { ...pre.patientInfo?.toObject?.() || pre.patientInfo, email };
    if (notes || responsible) {
      pre.notes = [notes, responsible ? `Responsável: ${responsible}` : ''].filter(Boolean).join('\n');
    }
    pre.history.push({
      action: 'convertido_para_agendamento',
      newStatus: 'scheduled',
      changedBy: req.user?._id || undefined,
      timestamp: new Date(),
      context: `De: ${oldStatus} → scheduled`
    });
    pre.metadata = {
      ...pre.metadata?.toObject?.() || pre.metadata || {},
      origin: {
        ...(pre.metadata?.origin?.toObject?.() || pre.metadata?.origin || {}),
        convertedBy: req.user?._id || undefined,
        convertedAt: new Date()
      }
    };

    await pre.save({ validateBeforeSave: false });

    // Criar pagamento pendente se houver valor
    if (confirmedValue > 0) {
      await Payment.create({
        patient: resolvedPatientId,
        doctor: doctor._id,
        appointment: pre._id,
        amount: confirmedValue,
        serviceType: normalizedServiceType,
        paymentMethod,
        status: 'pending',
        paymentDate: date
      }).catch(() => {});
    }

    try {
      const io = getIo();
      io.emit('preagendamento:confirmed', { id: String(id), appointmentId: pre._id });
      io.emit('appointmentCreated', pre.toObject());
    } catch (e) {}

    res.json({
      success: true,
      message: 'Importado com sucesso!',
      appointmentId: pre._id,
      patientId: resolvedPatientId
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

export default router;
