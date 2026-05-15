import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const isDryRun = !process.argv.includes('--apply');
  console.log(`Modo: ${isDryRun ? 'DRY-RUN (use --apply para executar)' : 'APLICAR'}\n`);

  const pkgId = new mongoose.Types.ObjectId('69d3107ba14c560c7eb92aca');

  // 1. Verificar package
  const pkg = await db.collection('packages').findOne({ _id: pkgId });
  if (!pkg) {
    console.log('Package não encontrado');
    await mongoose.disconnect();
    return;
  }

  console.log('Package encontrado:');
  console.log('  Status:', pkg.status);
  console.log('  Type:', pkg.type);
  console.log('  Patient:', pkg.patient?.toString());
  console.log('  Sessions:', pkg.sessions?.length || 0);
  console.log('  Appointments:', pkg.appointments?.length || 0);
  console.log('  Payments:', pkg.payments?.length || 0);
  console.log('  InsuranceGuide:', pkg.insuranceGuide?.toString() || 'null');

  if (isDryRun) {
    console.log('\n[DRY-RUN] Ações que seriam executadas:');
    console.log('  1. Package status → superseded');
    console.log('  2. Sessions do package → cancelled');
    console.log('  3. Migration marker adicionado');
    await mongoose.disconnect();
    return;
  }

  // Aplicar correções
  console.log('\nAplicando correções...');

  // 1. Arquivar package
  await db.collection('packages').updateOne(
    { _id: pkgId },
    {
      $set: {
        status: 'superseded',
        migratedToInsuranceGuide: true,
        migratedAt: new Date(),
        migrationVersion: 'v2',
        migrationReason: 'orphan_patient_deleted'
      }
    }
  );
  console.log('  ✓ Package arquivado como superseded');

  // 2. Cancelar sessions órfãs
  const sessionIds = (pkg.sessions || []).map(id => 
    typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
  );
  if (sessionIds.length > 0) {
    await db.collection('sessions').updateMany(
      { _id: { $in: sessionIds } },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancellationReason: 'orphan_patient_deleted' } }
    );
    console.log(`  ✓ ${sessionIds.length} sessions canceladas`);
  }

  console.log('\n✅ Correções aplicadas com sucesso');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
