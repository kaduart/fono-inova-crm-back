/**
 * 📦 Package Controller V2 - Production Grade
 * 
 * ARQUITETURA:
 * - Package = contrato financeiro
 * - Appointment = operação no calendário  
 * - Session = execução clínica
 * 
 * FLUXO:
 * 1. Validar entrada + idempotência
 * 2. Criar Package (transaction)
 * 3. Criar Appointments + Sessions em batch
 * 4. Vincular tudo
 * 5. Publicar eventos
 */

import mongoose from 'mongoose';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import PatientsView from '../models/PatientsView.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import PatientBalance from '../models/PatientBalance.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';
import { getHolidaysWithNames } from '../config/feriadosBR-dynamic.js';
import { recordPackageMetric } from '../routes/package.metrics.js';
import { buildPackageView } from '../domains/billing/services/PackageProjectionService.js';
import { buildDateTime } from '../utils/datetime.js';
import { resolvePatientId } from '../utils/identityResolver.js';
import moment from 'moment';

const logger = createContextLogger('PackageV2');

// ============================================================
// 🔧 HELPERS
// ============================================================

/**
 * Gera hash único para idempotência
 */
function generateIdempotencyKey(data) {
  const { patientId, doctorId, specialty, totalSessions, timestamp } = data;
  return `pkg_${patientId}_${doctorId}_${specialty}_${totalSessions}_${timestamp || Date.now()}`;
}

/**
 * 🚨 VALIDA se data cai em feriado (NÃO ajusta automaticamente)
 * Retorna erro se for feriado - decisão é do humano
 */
function validateNotHoliday(dateStr, timeStr) {
  const year = parseInt(dateStr.split('-')[0], 10);
  const holidays = getHolidaysWithNames(year);
  const holiday = holidays.find(h => h.date === dateStr);
  
  if (!holiday) return null; // OK
  
  // Quarta-feira de Cinzas: bloqueia só manhã
  const isAshWednesday = holiday.name === 'Quarta-feira de Cinzas';
  if (isAshWednesday) {
    const hour = parseInt(timeStr?.split(':')[0] || '0', 10);
    if (hour >= 12) return null; // Tarde liberada
  }
  
  return {
    date: dateStr,
    holiday: holiday.name,
    message: `Data ${dateStr} é feriado: ${holiday.name}. Escolha outra data.`
  };
}

/**
 * 🔄 AJUSTA schedule pulando feriados
 * Se uma data for feriado, gera nova data na próxima semana
 * 🛡️ GARANTE: nunca gera datas duplicadas
 */
function adjustScheduleSkipHolidays(schedule, sessionsPerWeek = 1) {
  const adjusted = [];
  const skippedHolidays = [];
  const usedDates = new Set(); // Track datas já usadas
  
  // Primeiro passo: coletar todas as datas não-feriado
  for (const slot of schedule) {
    const year = parseInt(slot.date.split('-')[0], 10);
    const holidays = getHolidaysWithNames(year);
    const holiday = holidays.find(h => h.date === slot.date);
    
    if (!holiday) {
      // Não é feriado, mantém
      adjusted.push(slot);
      usedDates.add(slot.date);
    }
  }
  
  // Segundo passo: processar feriados e evitar duplicados
  for (const slot of schedule) {
    const year = parseInt(slot.date.split('-')[0], 10);
    const holidays = getHolidaysWithNames(year);
    const holiday = holidays.find(h => h.date === slot.date);
    
    if (holiday) {
      // É feriado, encontra data livre
      let currentDate = new Date(slot.date + 'T12:00:00');
      let attempts = 0;
      let newDateStr;
      
      do {
        currentDate.setDate(currentDate.getDate() + (7 * sessionsPerWeek));
        newDateStr = currentDate.toISOString().split('T')[0];
        attempts++;
        
        // Segurança: máximo 52 tentativas (1 ano)
        if (attempts > 52) {
          throw new Error(`Não foi possível encontrar data livre para ${slot.date} após 52 semanas`);
        }
      } while (usedDates.has(newDateStr)); // Enquanto data já existe
      
      const newSlot = {
        date: newDateStr,
        time: slot.time
      };
      
      skippedHolidays.push({
        original: slot.date,
        holiday: holiday.name,
        newDate: newSlot.date
      });
      
      adjusted.push(newSlot);
      usedDates.add(newDateStr);
    }
  }
  
  // Ordenar por data
  adjusted.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  return { adjusted, skippedHolidays };
}

// ============================================================
// 🏭 FACTORIES (desacopladas)
// ============================================================

/**
 * Cria dados do Package baseado no tipo
 */
function createPackageData(data) {
  const { 
    patientId, doctorId, specialty, sessionType,
    totalSessions, sessionValue, totalValue,
    type, model,
    insuranceGuideId, insuranceProvider,
    liminarProcessNumber, liminarCourt, liminarExpirationDate, liminarMode,
    notes, durationMonths, sessionsPerWeek, date
  } = data;

  const baseData = {
    patient: patientId,
    doctor: doctorId,
    specialty,
    sessionType: sessionType || specialty,
    totalSessions: parseInt(totalSessions),
    sessionsDone: 0,
    notes,
    status: 'active',
    // Campos obrigatórios do modelo Package
    durationMonths: durationMonths || Math.ceil(parseInt(totalSessions) / 4),
    sessionsPerWeek: sessionsPerWeek || 1,
    date: date ? new Date(date) : new Date()
  };

  // 1️⃣ CONVÊNIO
  if (type === 'insurance' || type === 'convenio') {
    return {
      ...baseData,
      type: 'convenio',
      model: 'convenio',  // 🎯 CAMPO V2 OBRIGATÓRIO
      insuranceGuide: insuranceGuideId,
      insuranceProvider,
      sessionValue: 0,
      totalValue: 0,
      totalPaid: 0,
      balance: 0,
      financialStatus: 'paid',
      paymentType: 'full',
      paymentMethod: 'convenio'
    };
  }

  // 4️⃣ LIMINAR
  if (type === 'legal' || type === 'liminar') {
    const calculatedTotal = totalValue || (sessionValue * totalSessions);
    return {
      ...baseData,
      type: 'liminar',
      model: 'liminar',  // 🎯 CAMPO V2 OBRIGATÓRIO
      liminarProcessNumber,
      liminarCourt,
      liminarExpirationDate: liminarExpirationDate || null,
      liminarMode: liminarMode || 'hybrid',
      liminarAuthorized: true,
      liminarTotalCredit: calculatedTotal,
      liminarCreditBalance: calculatedTotal,
      recognizedRevenue: 0,
      sessionValue: sessionValue || 150, // ⚖️ Liminar precisa de valor para calcular crédito por sessão!
      totalValue: calculatedTotal,
      totalPaid: 0,
      balance: 0,
      financialStatus: 'unpaid',
      paymentType: 'full',
      paymentMethod: 'liminar_credit'  // ⚖️ Forma de pagamento para liminar (não é 'liminar')
    };
  }

  // 2️⃣ & 3️⃣ PACKAGE (pré-pago ou per-session)
  const isPrepaid = model === 'prepaid';
  const calculatedTotal = totalValue || (sessionValue * totalSessions);
  
  return {
    ...baseData,
    type: 'therapy',
    model: model || 'per_session',  // 🎯 CAMPO SEMÂNTICO CORRETO
    sessionValue,
    totalValue: calculatedTotal,
    totalPaid: isPrepaid ? data.payments?.reduce((s, p) => s + (p.amount || 0), 0) : 0,
    balance: isPrepaid ? calculatedTotal - (data.payments?.reduce((s, p) => s + (p.amount || 0), 0) || 0) : calculatedTotal,
    financialStatus: isPrepaid ? 'paid' : 'unpaid',
    paymentType: isPrepaid ? 'full' : 'per-session',
    paymentMethod: isPrepaid ? (data.payments?.[0]?.method || 'pix') : 'pix'
  };
}

/**
 * Cria appointments em batch
 */
async function createAppointmentsBatch(pkg, schedule, mongoSession) {
  if (!schedule || schedule.length === 0) {
    return [];
  }

  const appointmentDocs = schedule.map((slot, index) => ({
    patient: pkg.patient,
    doctor: pkg.doctor,
    date: buildDateTime(slot.date, slot.time),  // 🚨 FIX: Converter para Date com timezone
    time: slot.time,
    duration: 40,
    specialty: pkg.specialty,
    // 🔗 VÍNCULO OBRIGATÓRIO: Package ↔ Appointment
    package: pkg._id,
    serviceType: 'package_session',
    operationalStatus: 'scheduled',
    clinicalStatus: 'pending',
    paymentStatus: pkg.paymentType === 'per-session' ? 'unpaid' : 'package_paid',
    paymentOrigin: pkg.paymentType === 'per-session' ? 'auto_per_session' : 'package_prepaid',
    billingType: pkg.type === 'convenio' ? 'convenio' : 
                 pkg.type === 'liminar' ? 'liminar' : 'particular',
    sessionValue: pkg.sessionValue || 0,
    isFirstAppointment: index === 0
  }));

  return await Appointment.insertMany(appointmentDocs, { session: mongoSession });
}

/**
 * Cria sessions em batch vinculadas aos appointments
 */
async function createSessionsBatch(pkg, appointments, mongoSession) {
  if (!appointments || appointments.length === 0) {
    return [];
  }

  const sessionDocs = appointments.map(appt => ({
    date: appt.date,
    time: appt.time,
    patient: pkg.patient,
    doctor: pkg.doctor,
    // 🔗 VÍNCULO OBRIGATÓRIO: Package ↔ Session
    package: pkg._id,
    appointmentId: appt._id,
    sessionValue: pkg.sessionValue || 0,
    sessionType: pkg.sessionType || pkg.specialty,
    specialty: pkg.specialty,
    status: 'scheduled',
    // 🎯 V2: Usar model (prepaid vs per_session) em vez de paymentType
    // ⚖️ Liminar e Prepaid = já pagos | Per_session = pendente
    isPaid: ['prepaid', 'liminar', 'convenio'].includes(pkg.model),
    paymentStatus: pkg.model === 'per_session' ? 'unpaid' : 'package_paid',
    paymentOrigin: pkg.model === 'per_session' 
      ? 'auto_per_session' 
      : pkg.model === 'liminar' 
        ? 'liminar_credit' 
        : 'package_prepaid',
    visualFlag: pkg.model === 'per_session' ? 'pending' : 'ok',
    paymentMethod: pkg.model === 'liminar' ? 'liminar_credit' : pkg.paymentMethod
  }));

  return await Session.insertMany(sessionDocs, { session: mongoSession });
}

/**
 * Vincula sessions aos appointments
 */
async function linkSessionsToAppointments(sessions, mongoSession) {
  const bulkOps = sessions.map(session => ({
    updateOne: {
      filter: { _id: session.appointmentId },
      update: { $set: { session: session._id } }
    }
  }));

  if (bulkOps.length > 0) {
    await Appointment.bulkWrite(bulkOps, { session: mongoSession });
  }
}

/**
 * Cria payments para pré-pago
 * Pode ser chamado dentro ou fora de transaction
 */
async function createPrepaidPayments(pkg, payments, mongoSession = null) {
  if (!payments || payments.length === 0) return [];

  const Payment = (await import('../models/Payment.js')).default;
  
  const paymentDocs = payments.map(p => ({
    package: pkg._id,
    patient: pkg.patient,
    doctor: pkg.doctor,
    amount: p.amount,
    paymentMethod: p.method || 'pix',
    paymentDate: p.date || new Date(),
    financialDate: new Date(), // 🎯 ESSENCIAL pro caixa
    kind: 'package_receipt',
    status: 'paid',
    paidAt: new Date(),
    serviceType: 'package_session',
    notes: p.description || 'Pagamento do pacote'
  }));

  const options = mongoSession ? { session: mongoSession } : {};
  return await Payment.insertMany(paymentDocs, options);
}

// ============================================================
// 🎯 CONTROLLERS
// ============================================================

/**
 * 🆕 Criar novo pacote (com agenda completa)
 * POST /api/v2/packages
 */
export const createPackageV2 = async (req, res) => {
  const correlationId = `pkg_v2_${Date.now()}`;
  const requestStartTime = Date.now();
  let transactionStartTime = 0;
  let transactionDuration = 0;
  let operationsCount = 0;
  const mongoSession = await mongoose.startSession();
  let transactionCommitted = false;

  // ========================================
  // 1️⃣ VALIDAÇÕES (antes de iniciar transação)
  // ========================================
  let {
    patientId, doctorId, specialty, sessionType,
    totalSessions, sessionValue, totalValue,
    type, model,
    schedule: scheduleInput = [],
    payments = [],
    notes,
    sessionsPerWeek,
    durationMonths,
    idempotencyKey,
    appointmentId = null   // 🔗 appointment avulso a reutilizar (opcional)
  } = req.body;

  // 🔄 RESOLVER patientId (pode vir como ID da PatientsView)
  patientId = await resolvePatientId(patientId);

  if (!patientId || !doctorId || !specialty || !totalSessions) {
    await mongoSession.endSession();
    return res.status(400).json({
      success: false,
      errorCode: 'MISSING_REQUIRED_FIELDS',
      message: 'Campos obrigatórios: patientId, doctorId, specialty, totalSessions'
    });
  }

  if (!type || !['insurance', 'package', 'legal', 'convenio', 'liminar'].includes(type)) {
    await mongoSession.endSession();
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_TYPE',
      message: 'type deve ser: insurance, package, legal, convenio, ou liminar'
    });
  }

  if (type === 'package' && !model) {
    await mongoSession.endSession();
    return res.status(400).json({
      success: false,
      errorCode: 'MODEL_REQUIRED',
      message: 'Para type=package, informe model=prepaid ou per_session'
    });
  }

  if (model === 'prepaid' && Array.isArray(req.body.payments)) {
    const invalidPayment = req.body.payments.find(p => !p.amount || typeof p.amount !== 'number' || p.amount <= 0);
    if (invalidPayment) {
      await mongoSession.endSession();
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_PAYMENT_AMOUNT',
        message: 'Cada pagamento em payments[] deve ter amount (número > 0)'
      });
    }
  }

  // Validações específicas por tipo
  if ((type === 'insurance' || type === 'convenio') && !req.body.insuranceGuideId) {
    await mongoSession.endSession();
    return res.status(400).json({
      success: false,
      errorCode: 'INSURANCE_GUIDE_REQUIRED',
      message: 'insuranceGuideId obrigatório para convênio'
    });
  }

  if ((type === 'legal' || type === 'liminar') && !req.body.liminarProcessNumber) {
    await mongoSession.endSession();
    return res.status(400).json({
      success: false,
      errorCode: 'LIMINAR_DATA_REQUIRED',
      message: 'liminarProcessNumber obrigatório para liminar'
    });
  }

  try {
    await mongoSession.startTransaction();
    
    // Variáveis mutáveis para uso dentro da transação
    let schedule = scheduleInput;

    // ========================================
    // 2️⃣ IDEMPOTÊNCIA (proteção contra duplicação)
    // ========================================
    const key = idempotencyKey || generateIdempotencyKey(req.body);
    
    // 🔥 ÍNDICE ÚNICO: verifica se já existe package com essa key
    if (idempotencyKey) {
      const existingByKey = await Package.findOne({ idempotencyKey }).session(mongoSession);
      if (existingByKey) {
        logger.info('[PackageV2] Package already exists (idempotencyKey)', { 
          correlationId, 
          packageId: existingByKey._id 
        });
        
        await mongoSession.abortTransaction();
        
        return res.status(200).json({
          success: true,
          message: 'Pacote já existente (idempotência)',
          data: { packageId: existingByKey._id },
          meta: { correlationId, idempotent: true }
        });
      }
    }
    
    // Verifica package similar criado recentemente (últimos 5 minutos) - fallback
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const existingPackage = await Package.findOne({
      patient: patientId,
      doctor: doctorId,
      specialty,
      totalSessions: parseInt(totalSessions),
      createdAt: { $gte: fiveMinutesAgo }
    }).session(mongoSession);
    
    if (existingPackage) {
      logger.warn('[PackageV2] Similar package found recently (possible duplicate)', { 
        correlationId, 
        existingPackageId: existingPackage._id,
        key
      });
      
      await mongoSession.abortTransaction();
      
      return res.status(409).json({
        success: false,
        errorCode: 'POSSIBLE_DUPLICATE',
        message: 'Pacote similar criado recentemente. Verifique antes de continuar.',
        data: { packageId: existingPackage._id, createdAt: existingPackage.createdAt }
      });
    }

    // Verificar paciente
    logger.info(`[${correlationId}] 🔍 Verificando paciente no aggregate`, { patientId });
    let patient = await Patient.findById(patientId).session(mongoSession);
    
    // 🛡️ AUTO-HEALING: se aggregate não existe mas view existe, tenta reconstruir
    if (!patient) {
      logger.warn(`[${correlationId}] ⚠️ Patient aggregate não encontrado, tentando auto-healing`, { patientId });
      
      const view = await PatientsView.findOne({ patientId }).lean();
      if (view) {
        try {
          // Reconstroi aggregate mínimo a partir da view
          const { buildPatientView } = await import('../domains/clinical/services/patientProjectionService.js');
          await Patient.create({
            _id: new mongoose.Types.ObjectId(patientId),
            fullName: view.fullName || 'Paciente sem nome',
            dateOfBirth: view.dateOfBirth || new Date('1900-01-01'),
            phone: view.phone || '',
            email: view.email || '',
            cpf: view.cpf || '',
            mainComplaint: view.mainComplaint || '',
            healthPlan: view.healthPlan || {},
            createdAt: view.createdAt || new Date(),
            updatedAt: new Date()
          });
          
          // Rebuild view para garantir consistência
          await buildPatientView(patientId, { correlationId, force: true });
          
          // Recarrega patient na sessão atual
          patient = await Patient.findById(patientId).session(mongoSession);
          logger.info(`[${correlationId}] ✅ Auto-healing bem-sucedido`, { patientId });
        } catch (healError) {
          logger.error(`[${correlationId}] ❌ Auto-healing falhou`, { patientId, error: healError.message });
        }
      }
      
      if (!patient) {
        logger.error(`[${correlationId}] ❌ Patient aggregate não encontrado após auto-healing`, { patientId });
        await mongoSession.abortTransaction();
        return res.status(404).json({
          success: false,
          errorCode: 'PATIENT_NOT_FOUND',
          message: 'Paciente não encontrado'
        });
      }
    }

    // ========================================
    // 3️⃣ CRIAR PACKAGE
    // ========================================
    transactionStartTime = Date.now();
    
    const packageData = createPackageData(req.body);
    packageData.createdBy = req.user?._id;

    const [pkg] = await Package.create([packageData], { session: mongoSession });
    operationsCount++;

    // ========================================
    // 4️⃣ VALIDAR E CRIAR APPOINTMENTS + SESSIONS (batch)
    // ========================================
    let appointments = [];
    let sessions = [];
    let paymentFailed = false;
    let skippedHolidays = [];

    if (schedule.length > 0) {
      // 🚨 DEDUPE: remover slots duplicados (mesma data + hora)
      const uniqueSlots = new Map();
      for (const slot of schedule) {
        const key = `${slot.date}_${slot.time}`;
        if (!uniqueSlots.has(key)) {
          uniqueSlots.set(key, slot);
        }
      }
      schedule = Array.from(uniqueSlots.values());
      
      // 🚨 VALIDAR: schedule não pode ter mais itens que totalSessions
      if (schedule.length > parseInt(totalSessions)) {
        await mongoSession.abortTransaction();
        return res.status(400).json({
          success: false,
          errorCode: 'SCHEDULE_EXCEEDS_TOTAL',
          message: `Agenda tem ${schedule.length} sessões, mas pacote permite apenas ${totalSessions}`
        });
      }
      
      // 🚨 VALIDAR: schedule deve ter EXATAMENTE totalSessions itens
      if (schedule.length !== parseInt(totalSessions)) {
        await mongoSession.abortTransaction();
        return res.status(400).json({
          success: false,
          errorCode: 'SCHEDULE_COUNT_MISMATCH',
          message: `Agenda tem ${schedule.length} sessões, mas deve ter exatamente ${totalSessions}`
        });
      }

      // 🛡️ VALIDAR CONSISTÊNCIA COM DÉBITOS: schedule não pode começar antes do débito mais antigo
      const debtIds = req.body.selectedDebts || req.body.pendingSessionIds || [];
      if (debtIds.length > 0) {
        const balance = await PatientBalance.findOne({ patient: patientId }).session(mongoSession).lean();
        const debitDates = (balance?.transactions || [])
          .filter(t => debtIds.includes(t._id?.toString()) && t.type === 'debit')
          .map(t => new Date(t.transactionDate).toISOString().split('T')[0]);
        
        if (debitDates.length > 0) {
          const oldestDebtDate = debitDates.sort()[0];
          const earliestScheduleDate = schedule.map(s => s.date).sort()[0];
          if (earliestScheduleDate < oldestDebtDate) {
            await mongoSession.abortTransaction();
            return res.status(400).json({
              success: false,
              errorCode: 'SCHEDULE_BEFORE_DEBT',
              message: `A primeira sessão sugerida (${earliestScheduleDate}) é anterior ao débito mais antigo (${oldestDebtDate}). Ajuste a data de início.`
            });
          }
        }
      }
      
      // 🔄 AJUSTAR FERIADOS (pula para próxima semana em vez de bloquear)
      const adjustResult = adjustScheduleSkipHolidays(schedule, sessionsPerWeek || 1);
      const adjustedSchedule = adjustResult.adjusted;
      skippedHolidays = adjustResult.skippedHolidays;
      
      // Log dos feriados pulados
      if (skippedHolidays.length > 0) {
        logger.info('[PackageV2] Feriados detectados e ajustados', {
          correlationId,
          skipped: skippedHolidays
        });
      }
      
      // Usa o schedule ajustado
      schedule = adjustedSchedule;
      
      // 🔗 PRÉ-BUSCAR appointment reutilizável (uma query, fora do loop)
      let reuseAppt = null;
      if (appointmentId) {
        reuseAppt = await Appointment.findById(appointmentId).session(mongoSession);
      }

      // 🚨 VALIDAR CONFLITOS DE AGENDA
      for (const slot of schedule) {
        // FIX: usar buildDateTime para comparação correta Date vs Date
        const slotDateTime = buildDateTime(slot.date, slot.time);

        // 🔗 Pular slot que será reutilizado (usuário selecionou explicitamente)
        if (reuseAppt && reuseAppt.time === slot.time) {
          const reuseMs = new Date(reuseAppt.date).getTime();
          if (Math.abs(slotDateTime.getTime() - reuseMs) < 60000) continue;
        }

        const conflict = await Appointment.findOne({
          doctor: doctorId,
          date: slotDateTime,          // FIX: Date object, não string
          time: slot.time,
          operationalStatus: { $nin: ['canceled', 'no_show'] }
        }).session(mongoSession);

        if (conflict) {
          await mongoSession.abortTransaction();
          return res.status(409).json({
            success: false,
            errorCode: 'SCHEDULE_CONFLICT',
            message: `Conflito de agenda: ${slot.date} às ${slot.time} já está ocupado`,
            data: { conflictingAppointment: conflict._id }
          });
        }
      }

      // 🔗 REUTILIZAR appointment existente (só roda se appointmentId fornecido)
      let slotsToCreate = schedule;
      if (reuseAppt) {
        // Vincular ao pacote
        reuseAppt.package = pkg._id;
        reuseAppt.serviceType = 'package_session';
        reuseAppt.paymentStatus = pkg.paymentType === 'per-session' ? 'unpaid' : 'package_paid';
        reuseAppt.paymentOrigin = pkg.paymentType === 'per-session' ? 'auto_per_session' : 'package_prepaid';
        await reuseAppt.save({ session: mongoSession });

        // Atualizar session existente se houver
        if (reuseAppt.session) {
          await Session.findByIdAndUpdate(
            reuseAppt.session,
            { $set: { package: pkg._id, paymentStatus: reuseAppt.paymentStatus } },
            { session: mongoSession }
          );
        }

        // Remover o slot correspondente — não criar duplicata
        const reuseMs = new Date(reuseAppt.date).getTime();
        slotsToCreate = schedule.filter(slot => {
          const slotMs = buildDateTime(slot.date, slot.time).getTime();
          return !(reuseAppt.time === slot.time && Math.abs(slotMs - reuseMs) < 60000);
        });
      }

      // Criar em batch apenas os slots novos
      const newAppointments = await createAppointmentsBatch(pkg, slotsToCreate, mongoSession);
      const newSessions = await createSessionsBatch(pkg, newAppointments, mongoSession);
      await linkSessionsToAppointments(newSessions, mongoSession);
      operationsCount += 2;
      operationsCount++;

      // Session para o appointment reutilizado (cria se não tiver, atualiza se tiver)
      let reuseSession = null;
      if (reuseAppt) {
        if (reuseAppt.session) {
          reuseSession = { _id: reuseAppt.session };
        } else {
          const [created] = await createSessionsBatch(pkg, [reuseAppt], mongoSession);
          await linkSessionsToAppointments([created], mongoSession);
          reuseSession = created;
        }
      }

      // Combinar: reutilizado + novos
      appointments = reuseAppt ? [reuseAppt, ...newAppointments] : newAppointments;
      sessions    = reuseSession ? [reuseSession, ...newSessions] : newSessions;

      // Atualizar package com referências
      pkg.sessions = sessions.map(s => s._id);
      pkg.appointments = appointments.map(a => a._id);

      // 🔥 INVARIANTE: schedule DEVE ser igual ao totalSessions
      if (appointments.length !== parseInt(totalSessions)) {
        await mongoSession.abortTransaction();
        return res.status(400).json({
          success: false,
          errorCode: 'SCHEDULE_COUNT_MISMATCH',
          message: `Número de sessões na agenda (${appointments.length}) deve ser igual ao totalSessions (${totalSessions})`
        });
      }
      
      await pkg.save({ session: mongoSession });

      // ==========================================================
      // QUITAR DÉBITOS SELECIONADOS (via PatientBalance)
      // ==========================================================
      const selectedDebts = req.body.selectedDebts || [];
      if (selectedDebts.length > 0) {
        logger.info('[PackageV2] Quitando débitos selecionados', { count: selectedDebts.length });

        const patientBalance = await PatientBalance.findOne({ patient: patientId }).session(mongoSession);
        if (patientBalance) {
          const alreadySettled = patientBalance.transactions.filter(
            t => selectedDebts.includes(t._id?.toString()) &&
                 t.settledByPackageId &&
                 t.settledByPackageId.toString() !== pkg._id.toString()
          );

          if (alreadySettled.length > 0) {
            await mongoSession.abortTransaction();
            return res.status(400).json({
              success: false,
              errorCode: 'DEBTS_ALREADY_SETTLED',
              message: `${alreadySettled.length} débito(s) já foram quitados em outro pacote`
            });
          }

          const debitsToSettle = patientBalance.transactions.filter(
            t => selectedDebts.includes(t._id?.toString()) &&
                 t.type === 'debit' &&
                 !t.settledByPackageId &&
                 !t.isPaid
          );

          if (debitsToSettle.length > 0) {
            const totalToSettle = debitsToSettle.reduce((sum, t) => sum + t.amount, 0);

            for (const debit of debitsToSettle) {
              debit.settledByPackageId = pkg._id;
              debit.isPaid = true;
              debit.paidAmount = debit.amount;
            }

            patientBalance.transactions.push({
              type: 'credit',
              amount: totalToSettle,
              description: `Quitação via pacote #${pkg._id.toString().slice(-6)}`,
              specialty: debitsToSettle[0]?.specialty || req.body.sessionType,
              settledByPackageId: pkg._id,
              registeredBy: req.user?._id,
              transactionDate: new Date()
            });

            patientBalance.currentBalance -= totalToSettle;
            patientBalance.totalCredited += totalToSettle;
            patientBalance.lastTransactionAt = new Date();

            await patientBalance.save({ session: mongoSession });

            const appointmentIds = debitsToSettle
              .filter(t => t.appointmentId)
              .map(t => t.appointmentId);

            if (appointmentIds.length > 0) {
              await Appointment.updateMany(
                { _id: { $in: appointmentIds } },
                {
                  $set: {
                    paymentStatus: 'paid',
                    addedToBalance: false,
                    isPaid: true
                  }
                },
                { session: mongoSession }
              );
            }
          }
        }
      }
    }

    // Vincular ao paciente
    await Patient.findByIdAndUpdate(
      patientId,
      { $addToSet: { packages: pkg._id } },
      { session: mongoSession }
    );
    operationsCount++;

    await mongoSession.commitTransaction();
    transactionCommitted = true;
    transactionDuration = Date.now() - transactionStartTime;

    // ========================================
    // 🔄 REBUILD SÍNCRONO DA VIEW (para frontend imediato)
    // ========================================
    let viewBuildResult = null;
    try {
      viewBuildResult = await buildPackageView(pkg._id.toString(), { correlationId });
      logger.info('[PackageV2] View rebuilt synchronously', { 
        correlationId, 
        packageId: pkg._id,
        viewBuilt: viewBuildResult.success 
      });
    } catch (viewError) {
      logger.warn('[PackageV2] Failed to build view synchronously', { 
        correlationId, 
        packageId: pkg._id,
        error: viewError.message 
      });
      // Não falha a criação se a view falhar - rota GET tem fallback
    }

    // ========================================
    // 🏥 VINCULAR GUIA DE CONVÊNIO (se aplicável)
    // ========================================
    if ((type === 'insurance' || type === 'convenio') && req.body.insuranceGuideId) {
      try {
        await InsuranceGuide.findByIdAndUpdate(
          req.body.insuranceGuideId,
          { 
            $set: { 
              packageId: pkg._id,
              status: 'linked' // 🎯 Marca como vinculada
            } 
          }
        );
        logger.info('[PackageV2] Guia vinculada ao pacote', { 
          correlationId, 
          packageId: pkg._id,
          guideId: req.body.insuranceGuideId 
        });
      } catch (guideError) {
        logger.warn('[PackageV2] Erro ao vincular guia', { 
          correlationId, 
          guideId: req.body.insuranceGuideId,
          error: guideError.message 
        });
        // Não falha a criação se vinculação falhar
      }
    }

    // ========================================
    // 5️⃣ PAYMENTS (só pré-pago) - FORA DA TRANSACTION
    // ========================================
    let createdPayments = [];
    if (model === 'prepaid' && payments.length > 0) {
      try {
        createdPayments = await createPrepaidPayments(pkg, payments);
        // Atualizar package com referências
        await Package.findByIdAndUpdate(pkg._id, {
          $set: { payments: createdPayments.map(p => p._id) }
        });
        
        // 🏦 REGISTRAR NO LEDGER FINANCEIRO
        try {
          const { recordPackagePurchase } = await import('../services/financialLedgerService.js');
          for (const payment of createdPayments) {
            await recordPackagePurchase(pkg, payment, { correlationId });
          }
          logger.info('[PackageV2] Ledger registrado para payments do pacote');
        } catch (ledgerError) {
          logger.error('[PackageV2] Erro ao registrar no ledger (não-fatal)', { error: ledgerError.message });
        }
      } catch (paymentError) {
        paymentFailed = true;
        logger.error('[PackageV2][CRITICAL] Payment creation failed after package created', {
          correlationId,
          packageId: pkg._id,
          patientId,
          totalValue: pkg.totalValue,
          attemptedPayments: payments,
          error: paymentError.message,
          actionRequired: 'MANUAL_RECONCILIATION_REQUIRED'
        });
        
        // 🔥 PUBLICAR EVENTO PARA RECONCILIAÇÃO
        try {
          await publishEvent('PAYMENT_RECONCILIATION_REQUIRED', {
            packageId: pkg._id.toString(),
            patientId,
            amount: payments.reduce((s, p) => s + p.amount, 0),
            reason: 'CREATE_PACKAGE_PAYMENT_FAILED',
            originalError: paymentError.message,
            correlationId
          });
        } catch (eventError) {
          logger.error('[PackageV2] Failed to publish reconciliation event', { eventError: eventError.message });
        }
      }
    }

    // ========================================
    // 6️⃣ EVENTOS (fora da transaction)
    // ========================================
    try {
      await publishEvent(EventTypes.PACKAGE_CREATED, {
        patientId,
        packageId: pkg._id.toString(),
        doctorId,
        type: pkg.type,
        totalSessions: pkg.totalSessions,
        appointmentsCreated: appointments.length,
        sessionsCreated: sessions.length,
        requestId: correlationId
      });
    } catch (eventError) {
      logger.warn('[PackageV2] Falha ao publicar evento', { 
        correlationId, 
        error: eventError.message 
      });
    }

    // ========================================
    // 📊 MÉTRICAS DE PERFORMANCE (HeaderAdmin)
    // ========================================
    const totalDuration = Date.now() - requestStartTime;
    const estimatedQueries = operationsCount + schedule.length + 2; // aproximação
    
    // 📊 REGISTRAR MÉTRICA PARA HEADERADMIN
    recordPackageMetric({
      timestamp: Date.now(),
      duration: totalDuration,
      transactionDuration: transactionDuration,
      operations: operationsCount,
      queries: estimatedQueries,
      error: false,
      type: pkg.type,
      appointmentsCount: appointments.length
    });
    
    logger.info('[PERF][PackageV2]', {
      correlationId,
      packageId: pkg._id,
      // ⏱️ Tempos
      totalDurationMs: totalDuration,
      transactionDurationMs: transactionDuration,
      // 📊 Operações
      operationsInTransaction: operationsCount,
      estimatedDbQueries: estimatedQueries,
      appointmentsCreated: appointments.length,
      // 🎯 Dados para comparação
      type: pkg.type,
      model: pkg.paymentType,
      hasSchedule: schedule.length > 0,
      hasPayment: createdPayments.length > 0
    });

    logger.info('[PackageV2] Package created successfully', {
      correlationId,
      packageId: pkg._id,
      appointments: appointments.length,
      sessions: sessions.length
    });

    // ========================================
    // 7️⃣ RESPONSE
    // ========================================
    
    // 🎨 Mensagem adaptativa com feriados
    let message = schedule.length > 0 
      ? `Pacote criado com ${appointments.length} agendamentos`
      : 'Pacote criado (sem agenda - adicione depois)';
    
    if (skippedHolidays.length > 0) {
      const holidayNames = skippedHolidays.map(h => h.holiday).join(', ');
      message += `. Feriados ajustados: ${holidayNames}`;
    }
    
    res.status(201).json({
      success: true,
      message,
      data: {
        packageId: pkg._id,
        type: pkg.type,
        specialty: pkg.specialty,
        totalSessions: pkg.totalSessions,
        sessionsDone: pkg.sessionsDone,
        remaining: pkg.totalSessions - pkg.sessionsDone,
        totalValue: pkg.totalValue,
        totalPaid: pkg.totalPaid,
        balance: pkg.balance,
        financialStatus: pkg.financialStatus,
        paymentType: pkg.paymentType,
        appointmentsCreated: appointments.length,
        // 🔄 Informa feriados que foram pulados
        adjustedHolidays: skippedHolidays,
        sessionsCreated: sessions.length,
        appointments: appointments.map(a => ({
          _id: a._id,
          date: a.date,
          time: a.time,
          status: a.operationalStatus
        })),
        payments: createdPayments.map(p => ({
          _id: p._id,
          amount: p.amount,
          method: p.paymentMethod,
          status: p.status
        })),
        paymentStatus: paymentFailed ? 'RECONCILIATION_REQUIRED' : (createdPayments.length > 0 ? 'CREATED' : 'PENDING')
      },
      meta: {
        correlationId,
        viewBuilt: viewBuildResult?.success || false,
        warnings: paymentFailed ? ['Pagamento falhou - reconciliação necessária'] : undefined,
        // 📊 MÉTRICAS PARA HEADERADMIN
        performance: {
          totalDurationMs: totalDuration,
          transactionDurationMs: transactionDuration,
          operationsInTransaction: operationsCount,
          estimatedDbQueries: estimatedQueries,
          // Benchmark: < 200ms = excelente, < 500ms = bom, > 1000ms = lento
          grade: totalDuration < 200 ? 'EXCELLENT' : totalDuration < 500 ? 'GOOD' : totalDuration < 1000 ? 'FAIR' : 'SLOW'
        },
        nextSteps: schedule.length > 0 
          ? ['Agenda criada - secretária pode operar no calendário']
          : ['Use POST /api/v2/appointments para adicionar sessões ao pacote']
      }
    });

  } catch (error) {
    if (mongoSession.inTransaction() && !transactionCommitted) {
      await mongoSession.abortTransaction();
    }

    logger.error('[PackageV2] Error creating package', {
      correlationId,
      error: error.message,
      stack: error.stack
    });

    // Erros específicos
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        errorCode: 'DUPLICATE',
        message: 'Pacote já existe (conflito de dados)'
      });
    }
    
    // Erro de catálogo MongoDB (mudanças de schema durante transação)
    if (error.message?.includes('catalog changes') || error.message?.includes('Please retry')) {
      return res.status(503).json({
        success: false,
        errorCode: 'MONGO_CATALOG_CHANGE',
        message: 'Mudança de schema detectada. Por favor, aguarde 5 segundos e tente novamente.',
        retryable: true
      });
    }

    res.status(500).json({
      success: false,
      errorCode: 'PACKAGE_CREATION_ERROR',
      message: error.message
    });

  } finally {
    // 🛡️ Segurança: garante rollback se transação ainda estiver ativa
    if (mongoSession.inTransaction()) {
      await mongoSession.abortTransaction();
    }
    await mongoSession.endSession();
  }
};

/**
 * 📋 Listar pacotes do paciente
 */
export const listPackagesV2 = async (req, res) => {
  try {
    let { patientId, type, status } = req.query;

    if (!patientId) {
      return res.status(400).json({
        success: false,
        errorCode: 'MISSING_PATIENT_ID',
        message: 'patientId obrigatório'
      });
    }

    // 🔄 RESOLVER patientId (pode vir como ID da PatientsView)
    patientId = await resolvePatientId(patientId);

    const query = { patient: patientId };
    if (type) query.type = type;
    if (status) query.status = status;

    const packages = await Package.find(query)
      .populate('payments', 'amount paymentMethod status paidAt')
      .populate('appointments', 'date time operationalStatus')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: packages.length,
      data: packages.map(pkg => ({
        _id: pkg._id,
        type: pkg.type,
        specialty: pkg.specialty,
        totalSessions: pkg.totalSessions,
        sessionsDone: pkg.sessionsDone,
        remaining: pkg.totalSessions - pkg.sessionsDone,
        totalValue: pkg.totalValue,
        totalPaid: pkg.totalPaid,
        balance: pkg.balance,
        financialStatus: pkg.financialStatus,
        paymentType: pkg.paymentType,
        status: pkg.status,
        appointmentsCount: pkg.appointments?.length || 0,
        createdAt: pkg.createdAt
      }))
    });

  } catch (error) {
    logger.error('[PackageV2] Error listing packages', { error: error.message });
    res.status(500).json({
      success: false,
      errorCode: 'LIST_ERROR',
      message: error.message
    });
  }
};

/**
 * 🔍 Detalhe do pacote
 */
export const getPackageV2 = async (req, res) => {
  try {
    const { id } = req.params;

    const pkg = await Package.findById(id)
      .populate('payments')
      .populate('appointments')
      .populate('sessions')
      .lean();

    if (!pkg) {
      return res.status(404).json({
        success: false,
        errorCode: 'PACKAGE_NOT_FOUND',
        message: 'Pacote não encontrado'
      });
    }

    // 🔥 FORMATA SESSIONS INCLUINDO APPOINTMENT ID
    // Facilita o fluxo no frontend/Bruno para complete/cancel
    if (pkg.sessions && pkg.sessions.length > 0) {
      pkg.sessions = pkg.sessions.map(session => {
        // Converte appointmentId (ObjectId) para string
        let apptId = null;
        if (session.appointmentId) {
          apptId = typeof session.appointmentId === 'object' 
            ? session.appointmentId.toString() 
            : session.appointmentId;
        }
        return {
          ...session,
          appointmentId: apptId
        };
      });
    }

    res.json({
      success: true,
      data: pkg
    });

  } catch (error) {
    logger.error('[PackageV2] Error getting package', { error: error.message });
    res.status(500).json({
      success: false,
      errorCode: 'GET_ERROR',
      message: error.message
    });
  }
};

export default {
  createPackageV2,
  listPackagesV2,
  getPackageV2
};
