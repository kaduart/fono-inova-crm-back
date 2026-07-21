// scripts/migrations/migrate-authorization-to-communication.js
// Migra dados legados do módulo Authorization para o novo domínio Communication.
// Uso:
//   node scripts/migrations/migrate-authorization-to-communication.js --dry-run
//   node scripts/migrations/migrate-authorization-to-communication.js --commit

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from 'dotenv';

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI não configurado no .env');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const COMMIT = process.argv.includes('--commit');

if (!DRY_RUN && !COMMIT) {
  console.log('Uso: node scripts/migrations/migrate-authorization-to-communication.js [--dry-run|--commit]');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI, { readPreference: 'primary', retryWrites: true, w: 'majority' });
  const db = mongoose.connection.db;

  console.log(`🔄 Modo: ${DRY_RUN ? 'DRY-RUN' : 'COMMIT'}`);

  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  // 1. Renomear collections: se as novas existirem vazias, dropa para permitir rename
  const renames = [
    { from: 'authorizationrequests', to: 'insurancecommunications' },
    { from: 'authorizationpackages', to: 'communicationpackages' },
    { from: 'authorizationemaillogs', to: 'communicationemaillogs' }
  ];

  for (const { from, to } of renames) {
    const fromExists = collectionNames.includes(from);
    const toExists = collectionNames.includes(to);

    if (fromExists && toExists) {
      const toCount = await db.collection(to).countDocuments();
      if (toCount === 0) {
        console.log(`🗑️  Collection '${to}' vazia. Dropando para renomear '${from}'.`);
        if (COMMIT) await db.collection(to).drop();
      } else {
        console.log(`⚠️ Collection destino '${to}' já existe com ${toCount} documentos. Não renomeando '${from}'.`);
        continue;
      }
    }

    if (collectionNames.includes(from)) {
      console.log(`📦 Renomeando ${from} -> ${to}`);
      if (COMMIT) await db.collection(from).rename(to);
    } else if (collectionNames.includes(to)) {
      console.log(`✅ Collection '${to}' já existe.`);
    } else {
      console.log(`ℹ️ Collection '${from}' não encontrada.`);
    }
  }

  // 2. Adicionar purpose='authorization' nos registros que não têm
  const commCollection = db.collection('insurancecommunications');
  const commCount = await commCollection.countDocuments({ purpose: { $exists: false } });
  console.log(`📨 Communications sem purpose: ${commCount}`);
  if (COMMIT && commCount > 0) {
    await commCollection.updateMany(
      { purpose: { $exists: false } },
      { $set: { purpose: 'authorization' } }
    );
    console.log('✅ purpose=authorization aplicado.');
  }

  // 3. Renomear authorizationRequestId -> communicationId em packages e logs
  const pkgCollection = db.collection('communicationpackages');
  const pkgCount = await pkgCollection.countDocuments({ authorizationRequestId: { $exists: true } });
  console.log(`📦 Packages com authorizationRequestId: ${pkgCount}`);
  if (COMMIT && pkgCount > 0) {
    await pkgCollection.updateMany(
      { authorizationRequestId: { $exists: true } },
      { $rename: { authorizationRequestId: 'communicationId' } }
    );
  }

  const logCollection = db.collection('communicationemaillogs');
  const logWithAuthReq = await logCollection.countDocuments({ authorizationRequestId: { $exists: true } });
  const logWithAuthPkg = await logCollection.countDocuments({ authorizationPackageId: { $exists: true } });
  console.log(`📧 Logs com authorizationRequestId: ${logWithAuthReq}`);
  console.log(`📧 Logs com authorizationPackageId: ${logWithAuthPkg}`);
  if (COMMIT && (logWithAuthReq > 0 || logWithAuthPkg > 0)) {
    const renameOps = {};
    if (logWithAuthReq > 0) renameOps.authorizationRequestId = 'communicationId';
    if (logWithAuthPkg > 0) renameOps.authorizationPackageId = 'communicationPackageId';
    await logCollection.updateMany(
      { $or: [
        { authorizationRequestId: { $exists: true } },
        { authorizationPackageId: { $exists: true } }
      ]},
      { $rename: renameOps }
    );
  }

  // 4. Migrar Convenio.authorizationRules -> communicationRules.authorization
  const convenioCollection = db.collection('convenios');
  const conveniosWithAuthRules = await convenioCollection.countDocuments({ authorizationRules: { $exists: true, $ne: null } });
  console.log(`🏥 Convênios com authorizationRules legado: ${conveniosWithAuthRules}`);
  if (COMMIT && conveniosWithAuthRules > 0) {
    const cursor = convenioCollection.find({ authorizationRules: { $exists: true, $ne: null } });
    for await (const doc of cursor) {
      const setOp = {
        'communicationRules.authorization': doc.authorizationRules
      };
      await convenioCollection.updateOne(
        { _id: doc._id },
        { $set: setOp, $unset: { authorizationRules: 1 } }
      );
    }
    console.log('✅ Regras migradas para communicationRules.authorization.');
  }

  // 5. Resumo final
  const finalComm = await commCollection.countDocuments({ purpose: 'authorization' });
  const finalPkg = await pkgCollection.countDocuments();
  const finalLog = await logCollection.countDocuments();
  const finalConvenio = await convenioCollection.countDocuments({ 'communicationRules.authorization': { $exists: true } });

  console.log('\n📊 Resumo:');
  console.log(`  InsuranceCommunications: ${finalComm}`);
  console.log(`  CommunicationPackages: ${finalPkg}`);
  console.log(`  CommunicationEmailLogs: ${finalLog}`);
  console.log(`  Convênios com communicationRules.authorization: ${finalConvenio}`);

  await mongoose.disconnect();
  console.log(DRY_RUN ? '\n🏁 Dry-run finalizado. Use --commit para aplicar.' : '\n🏁 Migration aplicada.');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Erro na migration:', err);
  process.exit(1);
});
