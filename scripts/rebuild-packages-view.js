/**
 * 🔧 Rebuild Total da PackagesView
 *
 * Production-safe script que:
 * 1. Rebuilda a view de TODOS os packages reais
 * 2. Remove views órfãs (ghost records)
 * 3. Gera relatório completo
 *
 * Uso:
 *   node scripts/rebuild-packages-view.js
 *   node scripts/rebuild-packages-view.js --dry-run
 *   node scripts/rebuild-packages-view.js --patientId=68c018f7198227a9b37da49a
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
// ⚠️ PatientsView DEVE ser importado antes de InsuranceGuide (que usa identityResolver)
import PatientsView from '../models/PatientsView.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Package from '../models/Package.js';
import PackagesView from '../models/PackagesView.js';
import { buildPackageView } from '../domains/billing/services/PackageProjectionService.js';

// Força registro dos modelos no mongoose (evita Schema hasn't been registered)
void PatientsView;
void Patient;
void Doctor;
void InsuranceGuide;

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const PATIENT_ID_ARG = process.argv.find((arg) => arg.startsWith('--patientId='));
const TARGET_PATIENT_ID = PATIENT_ID_ARG ? PATIENT_ID_ARG.split('=')[1] : null;
const BATCH_SIZE = 50;

async function main() {
  const startTime = Date.now();
  console.log('🚀 [Rebuild Packages View] Iniciando...');
  console.log(`   Modo: ${DRY_RUN ? 'DRY-RUN (sem alterações)' : 'LIVE'}`);
  if (TARGET_PATIENT_ID) {
    console.log(`   Filtro: patientId = ${TARGET_PATIENT_ID}`);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB conectado');

  // 1️⃣ Buscar packages reais
  const query = TARGET_PATIENT_ID ? { patient: TARGET_PATIENT_ID } : {};
  const realPackages = await Package.find(query).select('_id patient').lean();
  const realPackageIds = new Set(realPackages.map((p) => p._id.toString()));

  console.log(`\n📦 Packages reais encontrados: ${realPackageIds.size}`);

  // 2️⃣ Rebuild em batches
  let rebuilt = 0;
  let failed = 0;
  const errors = [];

  const packagesToRebuild = TARGET_PATIENT_ID
    ? realPackages
    : await Package.find({}).select('_id').lean();

  for (let i = 0; i < packagesToRebuild.length; i += BATCH_SIZE) {
    const batch = packagesToRebuild.slice(i, i + BATCH_SIZE);
    console.log(`\n⚙️  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(packagesToRebuild.length / BATCH_SIZE)} (${batch.length} items)`);

    for (const pkg of batch) {
      try {
        if (!DRY_RUN) {
          await buildPackageView(pkg._id.toString(), {
            correlationId: `rebuild_${Date.now()}_${pkg._id}`,
          });
        }
        rebuilt++;
        process.stdout.write('.');
      } catch (err) {
        failed++;
        errors.push({ packageId: pkg._id.toString(), error: err.message });
        process.stdout.write('X');
      }
    }
  }

  console.log('\n');

  // 3️⃣ Identificar views órfãs
  const viewQuery = TARGET_PATIENT_ID ? { patientId: TARGET_PATIENT_ID } : {};
  const allViews = await PackagesView.find(viewQuery).select('packageId _id').lean();
  const orphanViews = allViews.filter((v) => !realPackageIds.has(v.packageId?.toString()));

  console.log(`👻 Views órfãs encontradas: ${orphanViews.length}`);
  orphanViews.forEach((v) => {
    console.log(`   - view _id: ${v._id} | packageId: ${v.packageId}`);
  });

  // 4️⃣ Remover views órfãs
  let deletedCount = 0;
  if (orphanViews.length > 0 && !DRY_RUN) {
    const orphanPackageIds = orphanViews.map((v) => v.packageId);
    const deleteResult = await PackagesView.deleteMany({
      packageId: { $in: orphanPackageIds },
    });
    deletedCount = deleteResult.deletedCount;
    console.log(`🗑️  Views órfãs removidas: ${deletedCount}`);
  } else if (DRY_RUN) {
    console.log('🗑️  [DRY-RUN] Nenhuma view órfã foi removida');
  }

  // 5️⃣ Verificação final
  const finalViewsCount = await PackagesView.countDocuments(viewQuery);
  const expectedCount = TARGET_PATIENT_ID
    ? realPackageIds.size
    : await Package.countDocuments({});

  console.log('\n📊 RELATÓRIO FINAL:');
  console.log(`   Packages reais:        ${expectedCount}`);
  console.log(`   Views rebuildadas:     ${rebuilt}`);
  console.log(`   Falhas no rebuild:     ${failed}`);
  console.log(`   Views órfãs removidas: ${deletedCount}`);
  console.log(`   Total views atual:     ${finalViewsCount}`);
  console.log(`   Consistente:           ${finalViewsCount === expectedCount ? '✅ SIM' : '❌ NÃO'}`);

  if (errors.length > 0) {
    console.log('\n❌ Erros durante rebuild:');
    errors.slice(0, 10).forEach((e) => {
      console.log(`   - ${e.packageId}: ${e.error}`);
    });
    if (errors.length > 10) {
      console.log(`   ... e mais ${errors.length - 10} erros`);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n⏱️  Duração total: ${duration}s`);

  await mongoose.disconnect();
  console.log('🔌 Conexão MongoDB fechada');

  // Exit code 1 se houve falhas
  if (failed > 0 || finalViewsCount !== expectedCount) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('💥 Erro fatal:', err);
  process.exit(1);
});
