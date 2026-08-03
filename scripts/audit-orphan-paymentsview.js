#!/usr/bin/env node
/**
 * audit-orphan-paymentsview.js
 *
 * Lista as PaymentsView órfãs (sem Payment correspondente).
 */

import mongoose from 'mongoose';
import '../models/index.js';
import PaymentsView from '../models/PaymentsView.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

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
      { $sort: { createdAt: -1 } },
      { $limit: 50 }
    ]);

    console.log(`\n🔍 Encontradas ${orphans.length} views órfãs (primeiras 50):`);
    for (const v of orphans) {
      console.log({
        viewId: v._id,
        paymentId: v.paymentId,
        patient: v.patient,
        amount: v.amount,
        status: v.status,
        category: v.category,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt
      });
    }

    // Verifica duplicatas de paymentId na view
    const dups = await PaymentsView.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $group: { _id: '$paymentId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);
    console.log(`\n📊 Duplicatas de paymentId na view: ${dups.length}`);
    if (dups.length) console.log(dups);

  } catch (error) {
    console.error('❌ Erro:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
  }
}

main();
