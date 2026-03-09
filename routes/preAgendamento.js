import express from 'express';
import mongoose from 'mongoose';
import { auth, authorize } from '../middleware/auth.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { agendaAuth } from '../middleware/agendaAuth.js';
import PreAgendamento from '../models/PreAgendamento.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import Notification from '../models/Notification.js';
import { bookFixedSlot } from '../services/amandaBookingService.js';
import { findDoctorByName } from '../utils/doctorHelper.js';
import { getIo } from '../config/socket.js';
import { isBusinessHours } from '../utils/businessHours.js';

const router = express.Router();

/**
 * POST /api/pre-agendamento/webhook
 * Recebe da agenda externa - usa agendaAuth
 */
router.post('/webhook', agendaAuth, async (req, res) => {
  try {
    console.log('[WEBHOOK] Payload recebido:', JSON.stringify(req.body, null, 2));

    // Suporta dois formatos de payload:
    // 1. Formato antigo: patientName, patientPhone, preferredDate, etc.
    // 2. Formato agenda externa: patientInfo { fullName, phone }, date, time, etc.

    const payload = req.body;

    // Dados direto no formato MongoDB (sem conversões!)
    const { 
      _id, 
      patientInfo, 
      preferredDate, 
      preferredTime, 
      specialty, 
      professionalName, 
      professionalId: payloadProfessionalId,  // ← ID do médico vindo da agenda externa (mesmo ID do CRM!)
      doctorId,  // ← Alternativa: agenda externa pode enviar como doctorId
      source = 'agenda_externa' 
    } = payload;

    // Validação simples
    if (!_id || !patientInfo?.fullName || !patientInfo?.phone || !preferredDate) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatórios: _id, patientInfo.fullName, patientInfo.phone, preferredDate',
        received: payload
      });
    }

    // Verificar se já existe
    const existe = await PreAgendamento.findById(_id);
    if (existe) {
      return res.json({ success: true, message: 'Já existe', id: existe._id });
    }

    // 🔍 Determinar o professionalId
    // Prioridade: 1) doctorId do payload, 2) professionalId do payload, 3) busca pelo nome
    let professionalId = null;
    
    if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
      // ✅ Agenda externa enviou o ID do médico (mesmo ID do CRM)
      professionalId = new mongoose.Types.ObjectId(doctorId);
      console.log(`[WEBHOOK] ✅ Usando doctorId do payload: ${professionalId}`);
    } else if (payloadProfessionalId && mongoose.Types.ObjectId.isValid(payloadProfessionalId)) {
      // ✅ Alternativa: professionalId no payload
      professionalId = new mongoose.Types.ObjectId(payloadProfessionalId);
      console.log(`[WEBHOOK] ✅ Usando professionalId do payload: ${professionalId}`);
    } else if (professionalName) {
      // 🔍 Fallback: buscar pelo nome (para compatibilidade)
      try {
        const doctorData = await findDoctorByName(professionalName);
        if (doctorData) {
          professionalId = doctorData._id;
          console.log(`[WEBHOOK] 🔍 Doutor encontrado por nome: ${professionalName} → ${professionalId}`);
        }
      } catch (err) {
        console.log(`[WEBHOOK] ⚠️ Não encontrou doutor: ${professionalName}`);
      }
    }

    // Criar pré-agendamento direto (mesmo ID da agenda externa)
    const pre = await PreAgendamento.create({
      _id,
      source,
      patientInfo: {
        fullName: patientInfo.fullName,
        phone: String(patientInfo.phone).replace(/\D/g, ''),
        email: patientInfo.email,
        birthDate: patientInfo.birthDate
      },
      specialty: specialty?.toLowerCase(),
      preferredDate,
      preferredTime,
      professionalName,
      professionalId,  // ← Agora com o ID do médico!
      status: 'novo'
    });

    console.log(`[WEBHOOK] ✅ PreAgendamento criado: ${pre._id} - ${patientInfo.fullName} (Profissional: ${professionalId || 'N/A'})`);

    // 🔔 SISTEMA DE NOTIFICAÇÃO INTELIGENTE
    const businessHours = isBusinessHours();
    console.log(`[WEBHOOK] Horário comercial: ${businessHours ? 'SIM' : 'NÃO (fora do horário)'}`);

    try {
      const io = getIo();

      if (businessHours) {
        // 🟢 HORÁRIO COMERCIAL: Emite socket em tempo real
        console.log("📡 Emitindo socket em tempo real (horário comercial)...");
        io.emit("preagendamento:new", {
          id: String(pre._id),
          patientName: pre.patientInfo.fullName,
          phone: pre.patientInfo.phone,
          specialty: pre.specialty,
          preferredDate: pre.preferredDate,
          preferredTime: pre.preferredTime,
          status: pre.status,
          urgency: pre.urgency,
          createdAt: pre.createdAt,
          isBusinessHours: true
        });
        console.log(`✅ Socket emitido: preagendamento:new ${pre._id}`);
      } else {
        // 🔴 FORA DO HORÁRIO: Cria notificação persistente
        console.log("🔔 Criando notificação persistente (fora do horário)...");

        const notification = await Notification.createFromPreAgendamento(pre);

        // Emite apenas para usuários online (silencioso)
        io.emit("notification:new", {
          id: String(notification._id),
          type: 'preagendamento',
          data: notification.data,
          priority: notification.priority,
          isBusinessHours: false,
          message: 'Novo pré-agendamento (fora do horário comercial)'
        });

        console.log(`✅ Notificação criada: ${notification._id}`);
      }
    } catch (error) {
      console.error('⚠️ Erro no sistema de notificação:', error.message);
      // Não falha a requisição se notificação falhar
    }

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
      operationalStatus: 'scheduled',
      notes: `[IMPORTADO DA AGENDA EXTERNA] ${notes || ''}\n${pre.secretaryNotes || ''}`,
      source: pre.source || 'agenda_externa', // 📈 ROI
      preAgendamentoId: String(pre._id) // 📈 ROI
    };

    console.log('[IMPORTAR-EXTERNO] bookFixedSlot params:', JSON.stringify(bookParams, null, 2));

    const result = await bookFixedSlot(bookParams);
    
    console.log(`[IMPORTAR-EXTERNO] 📊 Resultado bookFixedSlot:`, {
      success: result.success,
      appointmentId: result.appointment?._id,
      paymentId: result.payment?._id,
      hasPayment: !!result.payment,
      patientId: result.patientId
    });

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

    console.log(`[IMPORTAR-EXTERNO] ✅ Importado: ${result.appointment._id} com payment: ${result.payment?._id || 'SEM PAYMENT'}`);

    // ✅ EMITIR SOCKET
    try {
      const io = getIo();
      io.emit("preagendamento:imported", {
        preAgendamentoId: id,
        appointmentId: result.appointment._id,
        patientId: result.patientId,
        timestamp: new Date()
      });
    } catch (socketError) {
      console.error('⚠️ Erro ao emitir socket:', socketError.message);
    }

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
// Mudando para flexibleAuth para permitir acesso via AGENDA_EXPORT_TOKEN
router.use(flexibleAuth);

/**
 * GET /api/pre-agendamento
 * Lista para a secretária (com filtros e paginação)
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
      page = 1,
      limit = 20
    } = req.query;

    const filters = {};

    // Se não especificou status, por padrão exclui importados e descartados
    // (só mostra os que precisam de ação)
    if (status) {
      // Suporta múltiplos status separados por vírgula
      const statusList = status.split(',').map(s => s.trim());
      filters.status = statusList.length > 1 ? { $in: statusList } : status;
    } else {
      filters.status = { $nin: ['importado', 'descartado'] };
    }

    if (specialty) filters.specialty = specialty;
    if (urgency) filters.urgency = urgency;
    if (assignedTo) filters.assignedTo = assignedTo;
    
    // 🆕 Filtro por telefone (para o chat)
    if (req.query.phone) {
      const phone = req.query.phone.replace(/\D/g, '');
      filters['patientInfo.phone'] = { $regex: phone };
    }

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
router.get('/:id', async (req, res) => {
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
router.post('/:id/assign', async (req, res) => {
  try {
    const { userId } = req.body;

    // Verifica se é um ObjectId válido (usuário real) ou token de serviço
    const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
    const assignedUserId = (userId && isValidObjectId(userId)) ? userId :
      (isValidObjectId(req.user?.id) ? req.user.id : null);

    const pre = await PreAgendamento.findByIdAndUpdate(
      req.params.id,
      {
        assignedTo: assignedUserId,
        status: 'em_analise',
        updatedAt: new Date()
      },
      { new: true }
    );

    // ✅ EMITIR SOCKET
    try {
      const io = getIo();
      io.emit("preagendamento:updated", {
        id: String(pre._id),
        status: pre.status,
        assignedTo: pre.assignedTo?.fullName || req.user?.fullName || 'Sistema',
        action: 'assigned'
      });
    } catch (e) {
      console.error('⚠️ Socket error:', e.message);
    }

    res.json({ success: true, data: pre });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/contact
 * Registrar tentativa de contato
 */
router.post('/:id/contact', async (req, res) => {
  try {
    const { channel, success, notes } = req.body;

    // Verifica se é um ObjectId válido
    const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
    const madeByUserId = isValidObjectId(req.user?.id) ? req.user.id : null;

    const pre = await PreAgendamento.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          contactAttempts: {
            date: new Date(),
            channel,
            success,
            notes,
            madeBy: madeByUserId
          }
        },
        $inc: { attemptCount: 1 },
        status: success ? 'contatado' : 'em_analise',
        updatedAt: new Date()
      },
      { new: true }
    );

    // ✅ EMITIR SOCKET
    try {
      const io = getIo();
      io.emit("preagendamento:contact", {
        id: String(pre._id),
        attemptCount: pre.attemptCount,
        status: pre.status,
        lastContact: new Date()
      });
    } catch (e) {
      console.error('⚠️ Socket error:', e.message);
    }

    res.json({ success: true, data: pre });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pre-agendamento/:id/importar
 * Converter para Appointment definitivo
 */
router.post('/:id/importar', async (req, res) => {
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
      notes,
      // Dados do paciente que podem vir do frontend
      birthDate,
      phone,
      email,
      responsible
    } = req.body;

    console.log('[IMPORTAR] Dados recebidos do frontend:', { 
      birthDate, phone, email, responsible,
      body: req.body 
    });

    // 1. Buscar pré-agendamento
    const pre = await PreAgendamento.findById(id).session(session);
    if (!pre) throw new Error('Pré-agendamento não encontrado');
    if (pre.status === 'importado') throw new Error('Já foi importado');

    console.log('[IMPORTAR] Dados atuais do pré-agendamento:', {
      patientInfo: pre.patientInfo
    });

    // 2. Buscar doutor
    const doctor = await Doctor.findById(doctorId).session(session);
    if (!doctor) throw new Error('Doutor não encontrado');

    // 3. Atualizar dados do paciente no pré-agendamento (se vieram do frontend)
    if (birthDate) {
      console.log('[IMPORTAR] Atualizando birthDate:', birthDate);
      pre.patientInfo.birthDate = birthDate;
    }
    if (phone) pre.patientInfo.phone = phone;
    if (email) pre.patientInfo.email = email;
    if (responsible) pre.patientInfo.responsible = responsible;
    await pre.save({ session });
    
    console.log('[IMPORTAR] Dados após atualização:', {
      patientInfo: pre.patientInfo
    });

    // 4. Importar usando bookFixedSlot
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
      operationalStatus: 'scheduled',
      notes: `[IMPORTADO DO PRE-AGENDAMENTO] ${notes || ''}\n${pre.secretaryNotes || ''}`,
      source: pre.source || 'outro', // 📈 ROI
      preAgendamentoId: String(pre._id) // 📈 ROI
    });

    if (!result.success) {
      throw new Error(result.error || 'Erro ao criar agendamento');
    }

    // 4. Atualizar pré-agendamento
    pre.status = 'importado';
    pre.importedToAppointment = result.appointment._id;
    pre.importedAt = new Date();

    // Verifica se é um usuário real (ObjectId) ou serviço
    if (mongoose.Types.ObjectId.isValid(req.user.id)) {
      pre.importedBy = req.user.id;
    }
    await pre.save({ session });

    await session.commitTransaction();

    // 🤖 Feedback para AmandaAI/Bots
    try {
      const io = getIo();
      io.emit("preagendamento:confirmed", {
        id: String(pre._id),
        appointmentId: result.appointment._id,
        source: pre.source
      });
    } catch (e) {
      console.error('⚠️ AmandaAI Feedback Socket error:', e.message);
    }

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
router.post('/:id/descartar', async (req, res) => {
  try {
    const { reason } = req.body;

    const pre = await PreAgendamento.findByIdAndUpdate(
      req.params.id,
      {
        status: 'desistiu', // 📈 ROI: Diferenciar descarte manual de desistência do paciente
        discardReason: reason,
        discardedAt: new Date(),
        discardedBy: (req.user.id && mongoose.Types.ObjectId.isValid(req.user.id)) ? req.user.id : undefined,
        updatedAt: new Date()
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Descartado com sucesso',
      data: pre
    });

    // 🚀 Emitir Socket para o Front e AmandaAI
    try {
      const io = getIo();
      io.emit("preagendamento:discarded", {
        id: String(pre._id),
        reason,
        source: pre.source
      });
    } catch (e) {
      console.error('⚠️ Socket error:', e.message);
    }

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/pre-agendamento/:id
 * Atualizar dados do pré-agendamento
 */
router.patch('/:id', async (req, res) => {
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
router.get('/stats/dashboard', async (req, res) => {
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
