#!/usr/bin/env node
/**
 * cleanup-orphan-paymentsview.js
 *
 * Soft-delete PaymentsView cujo paymentId não existe mais na coleção payments.
 *
 * Uso:
 *   node back/scripts/cleanup-orphan-paymentsview.js --dry-run
 *   node back/scripts/cleanup-orphan-paymentsview.js --execute
 */

import mongoose from 'mongoose';
import '../models/index.js';
import PaymentsView from '../models/PaymentsView.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const EXECUTE = process.argv.includes('--execute');
const DRY_RUN = process.argv.includes('--dry-run') || !EXECUTE;

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI ou MONGO_URI devem estar configurados');
  process.exit(1);
}

async function main() {
  console.log('🔌 Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado');

  try {
    const orphans = await PaymentsView.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      {
        $lookup: {
          from: 'payments',
          localField: 'paymentId',
          foreignField: '_id',
          as: 'payment'
        }
      },
      { $match: { payment: { $size: 0 } } },
      { $project: { _id: 1, paymentId: 1 } }
    ]);

    console.log(`\n🔍 Views órfãs encontradas: ${orphans.length}`);

    if (orphans.length === 0) {
      console.log('✅ Nada a limpar.');
      return;
    }

    if (DRY_RUN) {
      console.log('\n🛑 MODO DRY-RUN. Nenhuma alteração foi feita.');
      console.log('Para executar, rode com --execute');
      console.log(`\nPrimeiros 10 IDs que seriam afetados:`);
      console.log(orphans.slice(0, 10).map(o => o._id.toString()));
      return;
    }

    const ids = orphans.map(o => o._id);
    const result = await PaymentsView.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          isDeleted: true,
          status: 'canceled',
          updatedAt: new Date()
        }
      }
    );

    console.log('\n✅ Cleanup executado:');
    console.log(`   matched: ${result.matchedCount}`);
    console.log(`   modified: ${result.modifiedCount}`);
  } catch (error) {
    console.error('❌ Erro:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
  }
}

main();
