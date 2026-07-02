#!/usr/bin/env node
/**
 * Verifica guias ativas/linked próximas do vencimento e se canRenew está true.
 *
 * Uso:
 *   node scripts/verificar-renovacao-guias-proximas.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GuideLifecycleService } from '../services/guideLifecycle/GuideLifecycleService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI ou MONGO_URI não configurado no .env');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Conectado ao MongoDB');

  const db = mongoose.connection.db;

  try {
    const hoje = new Date();
    const limite = new Date();
    limite.setDate(hoje.getDate() + 7);

    const guias = await db.collection('insuranceguides').find({
      status: { $in: ['active', 'linked'] },
      expiresAt: { $gte: hoje, $lte: limite }
    }).toArray();

    console.log(`Guias ativas/linked vencendo nos próximos 7 dias: ${guias.length}\n`);

    for (const g of guias) {
      const lifecycle = await GuideLifecycleService.evaluate(g, hoje);
      console.log(`Guia: ${g.number || '(sem número)'}`);
      console.log(`  Convênio: ${g.insurance}`);
      console.log(`  Especialidade: ${g.specialty}`);
      console.log(`  Status: ${g.status}`);
      console.log(`  Expira em: ${new Date(g.expiresAt).toISOString()}`);
      console.log(`  canRenew: ${lifecycle.eligibility.canRenew}`);
      console.log(`  Alerts: ${lifecycle.alerts.map(a => a.code).join(', ') || 'nenhum'}`);
      console.log('');
    }

  } finally {
    await mongoose.disconnect();
    console.log('Desconectado do MongoDB');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
