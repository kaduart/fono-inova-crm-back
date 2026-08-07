#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });
dotenv.config();

import '../models/index.js';
import Payment from '../models/Payment.js';

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI/MONGO_URI não encontrado');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('Conectado. Diagnóstico de payments duplicados de convênio...\n');

  // Verifica índice único
  const indexes = await Payment.collection.getIndexes({ full: true });
  console.log('=== ÍNDICES DE PAYMENTS ===');
  const target = indexes.find(i => i.name === 'unique_active_convenio_payment_per_session');
  if (target) {
    console.log('Índice encontrado:', JSON.stringify(target, null, 2));
  } else {
    console.log('❌ ÍNDICE NÃO ENCONTRADO');
    console.log('Índices existentes:', indexes.map(i => i.name).join(', '));
  }

  // Conta duplicados ativos
  const dupes = await Payment.aggregate([
    {
      $match: {
        billingType: 'convenio',
        session: { $exists: true, $ne: null },
        status: { $nin: ['canceled', 'cancelled', 'refunded', 'converted_to_package', 'recognized', 'consumed'] }
      }
    },
    { $group: { _id: '$session', count: { $sum: 1 }, payments: { $push: { id: '$_id', provider: '$insurance.provider', serviceType: '$serviceType', amount: '$amount', status: '$status', createdAt: '$createdAt' } } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 100 }
  ]);

  console.log(`\n=== DUPLICADOS ATIVOS: ${dupes.length} sessions ===`);
  for (const d of dupes.slice(0, 20)) {
    console.log(`\nSession ${d._id}: ${d.count} payments`);
    for (const p of d.payments) {
      console.log(`  ${p.id} | ${p.provider || 'n/a'} | ${p.serviceType || 'n/a'} | ${p.amount} | ${p.status} | ${p.createdAt?.toISOString?.() || p.createdAt}`);
    }
  }

  const totalDuplicados = dupes.reduce((s, d) => s + d.count, 0);
  console.log(`\nTotal de payments em duplicidade (top 100 sessions): ${totalDuplicados}`);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
