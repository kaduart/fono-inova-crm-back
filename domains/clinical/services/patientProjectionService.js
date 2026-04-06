// back/domains/clinical/services/patientProjectionService.js
/**
 * Patient Projection Service
 * 
 * Constrói o Read Model (PatientsView) a partir do Event Store.
 * Chamado pelo PatientProjectionWorker quando eventos relevantes ocorrem.
 */

import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import PatientsView from '../../../models/PatientsView.js';
import Appointment from '../../../models/Appointment.js';
import Payment from '../../../models/Payment.js';
import PatientBalance from '../../../models/PatientBalance.js';
import Package from '../../../models/Package.js';
import { createContextLogger } from '../../../utils/logger.js';

const logger = createContextLogger('PatientProjection');

// ============================================
// BUILDERS (constroem a view)
// ============================================

/**
 * Constrói (ou reconstrói) a view completa de um paciente
 */
export async function buildPatientView(patientId, options = {}) {
  const { force = false, correlationId = 'unknown' } = options;
  
  logger.info(`[${correlationId}] Building view for patient ${patientId}`, { force });
  
  try {
    // 1. Busca dados do paciente (source of truth)
    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      logger.warn(`[${correlationId}] Patient not found: ${patientId}`);
      return null;
    }
    
    // 2. Busca dados relacionados em paralelo
    const [
      appointments,
      payments,
      balance,
      packages
    ] = await Promise.all([
      Appointment.find({ patient: patientId }).sort({ date: -1, time: -1 }).lean(),
      Payment.find({ patientId }).lean(),
      PatientBalance.findOne({ patient: patientId }).lean(),
      Package.find({ patient: patientId }).lean()
    ]);
    
    // 3. Calcula métricas
    const stats = calculateStats(appointments, payments, packages);
    
    // 4. Extrai último/próximo agendamento
    const { lastAppointment, nextAppointment } = extractAppointments(appointments);
    
    // 5. Normaliza nome para busca
    const normalizedName = patient.fullName
      ?.normalize('NFD')
      ?.replace(/[\u0300-\u036f]/g, '')
      ?.toLowerCase() || '';
    
    // 6. Monta a view
    const viewData = {
      patientId: new mongoose.Types.ObjectId(patientId),
      
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
      
      // Stats calculadas
      stats: {
        totalAppointments: appointments.length,
        totalCompleted: appointments.filter(a => a.operationalStatus === 'completed').length,
        totalCanceled: appointments.filter(a => a.operationalStatus === 'canceled').length,
        totalNoShow: appointments.filter(a => a.clinicalStatus === 'no_show').length,
        
        totalSessions: packages.reduce((sum, p) => sum + (p.sessionsDone || 0), 0),
        totalPackages: packages.length,
        
        totalRevenue: payments
          .filter(p => p.status === 'completed')
          .reduce((sum, p) => sum + (p.amount || 0), 0),
        totalPending: payments
          .filter(p => p.status === 'pending')
          .reduce((sum, p) => sum + (p.amount || 0), 0),
        
        firstAppointmentDate: appointments.length > 0 
          ? appointments[appointments.length - 1].date 
          : null,
        lastAppointmentDate: lastAppointment?.date || null,
        nextAppointmentDate: nextAppointment?.date || null
      },
      
      // Agendamentos
      lastAppointment,
      nextAppointment,
      
      // Saldo
      balance: {
        current: balance?.currentBalance || 0,
        lastUpdated: balance?.updatedAt || null
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
    
    // 7. Upsert na collection de views
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
      appointmentsCount: appointments.length
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
