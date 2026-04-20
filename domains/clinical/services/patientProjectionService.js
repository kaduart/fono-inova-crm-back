// back/domains/clinical/services/patientProjectionService.js
/**
 * Patient Projection Service
 * 
 * Constrói o Read Model (PatientsView) a partir do Event Store.
 * Chamado pelo PatientProjectionWorker quando eventos relevantes ocorrem.
 * 
 * 📋 PROJECTION CONTRACT: ONE_TO_ONE_VIEW
 * - Type: ProjectionType.ONE_TO_ONE_VIEW
 * - Source: Patient (Aggregate Root)
 * - IdentityStrategy: SHARED (_id da view = _id do paciente)
 * - Collection: patients_view
 * 
 * Isso garante que o frontend sempre receba o mesmo ID independente
 * de estar lendo do Patient (write model) ou PatientsView (read model).
 */

import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import PatientsView from '../../../models/PatientsView.js';
import Appointment from '../../../models/Appointment.js';
import Payment from '../../../models/Payment.js';
import PatientBalance from '../../../models/PatientBalance.js';
import Package from '../../../models/Package.js';
import { createContextLogger } from '../../../utils/logger.js';
import { PatientViewContract } from '../../../contracts/ProjectionContract.js';

const logger = createContextLogger('PatientProjection');

// 🏥 Mapeamento de nomes amigáveis para especialidades
const SPECIALTY_NAMES = {
  fonoaudiologia: 'Fonoaudiologia',
  terapia_ocupacional: 'Terapia Ocupacional',
  psicologia: 'Psicologia',
  fisioterapia: 'Fisioterapia',
  psicomotricidade: 'Psicomotricidade',
  musicoterapia: 'Musicoterapia',
  psicopedagogia: 'Psicopedagogia',
  neuropediatria: 'Neuropediatria',
  neuroped: 'Neuropediatria',
  pediatria: 'Pediatria',
  sessao: 'Sessão',
  evaluation: 'Avaliação',
  individual_session: 'Sessão Individual'
};

function formatSpecialtyName(raw) {
  if (!raw) return 'Sessão';
  // Converte snake_case para texto legível
  return raw
    .replace(/_/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

// ============================================
// BUILDERS (constroem a view)
// ============================================

/**
 * Constrói (ou reconstrói) a view completa de um paciente
 */
export async function buildPatientView(patientId, options = {}) {
  const { force = false, correlationId = 'unknown' } = options;
  
  // 🛡️ GUARDA: patientId inválido = skip imediato
  if (!patientId || patientId === 'null' || patientId === 'undefined') {
    logger.warn(`[${correlationId}] ⏭️ Skipping build — invalid patientId: ${patientId}`);
    return null;
  }
  
  logger.info(`[${correlationId}] Building view for patient ${patientId}`, { force });
  
  try {
    // 1. Busca dados do paciente (source of truth)
    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      logger.warn(`[${correlationId}] Patient not found: ${patientId}`);
      return null;
    }
    
    // 2. Busca dados relacionados em paralelo (OTIMIZADO: limitado + select)
    const [
      recentAppointments,
      totalAppointments,
      totalCompleted,
      totalCanceled,
      totalNoShow,
      recentPayments,
      totalRevenueAgg,
      totalPendingAgg,
      totalPendingParticularAgg,
      balance,
      packages
    ] = await Promise.all([
      // Últimos 50 agendamentos (para last/next + lista resumida)
      // 🎯 ALINHADO com resto do sistema: exclui pré-agendamentos e "fantasmas" de conversão
      Appointment.find({ patient: patientId, operationalStatus: { $ne: 'pre_agendado' }, appointmentId: { $exists: false } })
        .sort({ date: -1, time: -1 })
        .limit(50)
        .select('date time operationalStatus clinicalStatus doctor serviceType specialty sessionValue paymentStatus')
        .lean(),
      // Counts via aggregation — barato, não carrega documentos
      // 🎯 MESMO FILTRO: evita contar pré-agendamentos e duplicatas de conversão
      Appointment.countDocuments({ patient: patientId, operationalStatus: { $ne: 'pre_agendado' }, appointmentId: { $exists: false } }),
      Appointment.countDocuments({ patient: patientId, operationalStatus: 'completed', appointmentId: { $exists: false } }),
      Appointment.countDocuments({ patient: patientId, operationalStatus: 'canceled', appointmentId: { $exists: false } }),
      Appointment.countDocuments({ patient: patientId, clinicalStatus: 'no_show', operationalStatus: { $ne: 'pre_agendado' }, appointmentId: { $exists: false } }),
      // Últimos 200 pagamentos (cobre 99% dos pacientes)
      Payment.find({ patientId })
        .sort({ createdAt: -1 })
        .limit(200)
        .select('status amount createdAt')
        .lean(),
      // Aggregation para totais financeiros (paid ou completed)
      Payment.aggregate([
        { $match: { $or: [{ patient: new mongoose.Types.ObjectId(patientId) }, { patientId: new mongoose.Types.ObjectId(patientId) }], status: { $in: ['paid', 'completed'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payment.aggregate([
        { $match: { $or: [{ patient: new mongoose.Types.ObjectId(patientId) }, { patientId: new mongoose.Types.ObjectId(patientId) }], status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      // 🎯 DÍVIDA REAL DO PACIENTE: exclui convênio e insurance (não é dívida do paciente)
      Payment.aggregate([
        { $match: { $or: [{ patient: new mongoose.Types.ObjectId(patientId) }, { patientId: new mongoose.Types.ObjectId(patientId) }], status: 'pending', billingType: { $nin: ['convenio', 'insurance'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      PatientBalance.findOne({ patient: patientId }).lean(),
      Package.find({ patient: patientId })
        .select('_id sessionType specialty totalSessions sessionsDone sessionsRemaining status sessionValue')
        .lean()
    ]);
    
    // 3. Calcula métricas (usa counts da aggregation + dados recentes)
    const appointments = recentAppointments; // compatibilidade com funções existentes
    const payments = recentPayments;
    const stats = {
      totalAppointments,
      totalCompleted,
      totalCanceled,
      totalNoShow,
      totalSessions: packages.reduce((sum, p) => sum + (p.sessionsDone || 0), 0),
      totalPackages: packages.length,
      totalRevenue: totalRevenueAgg[0]?.total || 0,
      totalPending: totalPendingAgg[0]?.total || 0,
      totalPendingParticular: totalPendingParticularAgg[0]?.total || 0,
      firstAppointmentDate: recentAppointments.length > 0 
        ? recentAppointments[recentAppointments.length - 1].date 
        : null,
      lastAppointmentDate: null,  // preenchido abaixo
      nextAppointmentDate: null   // preenchido abaixo
    };
    
    // 4. Extrai último/próximo agendamento
    const { lastAppointment, nextAppointment } = extractAppointments(recentAppointments);
    stats.lastAppointmentDate = lastAppointment?.date || null;
    stats.nextAppointmentDate = nextAppointment?.date || null;
    
    // 5. Normaliza nome para busca
    const normalizedName = patient.fullName
      ?.normalize('NFD')
      ?.replace(/[\u0300-\u036f]/g, '')
      ?.toLowerCase() || '';
    
    // 6. Monta a view
    // ✅ SOLUÇÃO DEFINITIVA: _id = patientId (unifica os IDs)
    const patientObjectId = new mongoose.Types.ObjectId(patientId);
    const viewData = {
      _id: patientObjectId,  // 🎯 ID da view = ID do paciente
      patientId: patientObjectId,
      
      // Dados básicos
      fullName: patient.fullName,
      normalizedName,
      dateOfBirth: patient.dateOfBirth,
      phone: patient.phone,
      phoneDigits: patient.phone?.replace(/\D/g, ''),
      email: patient.email,
      cpf: patient.cpf,
      cpfDigits: patient.cpf?.replace(/\D/g, ''),
      mainComplaint: patient.mainComplaint,
      healthPlan: patient.healthPlan,
      
      // Vínculo
      doctorId: patient.doctor,
      doctorName: patient.doctor?.fullName || null,
      specialty: null, // será preenchido se tiver doutor
      
      // Stats calculadas (usam aggregation counts — precisas e baratas)
      stats,
      
      // Agendamentos
      lastAppointment,
      nextAppointment,
      
      // 📦 Pacotes (formato simplificado para o frontend)
      packages: packages?.length > 0 
        ? packages.map(pkg => {
            const rawType = pkg.sessionType || pkg.specialty || 'sessao';
            const sessionType = SPECIALTY_NAMES[rawType] || formatSpecialtyName(rawType);
            return {
              packageId: pkg._id,
              sessionType,
              totalSessions: pkg.totalSessions || pkg.sessions?.length || 0,
              sessionsDone: pkg.sessionsDone || pkg.sessions?.filter(s => s.status === 'completed')?.length || 0,
              sessionsRemaining: pkg.sessionsRemaining || (pkg.totalSessions - (pkg.sessionsDone || 0)),
              status: pkg.status
            };
          })
        : [],
      
      // Saldo
      // 🎯 FONTE DE VERDADE FINANCEIRA: usa totalPendingParticular (Payment) em vez de PatientBalance.currentBalance
      // PatientBalance é um contador mutável que pode ficar desatualizado/corrompido.
      // totalPendingParticular = status:pending EXCLUINDO convênio/insurance — é o que o paciente realmente deve.
      balance: {
        current: stats.totalPendingParticular || 0,
        lastUpdated: new Date()
      },
      
      // Status
      status: determinePatientStatus(appointments, stats),
      tags: generateTags(patient, appointments, stats),
      
      // Snapshot metadata
      snapshot: {
        version: (await getCurrentVersion(patientId)) + 1,
        calculatedAt: new Date(),
        ttl: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 dias
        isStale: false
      }
    };
    
    // 7. Validação de contrato (garante consistência de ID)
    if (PatientViewContract.isSharedIdentity()) {
      const expectedId = patientObjectId.toString();
      const actualId = viewData._id.toString();
      if (expectedId !== actualId) {
        throw new Error(
          `[${correlationId}] Contract violation: PatientView._id (${actualId}) !== Patient._id (${expectedId})`
        );
      }
    }
    
    // 8. Upsert na collection de views
    const result = await PatientsView.findOneAndUpdate(
      { patientId: new mongoose.Types.ObjectId(patientId) },
      viewData,
      { 
        upsert: true, 
        new: true,
        setDefaultsOnInsert: true
      }
    );
    
    logger.info(`[${correlationId}] View built successfully`, { 
      patientId, 
      version: viewData.snapshot.version,
      appointmentsCount: appointments.length,
      contract: PatientViewContract.type
    });
    
    return result;
    
  } catch (error) {
    logger.error(`[${correlationId}] Failed to build view: ${error?.message || String(error)}`, {
      patientId,
      stack: error?.stack?.split('\n').slice(0, 3).join(' | ')
    });
    throw error;
  }
}

/**
 * Atualização parcial (incremental) - mais rápida
 */
export async function updatePatientViewPartial(patientId, updates, correlationId) {
  logger.info(`[${correlationId}] Partial update for patient ${patientId}`);
  
  try {
    const result = await PatientsView.findOneAndUpdate(
      { patientId: new mongoose.Types.ObjectId(patientId) },
      { 
        $set: {
          ...updates,
          'snapshot.calculatedAt': new Date(),
          'snapshot.isStale': false
        },
        $inc: { 'snapshot.version': 1 }
      },
      { new: true }
    );
    
    if (!result) {
      // Se não existe, faz build completo
      logger.warn(`[${correlationId}] View not found, doing full build`);
      return await buildPatientView(patientId, { correlationId });
    }
    
    return result;
    
  } catch (error) {
    logger.error(`[${correlationId}] Partial update failed`, { error: error.message });
    throw error;
  }
}

/**
 * Invalida view (marca como stale)
 */
export async function invalidatePatientView(patientId, correlationId) {
  logger.info(`[${correlationId}] Invalidating view for ${patientId}`);
  
  await PatientsView.findOneAndUpdate(
    { patientId: new mongoose.Types.ObjectId(patientId) },
    { 'snapshot.isStale': true }
  );
}

// ============================================
// HELPERS
// ============================================

function calculateStats(appointments, payments, packages) {
  const completed = appointments.filter(a => a.operationalStatus === 'completed');
  const pendingPayments = payments.filter(p => p.status === 'pending');
  
  return {
    totalAppointments: appointments.length,
    totalCompleted: completed.length,
    totalCanceled: appointments.filter(a => a.operationalStatus === 'canceled').length,
    totalNoShow: appointments.filter(a => a.clinicalStatus === 'no_show').length,
    
    totalSessions: packages.reduce((sum, p) => sum + (p.sessionsDone || 0), 0),
    totalPackages: packages.length,
    
    totalRevenue: payments
      .filter(p => p.status === 'completed')
      .reduce((sum, p) => sum + (p.amount || 0), 0),
    totalPending: pendingPayments.reduce((sum, p) => sum + (p.amount || 0), 0)
  };
}

function extractAppointments(appointments) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const nowTime = today.toTimeString().slice(0, 5);
  
  // 🔧 HELPER ROBUSTO: Converte qualquer formato de data para string YYYY-MM-DD
  const toDateStr = (date) => {
    if (!date) return '';
    // Se já for string no formato ISO ou YYYY-MM-DD
    if (typeof date === 'string') {
      // Se for ISO string com T, pegar só a parte da data
      if (date.includes('T')) return date.split('T')[0];
      return date.slice(0, 10);
    }
    // Se for objeto Date (do MongoDB/Mongoose)
    if (date instanceof Date) {
      try {
        return date.toISOString().split('T')[0];
      } catch (e) {
        return '';
      }
    }
    // Fallback: converter para string
    try {
      const str = String(date);
      if (str.includes('T')) return str.split('T')[0];
      return str.slice(0, 10);
    } catch (e) {
      return '';
    }
  };
  
  const valid = appointments.filter(a => a.operationalStatus !== 'canceled');
  
  // Último agendamento (passado)
  const past = valid
    .filter(a => {
      const dateStr = toDateStr(a.date);
      if (dateStr < todayStr) return true;
      if (dateStr > todayStr) return false;
      return a.time < nowTime;
    })
    .sort((a, b) => {
      const dateA = toDateStr(a.date);
      const dateB = toDateStr(b.date);
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return (b.time || '').localeCompare(a.time || '');
    });
  
  // Próximo agendamento (futuro)
  const future = valid
    .filter(a => {
      const dateStr = toDateStr(a.date);
      if (dateStr > todayStr) return true;
      if (dateStr < todayStr) return false;
      return a.time >= nowTime;
    })
    .sort((a, b) => {
      const dateA = toDateStr(a.date);
      const dateB = toDateStr(b.date);
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return (a.time || '').localeCompare(b.time || '');
    });
  
  const toAppointmentView = (apt) => apt ? {
    id: apt._id,
    date: apt.date,
    time: apt.time,
    status: apt.operationalStatus,
    serviceType: apt.serviceType,
    doctorName: apt.doctor?.fullName
  } : null;
  
  return {
    lastAppointment: toAppointmentView(past[0]),
    nextAppointment: toAppointmentView(future[0])
  };
}

function determinePatientStatus(appointments, stats) {
  if (appointments.length === 0) return 'prospect';
  
  const lastAppointment = appointments[0];
  const daysSinceLast = lastAppointment?.date 
    ? Math.floor((Date.now() - new Date(lastAppointment.date)) / (1000 * 60 * 60 * 24))
    : Infinity;
  
  // Inativo se não vem há 90 dias
  if (daysSinceLast > 90) return 'inactive';
  
  // Churned se não vem há 180 dias
  if (daysSinceLast > 180) return 'churned';
  
  return 'active';
}

function generateTags(patient, appointments, stats) {
  const tags = [];
  
  if (stats.totalCompleted > 10) tags.push('vip');
  if (stats.totalPending > 0) tags.push('debito');
  if (appointments.length === 0) tags.push('novo');
  if (patient.healthPlan?.name) tags.push('convenio');
  
  return tags;
}

async function getCurrentVersion(patientId) {
  const existing = await PatientsView.findOne({ 
    patientId: new mongoose.Types.ObjectId(patientId) 
  }, 'snapshot.version');
  
  return existing?.snapshot?.version || 0;
}

// ============================================
// BATCH OPERATIONS
// ============================================

/**
 * Rebuild de todas as views (para migração ou correção)
 */
export async function rebuildAllViews(options = {}) {
  const { batchSize = 100, onProgress = null } = options;
  
  logger.info('Starting full view rebuild');
  
  const totalPatients = await Patient.countDocuments();
  let processed = 0;
  let errors = 0;
  
  const cursor = Patient.find({}, '_id').cursor();
  
  while (true) {
    const batch = [];
    for (let i = 0; i < batchSize; i++) {
      const doc = await cursor.next();
      if (!doc) break;
      batch.push(doc._id);
    }
    
    if (batch.length === 0) break;
    
    // Processa batch em paralelo
    await Promise.all(
      batch.map(async (patientId) => {
        try {
          await buildPatientView(patientId, { force: true, correlationId: 'rebuild' });
          processed++;
        } catch (error) {
          logger.error(`Failed to rebuild view for ${patientId}`, { error: error.message });
          errors++;
        }
      })
    );
    
    onProgress?.({ processed, total: totalPatients, errors });
    
    logger.info(`Rebuild progress: ${processed}/${totalPatients}`);
  }
  
  logger.info('Full rebuild completed', { processed, errors });
  
  return { processed, errors, total: totalPatients };
}

export default {
  buildPatientView,
  updatePatientViewPartial,
  invalidatePatientView,
  rebuildAllViews
};
