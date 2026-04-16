#!/usr/bin/env node
/**
 * 🔍 Diagnóstico e correção de Views órfãs de pacientes
 * 
 * Problema: PatientsView existe mas o Patient aggregate correspondente não existe.
 * Isso causa erros como PATIENT_NOT_FOUND ao criar pacotes.
 * 
 * Uso:
 *   node scripts/diagnose-orphan-patient-views.js           # apenas diagnostica
 *   node scripts/diagnose-orphan-patient-views.js --fix     # recria aggregates faltantes
 *   node scripts/diagnose-orphan-patient-views.js --delete  # remove views órfãs
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { createContextLogger } from '../utils/logger.js';

dotenv.config();

const logger = createContextLogger('DiagnoseOrphanViews');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/crm';

async function main() {
  const shouldFix = process.argv.includes('--fix');
  const shouldDelete = process.argv.includes('--delete');
  
  logger.info('Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  
  const db = mongoose.connection.db;
  const patientsCol = db.collection('patients');
  const viewsCol = db.collection('patients_view');
  
  logger.info('Buscando todas as views...');
  const views = await viewsCol.find({}).project({ patientId: 1, fullName: 1, _id: 1 }).toArray();
  
  const orphans = [];
  const valid = [];
  
  for (const view of views) {
    const patientId = view.patientId?.toString();
    if (!patientId) {
      orphans.push({ ...view, reason: 'missing_patientId_in_view' });
      continue;
    }
    
    const patient = await patientsCol.findOne({ _id: new mongoose.Types.ObjectId(patientId) });
    if (!patient) {
      orphans.push({ ...view, reason: 'patient_aggregate_not_found' });
    } else {
      valid.push(view);
    }
  }
  
  console.log('\n========================================');
  console.log(`📊 Total de views: ${views.length}`);
  console.log(`✅ Válidas: ${valid.length}`);
  console.log(`❌ Órfãs: ${orphans.length}`);
  console.log('========================================\n');
  
  if (orphans.length > 0) {
    console.log('❌ Views órfãs detectadas:\n');
    for (const orphan of orphans) {
      console.log(`  - view._id: ${orphan._id.toString()}`);
      console.log(`    patientId: ${orphan.patientId?.toString() || 'N/A'}`);
      console.log(`    nome: ${orphan.fullName || 'N/A'}`);
      console.log(`    motivo: ${orphan.reason}`);
      console.log('');
    }
    
    if (shouldDelete) {
      console.log('🗑️ Removendo views órfãs...');
      for (const orphan of orphans) {
        await viewsCol.deleteOne({ _id: orphan._id });
        console.log(`  🗑️ Removida view de: ${orphan.fullName || orphan._id.toString()}`);
      }
      console.log('✅ Views órfãs removidas.');
    } else if (shouldFix) {
      console.log('🔧 Tentando recriar aggregates a partir das views...');
      for (const orphan of orphans) {
        if (orphan.reason === 'missing_patientId_in_view') {
          console.log(`  ⚠️ Pulando ${orphan.fullName || orphan._id.toString()} (sem patientId na view)`);
          continue;
        }
        
        // Busca dados completos da view
        const fullView = await viewsCol.findOne({ _id: orphan._id });
        
        // Monta dados mínimos para recriar o Patient
        const patientData = {
          _id: new mongoose.Types.ObjectId(orphan.patientId.toString()),
          fullName: fullView.fullName || 'Paciente sem nome',
          dateOfBirth: fullView.dateOfBirth || new Date('1900-01-01'),
          phone: fullView.phone || '',
          email: fullView.email || '',
          cpf: fullView.cpf || '',
          mainComplaint: fullView.mainComplaint || '',
          healthPlan: fullView.healthPlan || {},
          createdAt: fullView.createdAt || new Date(),
          updatedAt: new Date()
        };
        
        try {
          await patientsCol.insertOne(patientData);
          console.log(`  ✅ Recriado Patient: ${patientData.fullName} (${patientData._id.toString()})`);
        } catch (err) {
          console.error(`  ❌ Falha ao recriar ${patientData.fullName}: ${err.message}`);
        }
      }
      console.log('✅ Processo de recriação concluído.');
    } else {
      console.log('💡 Para corrigir, execute um dos comandos:');
      console.log(`   node scripts/diagnose-orphan-patient-views.js --fix    # recria aggregates`);
      console.log(`   node scripts/diagnose-orphan-patient-views.js --delete # remove views órfãs`);
    }
  } else {
    console.log('🎉 Nenhuma view órfã detectada!');
  }
  
  await mongoose.disconnect();
  console.log('\n👋 Done.');
}

main().catch(err => {
  logger.error('Erro fatal:', err.message);
  console.error(err);
  process.exit(1);
});
