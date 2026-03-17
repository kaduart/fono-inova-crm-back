// controllers/convenioPackageController.js
import mongoose from 'mongoose';
import Package from '../models/Package.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Payment from '../models/Payment.js';
import Convenio from '../models/Convenio.js';
import { syncEvent } from '../services/syncService.js';

/**
 * 📦 Controller para Pacotes de Convênio
 *
 * Este controller gerencia pacotes type='convenio', que são criados
 * a partir de guias de convênio existentes.
 *
 * ⚠️ IMPORTANTE: Este é um controller SEPARADO do therapyPackageController.
 * Não modifica pacotes type='therapy' existentes.
 */

/**
 * Cria um pacote de convênio a partir de uma guia existente
 *
 * POST /api/convenio-packages
 *
 * Body:
 * {
 *   patientId: string,
 *   doctorId: string,
 *   insuranceGuideId: string,
 *   selectedSlots: [{ date: 'YYYY-MM-DD', time: 'HH:mm' }]
 * }
 */
export const createConvenioPackage = async (req, res) => {
  const mongoSession = await mongoose.startSession();
  let transactionCommitted = false;

  try {
    await mongoSession.startTransaction();

    const {
      patientId,
      doctorId,
      insuranceGuideId,
      selectedSlots = []
    } = req.body;

    // ===================================
    // 1. VALIDAÇÕES BÁSICAS
    // ===================================
    if (!patientId || !doctorId || !insuranceGuideId) {
      throw new Error('patientId, doctorId e insuranceGuideId são obrigatórios');
    }

    if (!selectedSlots || selectedSlots.length === 0) {
      throw new Error('Nenhum horário selecionado (selectedSlots vazio)');
    }

    // Validar formato dos slots
    for (const slot of selectedSlots) {
      if (!slot.date || !slot.time) {
        throw new Error('Cada slot deve ter date e time');
      }

      // Validar formato de data (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.date)) {
        throw new Error(`Data inválida: ${slot.date}. Use formato YYYY-MM-DD`);
      }

      // Validar formato de hora (HH:mm)
      if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(slot.time)) {
        throw new Error(`Hora inválida: ${slot.time}. Use formato HH:mm`);
      }
    }

    // ===================================
    // 2. VALIDAR GUIA
    // ===================================
    const guide = await InsuranceGuide.findById(insuranceGuideId)
      .session(mongoSession);

    if (!guide) {
      throw new Error('Guia não encontrada');
    }

    if (guide.status !== 'active') {
      throw new Error(`Guia está ${guide.status} e não pode ser convertida em pacote`);
    }

    if (guide.packageId) {
      throw new Error('Esta guia já foi convertida em pacote');
    }

    // Verificar se paciente da guia bate com o solicitado
    if (guide.patientId.toString() !== patientId) {
      throw new Error('Guia pertence a outro paciente');
    }

    // Verificar saldo disponível
    const available = guide.remaining; // totalSessions - usedSessions

    if (selectedSlots.length > available) {
      throw new Error(
        `Guia tem apenas ${available} ${available === 1 ? 'sessão disponível' : 'sessões disponíveis'}. ` +
        `Você tentou agendar ${selectedSlots.length}.`
      );
    }

    // ===================================
    // 3. BUSCAR VALOR DO CONVÊNIO
    // ===================================
    const convenioValue = await Convenio.getSessionValue(guide.insurance);
    console.log(`💰 Valor do convênio ${guide.insurance}: R$ ${convenioValue}`);

    // ===================================
    // 4. CRIAR PACOTE TIPO 'convenio'
    // ===================================
    const convenioPackage = new Package({
      type: 'convenio',
      insuranceGuide: guide._id,
      insuranceProvider: guide.insurance,
      insuranceGrossAmount: convenioValue || 0, // Valor correto do convênio

      // Dados do paciente/profissional
      patient: patientId,
      doctor: doctorId,
      specialty: guide.specialty,
      sessionType: guide.specialty,

      // Financeiro (CONVÊNIO - paciente não paga)
      totalSessions: selectedSlots.length,
      sessionValue: 0,
      totalValue: 0,
      totalPaid: 0,
      balance: 0,
      financialStatus: 'paid', // Considerado "pago" (convênio paga)
      paymentType: 'full',
      paymentMethod: 'convenio',

      // Controle
      status: 'active',
      sessionsDone: 0,
      calculationMode: 'sessions',
      insuranceBillingStatus: 'pending_batch',

      // Data/hora do primeiro agendamento
      date: new Date(selectedSlots[0].date),
      time: selectedSlots[0].time,

      // Calcular duração aproximada
      durationMonths: Math.ceil(selectedSlots.length / 4) || 1,
      sessionsPerWeek: 1 // Placeholder, pode ajustar depois
    });

    await convenioPackage.save({ session: mongoSession });

    console.log(`📦 Pacote de convênio criado: ${convenioPackage._id}`);

    // ===================================
    // 4. CRIAR SESSÕES
    // ===================================
    const sessions = [];

    for (const slot of selectedSlots) {
      const newSession = new Session({
        date: slot.date,
        time: slot.time,
        patient: patientId,
        doctor: doctorId,
        package: convenioPackage._id,
        insuranceGuide: guide._id,
        guideConsumed: false, // Será true quando status = 'completed'

        sessionValue: convenioValue || 0,  // ⭐ Valor histórico imutável do convênio
        sessionType: guide.specialty,
        specialty: guide.specialty,
        status: 'scheduled',
        isPaid: false, // ⚠️ Convênio NÃO está pago - só recebe 30 dias depois
        paymentStatus: 'pending_receipt', // Aguardando recebimento do convênio
        paymentMethod: 'convenio',
        visualFlag: 'pending', // Reflete status pendente
        notes: `Pacote Convênio - Guia #${guide.number}`,

        // Flag para evitar sync redundante
        _inFinancialTransaction: true
      });

      sessions.push(newSession);
    }

    const insertedSessions = await Session.insertMany(sessions, {
      session: mongoSession
    });

    console.log(`✅ ${insertedSessions.length} sessões criadas`);

    // ===================================
    // 5. CRIAR APPOINTMENTS
    // ===================================
    const appointments = insertedSessions.map(s => ({
      patient: patientId,
      doctor: doctorId,
      date: s.date,
      time: s.time,
      duration: 40,
      specialty: guide.specialty,
      session: s._id,
      package: convenioPackage._id,
      serviceType: 'convenio_session',
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending_receipt', // ⚠️ Aguardando recebimento do convênio
      paymentMethod: 'convenio',
      visualFlag: 'pending', // Reflete status pendente
      insuranceProvider: guide.insurance,
      insuranceValue: convenioValue || 0,
      sessionValue: convenioValue || 0  // ⭐ VALOR PARA PROJEÇÃO FINANCEIRA
    }));

    const insertedAppointments = await Appointment.insertMany(appointments, {
      session: mongoSession
    });

    console.log(`✅ ${insertedAppointments.length} appointments criados`);

    // ===================================
    // 6. VINCULAR SESSIONS ↔ APPOINTMENTS
    // ===================================
    for (let i = 0; i < insertedSessions.length; i++) {
      insertedSessions[i].appointmentId = insertedAppointments[i]._id;
      await insertedSessions[i].save({
        session: mongoSession,
        validateBeforeSave: false
      });
    }

    // ===================================
    // 7. ATUALIZAR PACOTE COM REFERÊNCIAS
    // ===================================
    convenioPackage.sessions = insertedSessions.map(s => s._id);
    convenioPackage.appointments = insertedAppointments.map(a => a._id);
    await convenioPackage.save({ session: mongoSession });

    // ===================================
    // 8. MARCAR GUIA COMO CONVERTIDA
    // ===================================
    guide.packageId = convenioPackage._id;
    await guide.save({ session: mongoSession });

    console.log(`✅ Guia #${guide.number} marcada como convertida`);

    // ===================================
    // 9. ATUALIZAR PACIENTE
    // ===================================
    await Patient.findByIdAndUpdate(
      patientId,
      { $addToSet: { packages: convenioPackage._id } },
      { session: mongoSession }
    );

    // ===================================
    // 10. COMMIT
    // ===================================
    await mongoSession.commitTransaction();
    transactionCommitted = true;

    console.log(`✅ Transação commitada com sucesso`);

    // ===================================
    // 11. SINCRONIZAÇÃO (fora da transação)
    // ===================================
    try {
      await syncEvent(convenioPackage, 'package');
    } catch (syncError) {
      console.error('⚠️ Erro na sincronização (não-crítico):', syncError.message);
    }

    // ===================================
    // 12. RETORNAR RESULTADO
    // ===================================
    const result = await Package.findById(convenioPackage._id)
      .populate('sessions appointments insuranceGuide patient doctor')
      .lean();

    res.status(201).json({
      success: true,
      message: `Pacote de convênio criado com ${selectedSlots.length} ${selectedSlots.length === 1 ? 'sessão' : 'sessões'}`,
      package: result,
      guide: {
        id: guide._id,
        number: guide.number,
        insurance: guide.insurance,
        remaining: guide.remaining,
        convertedToPackage: true
      }
    });

  } catch (error) {
    // Rollback em caso de erro
    if (mongoSession.inTransaction() && !transactionCommitted) {
      await mongoSession.abortTransaction();
      console.log('❌ Transação abortada');
    }

    console.error('❌ Erro ao criar pacote de convênio:', error);

    // Retornar erro apropriado
    let statusCode = 400;
    let errorCode = 'CONVENIO_PACKAGE_ERROR';

    if (error.message.includes('não encontrada')) {
      statusCode = 404;
      errorCode = 'GUIDE_NOT_FOUND';
    } else if (error.message.includes('já foi convertida')) {
      statusCode = 409;
      errorCode = 'GUIDE_ALREADY_CONVERTED';
    } else if (error.message.includes('sessões disponíveis') || error.message.includes('sessão disponível')) {
      statusCode = 400;
      errorCode = 'INSUFFICIENT_SESSIONS';
    }

    res.status(statusCode).json({
      success: false,
      message: error.message,
      errorCode
    });

  } finally {
    await mongoSession.endSession();
  }
};

/**
 * Lista todos os pacotes de convênio de um paciente
 *
 * GET /api/convenio-packages?patientId=xxx
 */
export const getConvenioPackages = async (req, res) => {
  try {
    const { patientId } = req.query;

    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: 'patientId é obrigatório'
      });
    }

    const packages = await Package.find({
      patient: patientId,
      type: 'convenio'
    })
      .populate('sessions appointments insuranceGuide patient doctor')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: packages.length,
      packages
    });

  } catch (error) {
    console.error('Erro ao buscar pacotes de convênio:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Busca um pacote de convênio específico por ID
 *
 * GET /api/convenio-packages/:id
 */
export const getConvenioPackageById = async (req, res) => {
  try {
    const { id } = req.params;

    const pkg = await Package.findOne({
      _id: id,
      type: 'convenio'
    })
      .populate('sessions appointments insuranceGuide patient doctor')
      .lean();

    if (!pkg) {
      return res.status(404).json({
        success: false,
        message: 'Pacote de convênio não encontrado'
      });
    }

    res.json({
      success: true,
      package: pkg
    });

  } catch (error) {
    console.error('Erro ao buscar pacote:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Cancela uma sessão de pacote de convênio
 * Devolve a sessão à guia se já tinha sido consumida
 *
 * PATCH /api/convenio-packages/:packageId/sessions/:sessionId/cancel
 *
 * Baseado em: therapyPackageController.update.session (cancelamento)
 */
export const cancelConvenioSession = async (req, res) => {
  const mongoSession = await mongoose.startSession();
  let transactionCommitted = false;

  try {
    await mongoSession.startTransaction();

    const { packageId, sessionId } = req.params;

    // ===================================
    // 1. VALIDAR PACOTE
    // ===================================
    const pkg = await Package.findOne({
      _id: packageId,
      type: 'convenio'
    }).session(mongoSession);

    if (!pkg) {
      throw new Error('Pacote de convênio não encontrado');
    }

    // ===================================
    // 2. VALIDAR SESSÃO
    // ===================================
    const session = await Session.findById(sessionId)
      .session(mongoSession);

    if (!session) {
      throw new Error('Sessão não encontrada');
    }

    if (session.package.toString() !== packageId) {
      throw new Error('Sessão não pertence a este pacote');
    }

    if (session.status === 'canceled') {
      throw new Error('Sessão já está cancelada');
    }

    // ===================================
    // 3. CANCELAR SESSÃO
    // ===================================
    const previousStatus = session.status;

    session.status = 'canceled';
    session.confirmedAbsence = req.body.confirmedAbsence || false;
    session.notes = req.body.notes || session.notes;

    await session.save({ session: mongoSession });

    console.log(`🚫 Sessão ${sessionId} cancelada`);

    // ===================================
    // 4. DEVOLVER À GUIA (se já tinha consumido)
    // ===================================
    if (session.guideConsumed && session.insuranceGuide) {
      const guide = await InsuranceGuide.findById(session.insuranceGuide)
        .session(mongoSession);

      if (guide) {
        // Decrementa usedSessions (devolve à guia)
        guide.usedSessions -= 1;

        // Se estava exhausted e agora tem saldo, volta para active
        if (guide.status === 'exhausted' && guide.usedSessions < guide.totalSessions) {
          guide.status = 'active';
        }

        await guide.save({ session: mongoSession });

        console.log(`♻️ Sessão devolvida à guia #${guide.number} (${guide.usedSessions}/${guide.totalSessions})`);
      }

      // Marca sessão como não consumida
      session.guideConsumed = false;
      await session.save({ session: mongoSession });
    }

    // ===================================
    // 5. DECREMENTAR sessionsDone DO PACOTE (se era completed)
    // ===================================
    if (previousStatus === 'completed') {
      pkg.sessionsDone = Math.max(0, pkg.sessionsDone - 1);

      // Se estava finished e agora tem sessões pendentes, volta para active
      if (pkg.status === 'finished') {
        const activeSessions = await Session.countDocuments({
          package: packageId,
          status: { $ne: 'canceled' }
        }).session(mongoSession);

        const completedSessions = await Session.countDocuments({
          package: packageId,
          status: 'completed'
        }).session(mongoSession);

        if (completedSessions < activeSessions) {
          pkg.status = 'active';
          console.log(`🔄 Pacote voltou para 'active'`);
        }
      }

      await pkg.save({ session: mongoSession });
    }

    // ===================================
    // 6. ATUALIZAR APPOINTMENT
    // ===================================
    if (session.appointmentId) {
      await Appointment.findByIdAndUpdate(
        session.appointmentId,
        {
          operationalStatus: 'canceled',
          clinicalStatus: session.confirmedAbsence ? 'missed' : 'canceled'
        },
        { session: mongoSession }
      );
    }

    // ===================================
    // 7. COMMIT
    // ===================================
    await mongoSession.commitTransaction();
    transactionCommitted = true;

    // ===================================
    // 8. RETORNAR RESULTADO
    // ===================================
    const updatedPackage = await Package.findById(packageId)
      .populate('sessions appointments insuranceGuide')
      .lean();

    res.json({
      success: true,
      message: 'Sessão cancelada com sucesso',
      session: {
        id: session._id,
        status: session.status,
        guideConsumed: session.guideConsumed
      },
      package: updatedPackage
    });

  } catch (error) {
    if (mongoSession.inTransaction() && !transactionCommitted) {
      await mongoSession.abortTransaction();
    }

    console.error('Erro ao cancelar sessão:', error);

    res.status(400).json({
      success: false,
      message: error.message
    });

  } finally {
    await mongoSession.endSession();
  }
};

/**
 * Marca sessões de convênio como pagas quando o convênio efetivamente paga
 * (Normalmente 30 dias após o faturamento)
 *
 * PATCH /api/convenio-packages/:packageId/mark-paid
 *
 * Body:
 * {
 *   sessionIds: [id1, id2, ...],  // IDs das sessões que foram pagas
 *   paymentDate: 'YYYY-MM-DD',    // Data do pagamento do convênio
 *   notes: 'Lote X recebido'      // Observações opcionais
 * }
 */
export const markConvenioSessionsAsPaid = async (req, res) => {
  const mongoSession = await mongoose.startSession();
  let transactionCommitted = false;

  try {
    await mongoSession.startTransaction();

    const { packageId } = req.params;
    const { sessionIds = [], paymentDate, notes } = req.body;

    // ===================================
    // 1. VALIDAÇÕES
    // ===================================
    if (!sessionIds || sessionIds.length === 0) {
      throw new Error('Nenhuma sessão selecionada para marcar como paga');
    }

    if (!paymentDate) {
      throw new Error('Data do pagamento é obrigatória');
    }

    // ===================================
    // 2. BUSCAR PACOTE
    // ===================================
    const pkg = await Package.findOne({
      _id: packageId,
      type: 'convenio'
    }).session(mongoSession);

    if (!pkg) {
      throw new Error('Pacote de convênio não encontrado');
    }

    // ===================================
    // 3. ATUALIZAR SESSÕES
    // ===================================
    const paymentDateObj = new Date(paymentDate);
    
    const updateResult = await Session.updateMany(
      {
        _id: { $in: sessionIds },
        package: packageId,
        paymentMethod: 'convenio',
        status: 'completed' // Só marcar como pago se já foi completada
      },
      {
        $set: {
          isPaid: true,
          paidAt: paymentDateObj,
          paymentStatus: 'paid',
          visualFlag: 'ok',
          notes: notes ? `${notes} | Pago em ${paymentDate}` : `Pago em ${paymentDate}`
        }
      }
    ).session(mongoSession);

    console.log(`✅ ${updateResult.modifiedCount} sessões marcadas como pagas`);

    // ===================================
    // 4. ATUALIZAR APPOINTMENTS
    // ===================================
    const sessions = await Session.find({
      _id: { $in: sessionIds }
    }).session(mongoSession);

    const appointmentIds = sessions
      .map(s => s.appointmentId)
      .filter(Boolean);

    if (appointmentIds.length > 0) {
      await Appointment.updateMany(
        {
          _id: { $in: appointmentIds }
        },
        {
          $set: {
            paymentStatus: 'paid',
            visualFlag: 'ok'
          }
        }
      ).session(mongoSession);

      console.log(`✅ ${appointmentIds.length} appointments atualizados`);
    }

    // ===================================
    // 5. ATUALIZAR STATUS DO PACOTE
    // ===================================
    pkg.insuranceBillingStatus = 'received';
    await pkg.save({ session: mongoSession });

    // ===================================
    // 6. COMMIT
    // ===================================
    await mongoSession.commitTransaction();
    transactionCommitted = true;

    // ===================================
    // 7. RETORNAR RESULTADO
    // ===================================
    const updatedPackage = await Package.findById(packageId)
      .populate('sessions appointments insuranceGuide')
      .lean();

    res.json({
      success: true,
      message: `${updateResult.modifiedCount} ${updateResult.modifiedCount === 1 ? 'sessão marcada' : 'sessões marcadas'} como paga`,
      sessionsUpdated: updateResult.modifiedCount,
      paymentDate,
      package: updatedPackage
    });

  } catch (error) {
    if (mongoSession.inTransaction() && !transactionCommitted) {
      await mongoSession.abortTransaction();
    }

    console.error('Erro ao marcar sessões como pagas:', error);

    res.status(400).json({
      success: false,
      message: error.message
    });

  } finally {
    await mongoSession.endSession();
  }
};

/**
 * Adiciona uma nova sessão ao pacote de convênio
 * Valida saldo disponível na guia antes de criar
 *
 * POST /api/convenio-packages/:packageId/sessions
 *
 * Baseado em: therapyPackageController.addSessionToPackage
 */
export const addConvenioSession = async (req, res) => {
  const mongoSession = await mongoose.startSession();
  let transactionCommitted = false;

  try {
    await mongoSession.startTransaction();

    const { packageId } = req.params;
    const { date, time, notes } = req.body;

    // ===================================
    // 1. VALIDAÇÕES BÁSICAS
    // ===================================
    if (!date || !time) {
      throw new Error('date e time são obrigatórios');
    }

    // Validar formato
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Data inválida: ${date}. Use formato YYYY-MM-DD`);
    }

    if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
      throw new Error(`Hora inválida: ${time}. Use formato HH:mm`);
    }

    // ===================================
    // 2. BUSCAR PACOTE
    // ===================================
    const pkg = await Package.findOne({
      _id: packageId,
      type: 'convenio'
    })
      .populate('insuranceGuide')
      .session(mongoSession);

    if (!pkg) {
      throw new Error('Pacote de convênio não encontrado');
    }

    // ===================================
    // 3. VALIDAR SALDO DA GUIA
    // ===================================
    const guide = await InsuranceGuide.findById(pkg.insuranceGuide._id)
      .session(mongoSession);

    if (!guide) {
      throw new Error('Guia vinculada não encontrada');
    }

    // Contar sessões não-canceladas do pacote
    const activeSessions = await Session.countDocuments({
      package: packageId,
      status: { $ne: 'canceled' }
    }).session(mongoSession);

    // Total que a guia autoriza
    const authorized = guide.totalSessions;

    if (activeSessions >= authorized) {
      throw new Error(
        `Guia esgotada: ${activeSessions} sessões já agendadas de ${authorized} autorizadas`
      );
    }

    console.log(`✅ Saldo disponível: ${authorized - activeSessions} sessões`);

    // ===================================
    // 4. VERIFICAR CONFLITO DE HORÁRIO
    // ===================================
    const conflict = await Session.findOne({
      date,
      time,
      doctor: pkg.doctor,
      patient: pkg.patient,
      status: { $ne: 'canceled' }
    }).session(mongoSession);

    if (conflict) {
      throw new Error(
        `Já existe uma sessão agendada para ${date} às ${time}`
      );
    }

    // ===================================
    // 5. CRIAR NOVA SESSÃO
    // ===================================
    const newSession = new Session({
      date,
      time,
      patient: pkg.patient,
      doctor: pkg.doctor,
      package: pkg._id,
      insuranceGuide: guide._id,
      guideConsumed: false,

      sessionValue: pkg.insuranceGrossAmount || 0,  // ⭐ Valor histórico imutável
      sessionType: pkg.sessionType,
      specialty: pkg.specialty,
      status: 'scheduled',
      isPaid: false, // ⚠️ Convênio NÃO está pago - só recebe 30 dias depois
      paymentStatus: 'pending_receipt', // Aguardando recebimento do convênio
      paymentMethod: 'convenio',
      visualFlag: 'pending', // Reflete status pendente
      notes: notes || `Pacote Convênio - Guia #${guide.number}`,

      _inFinancialTransaction: true
    });

    await newSession.save({ session: mongoSession });

    console.log(`✅ Nova sessão criada: ${newSession._id}`);

    // ===================================
    // 6. CRIAR APPOINTMENT
    // ===================================
    const newAppointment = new Appointment({
      patient: pkg.patient,
      doctor: pkg.doctor,
      date,
      time,
      duration: 40,
      specialty: pkg.specialty,
      session: newSession._id,
      package: pkg._id,
      serviceType: 'convenio_session',
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending_receipt', // ⚠️ Aguardando recebimento do convênio
      paymentMethod: 'convenio',
      visualFlag: 'pending', // Reflete status pendente
      insuranceProvider: guide.insurance,
      insuranceValue: 0
    });

    await newAppointment.save({ session: mongoSession });

    // ===================================
    // 7. VINCULAR SESSION ↔ APPOINTMENT
    // ===================================
    newSession.appointmentId = newAppointment._id;
    await newSession.save({ session: mongoSession });

    // ===================================
    // 8. ATUALIZAR PACOTE
    // ===================================
    pkg.sessions.push(newSession._id);
    pkg.appointments.push(newAppointment._id);
    pkg.totalSessions += 1; // Incrementa total do pacote

    await pkg.save({ session: mongoSession });

    // ===================================
    // 9. COMMIT
    // ===================================
    await mongoSession.commitTransaction();
    transactionCommitted = true;

    // ===================================
    // 10. RETORNAR RESULTADO
    // ===================================
    const updatedPackage = await Package.findById(packageId)
      .populate('sessions appointments insuranceGuide')
      .lean();

    res.status(201).json({
      success: true,
      message: 'Sessão adicionada com sucesso',
      session: {
        id: newSession._id,
        date: newSession.date,
        time: newSession.time,
        status: newSession.status
      },
      package: updatedPackage
    });

  } catch (error) {
    if (mongoSession.inTransaction() && !transactionCommitted) {
      await mongoSession.abortTransaction();
    }

    console.error('Erro ao adicionar sessão:', error);

    res.status(400).json({
      success: false,
      message: error.message
    });

  } finally {
    await mongoSession.endSession();
  }
};
