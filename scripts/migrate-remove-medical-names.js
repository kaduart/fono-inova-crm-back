/**
 * 🧹 MIGRAÇÃO: Remove termos médicos salvos como nomes de pacientes
 *
 * Este script limpa dados ANTIGOS (de antes do BUG #2 fix) onde termos médicos
 * como "Psicologia", "Pediatra", "Fisioterapia" foram incorretamente salvos
 * como nomes de pacientes.
 *
 * IMPORTANTE: Execute APENAS UMA VEZ após o deploy do fix
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// ========================================
// CONFIGURAÇÃO
// ========================================

const MEDICAL_TERMS_REGEX = [
  /^psicologia$/i,
  /^psicologa?$/i,
  /^psico$/i,
  /^pediatra$/i,
  /^pediatria$/i,
  /^fono$/i,
  /^fonoaudiol(og)?a?$/i,
  /^fonoaudiologia$/i,
  /^fisioterapia$/i,
  /^fisioterapeuta$/i,
  /^fisio$/i,
  /^terapia$/i,
  /^terapeuta$/i,
  /^neuropsicolog(o|a|ia)?$/i,
  /^neuro$/i,
  /^ocupacional$/i,
  /^psicopedagog(o|a|ia)?$/i,
  /^musicoterapia$/i,
  /^terapia\s+(ocupacional|infantil|cognitiva)/i,
  /^psicologia\s+infantil$/i,
  // Adicione mais padrões se necessário
];

// ========================================
// CONEXÃO MONGODB
// ========================================

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Conectado ao MongoDB');
  } catch (error) {
    console.error('❌ Erro ao conectar MongoDB:', error.message);
    process.exit(1);
  }
}

// ========================================
// ANÁLISE
// ========================================

async function analyzeLeads() {
  console.log('\n🔍 ANALISANDO LEADS COM POSSÍVEIS TERMOS MÉDICOS...\n');

  const db = mongoose.connection.db;
  const leads = await db.collection('leads').find({
    'autoBookingContext.patientInfo.fullName': { $exists: true, $ne: null }
  }).toArray();

  const problematicLeads = [];

  for (const lead of leads) {
    const fullName = lead.autoBookingContext?.patientInfo?.fullName;

    if (!fullName || typeof fullName !== 'string') continue;

    const isMedicalTerm = MEDICAL_TERMS_REGEX.some(regex => regex.test(fullName.trim()));

    if (isMedicalTerm) {
      problematicLeads.push({
        _id: lead._id,
        phone: lead.contact?.phone,
        fullName: fullName,
        createdAt: lead.createdAt
      });
    }
  }

  return problematicLeads;
}

// ========================================
// LIMPEZA
// ========================================

async function cleanMedicalNames(problematicLeads, dryRun = true) {
  console.log(`\n🧹 ${ dryRun ? 'SIMULAÇÃO DE' : 'EXECUTANDO' } LIMPEZA...\n`);

  const db = mongoose.connection.db;
  let cleanedCount = 0;

  for (const lead of problematicLeads) {
    console.log(`📋 Lead ID: ${lead._id}`);
    console.log(`   Telefone: ${lead.phone}`);
    console.log(`   Nome problemático: "${lead.fullName}"`);
    console.log(`   Criado em: ${lead.createdAt}`);

    if (!dryRun) {
      try {
        const result = await db.collection('leads').updateOne(
          { _id: lead._id },
          {
            $set: {
              'autoBookingContext.patientInfo.fullName': null
            }
          }
        );

        if (result.modifiedCount > 0) {
          console.log(`   ✅ Nome removido com sucesso\n`);
          cleanedCount++;
        } else {
          console.log(`   ⚠️  Nenhuma modificação realizada\n`);
        }
      } catch (error) {
        console.error(`   ❌ Erro ao limpar: ${error.message}\n`);
      }
    } else {
      console.log(`   🔄 [DRY RUN] Seria removido\n`);
      cleanedCount++;
    }
  }

  return cleanedCount;
}

// ========================================
// RELATÓRIO
// ========================================

function generateReport(problematicLeads, cleanedCount, dryRun) {
  console.log('\n' + '═'.repeat(80));
  console.log('📊 RELATÓRIO DA MIGRAÇÃO');
  console.log('═'.repeat(80));
  console.log(`\n📍 Modo: ${dryRun ? 'SIMULAÇÃO (DRY RUN)' : 'EXECUÇÃO REAL'}`);
  console.log(`📈 Leads analisados: ${problematicLeads.length} com termos médicos como nome`);
  console.log(`🧹 Leads ${dryRun ? 'que seriam' : ''} limpos: ${cleanedCount}`);

  if (dryRun) {
    console.log('\n⚠️  ATENÇÃO: Esta foi apenas uma SIMULAÇÃO!');
    console.log('   Para executar a limpeza de verdade, rode:');
    console.log('   node backend/scripts/migrate-remove-medical-names.js --execute\n');
  } else {
    console.log('\n✅ Migração concluída com sucesso!\n');
  }

  console.log('═'.repeat(80));
  console.log('\n📋 DETALHES DOS LEADS AFETADOS:\n');

  const termsCount = {};

  problematicLeads.forEach(lead => {
    const term = lead.fullName;
    termsCount[term] = (termsCount[term] || 0) + 1;
  });

  Object.entries(termsCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([term, count]) => {
      console.log(`   "${term}": ${count} lead(s)`);
    });

  console.log('\n');
}

// ========================================
// CONFIRMAÇÃO INTERATIVA
// ========================================

async function confirmExecution() {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('\n⚠️  ATENÇÃO: Você está prestes a MODIFICAR dados no banco de produção!\n   Deseja continuar? (digite "SIM" para confirmar): ', (answer) => {
      rl.close();
      resolve(answer.trim().toUpperCase() === 'SIM');
    });
  });
}

// ========================================
// MAIN
// ========================================

async function main() {
  const args = process.argv.slice(2);
  const executeMode = args.includes('--execute');
  const forceMode = args.includes('--force');

  console.log('\n🧹 MIGRAÇÃO: Remover Termos Médicos como Nomes de Pacientes');
  console.log('═'.repeat(80));

  await connectDB();

  // 1. Análise
  const problematicLeads = await analyzeLeads();

  if (problematicLeads.length === 0) {
    console.log('\n✅ Nenhum lead com termo médico como nome encontrado!');
    console.log('   A base de dados está limpa.\n');
    await mongoose.connection.close();
    return;
  }

  console.log(`\n⚠️  Encontrados ${problematicLeads.length} leads com termos médicos como nome:\n`);

  // Preview dos primeiros 5
  const preview = problematicLeads.slice(0, 5);
  preview.forEach(lead => {
    console.log(`   • ID: ${lead._id} | Nome: "${lead.fullName}" | Tel: ${lead.phone}`);
  });

  if (problematicLeads.length > 5) {
    console.log(`   ... e mais ${problematicLeads.length - 5} leads`);
  }

  // 2. Confirmação (se modo --execute)
  if (executeMode && !forceMode) {
    const confirmed = await confirmExecution();

    if (!confirmed) {
      console.log('\n❌ Operação cancelada pelo usuário.\n');
      await mongoose.connection.close();
      return;
    }
  }

  // 3. Limpeza
  const cleanedCount = await cleanMedicalNames(problematicLeads, !executeMode);

  // 4. Relatório
  generateReport(problematicLeads, cleanedCount, !executeMode);

  await mongoose.connection.close();
  console.log('👋 Conexão fechada. Até logo!\n');
}

// ========================================
// EXECUTAR
// ========================================

main().catch(console.error);
