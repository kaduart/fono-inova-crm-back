#!/usr/bin/env node
/**
 * Script de Rebuild do PatientsView
 * 
 * Uso:
 *   node scripts/rebuildPatientsView.js              # rebuild todos
 *   node scripts/rebuildPatientsView.js --patient=ID  # rebuild específico
 *   node scripts/rebuildPatientsView.js --batch=50    # batch size custom
 *   node scripts/rebuildPatientsView.js --dry-run     # simulação
 */

import mongoose from 'mongoose';
import { program } from 'commander';
import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import { buildPatientView, rebuildAllViews } from '../domains/clinical/services/patientProjectionService.js';
import { createContextLogger } from '../utils/logger.js';
import '../config/db.js'; // Conecta ao MongoDB

const logger = createContextLogger('RebuildScript');

// ============================================
// CLI ARGS
// ============================================

program
  .option('-p, --patient <id>', 'Rebuild específico por patientId')
  .option('-b, --batch <size>', 'Tamanho do batch', '100')
  .option('--dry-run', 'Simulação (não salva)')
  .option('--force', 'Força rebuild mesmo se view existir')
  .option('--clear', 'Limpa todas as views antes')
  .parse();

const options = program.opts();

// ============================================
// MAIN
// ============================================

async function main() {
  const startTime = Date.now();
  
  logger.info('🚀 Iniciando rebuild do PatientsView', {
    patientId: options.patient,
    batchSize: options.batch,
    dryRun: options.dryRun,
    force: options.force,
    clear: options.clear
  });
  
  try {
    // Aguarda conexão MongoDB
    await waitForConnection();
    
    // Opção: limpar tudo antes
    if (options.clear && !options.dryRun) {
      logger.warn('🗑️ Limpando todas as views existentes...');
      const clearResult = await PatientsView.deleteMany({});
      logger.info(`✅ Views removidas: ${clearResult.deletedCount}`);
    }
    
    // Rebuild específico
    if (options.patient) {
      await rebuildSingle(options.patient, options);
    } else {
      // Rebuild todos
      await rebuildAll(options);
    }
    
    const duration = Date.now() - startTime;
    logger.info(`✅ Rebuild concluído em ${formatDuration(duration)}`);
    
    process.exit(0);
    
  } catch (error) {
    logger.error('💥 Erro no rebuild', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// ============================================
// REBUILD SINGLE
// ============================================

async function rebuildSingle(patientId, options) {
  logger.info(`🔧 Rebuild single: ${patientId}`);
  
  // Verifica se paciente existe
  const patient = await Patient.findById(patientId);
  if (!patient) {
    throw new Error(`Paciente não encontrado: ${patientId}`);
  }
  
  if (options.dryRun) {
    logger.info(`[DRY-RUN] Rebuild simulado para ${patientId}`);
    return;
  }
  
  const view = await buildPatientView(patientId, { 
    force: options.force,
    correlationId: 'rebuild-script'
  });
  
  logger.info(`✅ View reconstruída`, {
    patientId,
    patientName: patient.fullName,
    viewVersion: view.snapshot?.version,
    stats: view.stats
  });
}

// ============================================
// REBUILD ALL
// ============================================

async function rebuildAll(options) {
  const batchSize = parseInt(options.batch);
  
  logger.info(`🔧 Rebuild all (batch: ${batchSize})`);
  
  // Conta total
  const totalPatients = await Patient.countDocuments();
  logger.info(`📊 Total de pacientes: ${totalPatients}`);
  
  if (totalPatients === 0) {
    logger.info('Nenhum paciente para processar');
    return;
  }
  
  if (options.dryRun) {
    logger.info(`[DRY-RUN] Simulação: ${totalPatients} pacientes seriam processados`);
    return;
  }
  
  // Progress bar simples
  let processed = 0;
  let success = 0;
  let errors = 0;
  let lastLogTime = Date.now();
  
  const stats = {
    totalPatients,
    processed: 0,
    success: 0,
    errors: 0,
    startTime: Date.now()
  };
  
  // Processa em batches
  const cursor = Patient.find({}, '_id fullName').cursor();
  let batch = [];
  
  for await (const patient of cursor) {
    batch.push(patient);
    
    if (batch.length >= batchSize) {
      const result = await processBatch(batch, options);
      
      processed += batch.length;
      success += result.success;
      errors += result.errors;
      
      // Log a cada 5 segundos ou 10%
      const now = Date.now();
      const shouldLog = (now - lastLogTime > 5000) || (processed % Math.max(1, Math.floor(totalPatients / 10)) === 0);
      
      if (shouldLog) {
        const progress = ((processed / totalPatients) * 100).toFixed(1);
        const avgTime = ((now - stats.startTime) / processed).toFixed(0);
        const eta = formatDuration((totalPatients - processed) * avgTime);
        
        logger.info(`⏳ Progresso: ${progress}% (${processed}/${totalPatients}) | ✅ ${success} | ❌ ${errors} | ETA: ${eta}`);
        lastLogTime = now;
      }
      
      batch = [];
    }
  }
  
  // Processa último batch
  if (batch.length > 0) {
    const result = await processBatch(batch, options);
    success += result.success;
    errors += result.errors;
    processed += batch.length;
  }
  
  // Resumo final
  const duration = Date.now() - stats.startTime;
  logger.info(`📊 Resumo do rebuild`, {
    total: totalPatients,
    processed,
    success,
    errors,
    duration: formatDuration(duration),
    avgPerPatient: (duration / processed).toFixed(0) + 'ms'
  });
  
  // Verificação final
  const viewCount = await PatientsView.countDocuments();
  logger.info(`📊 Views criadas: ${viewCount}`);
  
  if (viewCount !== totalPatients) {
    logger.warn(`⚠️ Diferença detectada: ${totalPatients - viewCount} pacientes sem view`);
  }
}

async function processBatch(patients, options) {
  const results = await Promise.allSettled(
    patients.map(patient => 
      buildPatientView(patient._id.toString(), {
        force: options.force,
        correlationId: 'rebuild-batch'
      }).catch(err => {
        logger.error(`❌ Erro em ${patient._id} (${patient.fullName})`, { error: err.message });
        throw err;
      })
    )
  );
  
  const success = results.filter(r => r.status === 'fulfilled').length;
  const errors = results.filter(r => r.status === 'rejected').length;
  
  return { success, errors };
}

// ============================================
// HELPERS
// ============================================

async function waitForConnection() {
  let attempts = 0;
  const maxAttempts = 30;
  
  while (mongoose.connection.readyState !== 1 && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
    logger.info(`⏳ Aguardando MongoDB... (${attempts}/${maxAttempts})`);
  }
  
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Não foi possível conectar ao MongoDB');
  }
  
  logger.info('✅ MongoDB conectado');
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

// ============================================
// RUN
// ============================================

main();
