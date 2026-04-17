#!/usr/bin/env node
/**
 * 🔄 Rebuild completo de todas as patients_view
 *
 * Recalcula o read model (patients_view) para todos os pacientes.
 * Útil após deleções em massa, migrações ou quando views ficam inconsistentes.
 *
 * Uso:
 *   node scripts/rebuild-all-patient-views.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { createContextLogger } from '../utils/logger.js';
import { rebuildAllViews } from '../domains/clinical/services/patientProjectionService.js';

dotenv.config();

const logger = createContextLogger('RebuildAllPatientViews');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/crm';

async function main() {
  logger.info('Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  logger.info('Conectado.');

  logger.info('Iniciando rebuild completo de todas as patients_view...');

  const result = await rebuildAllViews({
    batchSize: 50,
    onProgress: ({ processed, total, errors }) => {
      const pct = ((processed / total) * 100).toFixed(1);
      console.log(`Progresso: ${processed}/${total} (${pct}%) | Erros: ${errors}`);
    }
  });

  console.log('\n========================================');
  console.log('✅ Rebuild concluído!');
  console.log(`   Total de pacientes: ${result.total}`);
  console.log(`   Processados:        ${result.processed}`);
  console.log(`   Erros:              ${result.errors}`);
  console.log('========================================\n');

  await mongoose.disconnect();
  logger.info('Desconectado.');
  process.exit(0);
}

main().catch(err => {
  logger.error('Erro fatal:', err.message);
  console.error(err);
  process.exit(1);
});
