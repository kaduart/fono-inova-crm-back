/**
 * 🩺 Patient Consistency Cron
 *
 * Roda automaticamente a cada 30 minutos e detecta/corrige divergências
 * entre Patient (aggregate) e PatientsView (read model).
 *
 * Garantias:
 * - Views órfãs (sem aggregate) → recria aggregate
 * - Aggregates sem view → rebuild view
 * - Log estruturado de tudo
 */

import cron from 'node-cron';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import { buildPatientView } from '../domains/clinical/services/patientProjectionService.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger('cron', 'PatientConsistency');
const TIMEZONE = 'America/Sao_Paulo';

async function runConsistencyCheck() {
  const startTime = Date.now();
  const correlationId = `pat_consistency_${Date.now()}`;
  
  log.info(`[${correlationId}] 🔍 Iniciando verificação de consistência`);
  
  try {
    // 1. Busca todas as views
    const views = await PatientsView.find({}).select('patientId fullName').lean();
    const viewPatientIds = new Set(views.map(v => v.patientId?.toString()).filter(Boolean));
    
    // 2. Busca todos os aggregates
    const patients = await Patient.find({}).select('_id fullName').lean();
    const patientIds = new Set(patients.map(p => p._id.toString()));
    
    // 3. Detecta órfãos
    const orphanViews = [];
    for (const view of views) {
      const pid = view.patientId?.toString();
      if (!pid || !patientIds.has(pid)) {
        orphanViews.push(view);
      }
    }
    
    // 4. Detecta aggregates sem view
    const orphanAggregates = [];
    for (const patient of patients) {
      const pid = patient._id.toString();
      if (!viewPatientIds.has(pid)) {
        orphanAggregates.push(patient);
      }
    }
    
    log.info(`[${correlationId}] 📊 Resumo`, {
      totalViews: views.length,
      totalAggregates: patients.length,
      orphanViews: orphanViews.length,
      orphanAggregates: orphanAggregates.length
    });
    
    // 5. Auto-heal views órfãs (recria aggregate mínimo)
    let fixedViews = 0;
    for (const orphan of orphanViews) {
      try {
        const pid = orphan.patientId.toString();
        await Patient.create({
          _id: new mongoose.Types.ObjectId(pid),
          fullName: orphan.fullName || 'Paciente sem nome',
          dateOfBirth: orphan.dateOfBirth || new Date('1900-01-01'),
          phone: orphan.phone || '',
          email: orphan.email || '',
          cpf: orphan.cpf || '',
          createdAt: orphan.createdAt || new Date(),
          updatedAt: new Date()
        });
        await buildPatientView(pid, { correlationId, force: true });
        fixedViews++;
        log.info(`[${correlationId}] ✅ View órfã corrigida`, { patientId: pid, name: orphan.fullName });
      } catch (err) {
        log.error(`[${correlationId}] ❌ Falha ao corrigir view órfã`, { patientId: orphan.patientId?.toString(), error: err.message });
      }
    }
    
    // 6. Auto-heal aggregates sem view (rebuild view)
    let fixedAggregates = 0;
    for (const orphan of orphanAggregates) {
      try {
        const pid = orphan._id.toString();
        await buildPatientView(pid, { correlationId, force: true });
        fixedAggregates++;
        log.info(`[${correlationId}] ✅ Aggregate sem view corrigido`, { patientId: pid, name: orphan.fullName });
      } catch (err) {
        log.error(`[${correlationId}] ❌ Falha ao corrigir aggregate sem view`, { patientId: orphan._id.toString(), error: err.message });
      }
    }
    
    const duration = Date.now() - startTime;
    log.info(`[${correlationId}] ✅ Verificação concluída`, {
      durationMs: duration,
      fixedViews,
      fixedAggregates
    });
    
    return {
      status: 'ok',
      orphanViews: orphanViews.length,
      orphanAggregates: orphanAggregates.length,
      fixedViews,
      fixedAggregates,
      durationMs: duration
    };
    
  } catch (error) {
    log.error(`[${correlationId}] 💥 Erro na verificação`, { error: error.message });
    return { status: 'error', error: error.message };
  }
}

export function schedulePatientConsistency() {
  // Roda a cada 30 minutos
  const task = cron.schedule('*/30 * * * *', async () => {
    log.info('patient_consistency_start', 'Iniciando checagem automática de consistência Patient/View');
    await runConsistencyCheck();
  }, {
    timezone: TIMEZONE,
    scheduled: false
  });

  // Exposição manual
  task.runConsistencyCheck = runConsistencyCheck;

  return task;
}

export { runConsistencyCheck };
