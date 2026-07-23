#!/usr/bin/env node
/**
 * Auditoria READ-ONLY: guias per_month são faturadas em UM único lote (billing
 * completo do período) ou em MÚLTIPLOS lotes ao longo do tempo (faturamento
 * parcial)?
 *
 * Isso valida (ou invalida) a premissa por trás de closeGuideBillingPeriod
 * (fecha automaticamente em TODO faturamento bem-sucedido da guia) — se
 * faturamento parcial for um padrão real, cancelar pendências no primeiro
 * lote seria incorreto (canceleria sessões que a secretária ainda pretendia
 * completar depois, na mesma guia).
 *
 * Não escreve nada no banco. Uso:
 *   node scripts/audits/audit-guide-partial-billing-pattern.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Session from '../../models/Session.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI/MONGO_URI não encontrado no .env');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('Conectado. Verificando padrão de faturamento por guia per_month...\n');

  const perMonthGuideIds = await InsuranceGuide.find({ billingMode: 'per_month' }).distinct('_id');
  console.log(`Guias per_month no total: ${perMonthGuideIds.length}`);

  const agg = await Session.aggregate([
    {
      $match: {
        insuranceGuide: { $in: perMonthGuideIds },
        billingBatchId: { $ne: null }
      }
    },
    {
      $group: {
        _id: '$insuranceGuide',
        batchIds: { $addToSet: '$billingBatchId' },
        sessionCount: { $sum: 1 },
        minDate: { $min: '$date' },
        maxDate: { $max: '$date' }
      }
    },
    { $match: { $expr: { $gt: [{ $size: '$batchIds' }, 1] } } }
  ]);

  console.log(`\nGuias per_month faturadas em MAIS DE UM lote distinto: ${agg.length}\n`);

  if (agg.length === 0) {
    console.log('=> Nenhuma evidência de faturamento parcial/repetido da mesma guia per_month.');
    console.log('=> Premissa de closeGuideBillingPeriod (1 guia = 1 fechamento definitivo) é consistente com o histórico real.');
  } else {
    console.log('=> ATENÇÃO: existe faturamento parcial real. Detalhe por guia:\n');
    for (const row of agg) {
      const guide = await InsuranceGuide.findById(row._id).select('number insurance billingMode').lean();
      const batches = await InsuranceBatch.find({ _id: { $in: row.batchIds } })
        .select('batchNumber status createdAt sentDate')
        .sort({ createdAt: 1 })
        .lean();
      console.log(`Guia ${guide?.number} (${guide?.insurance}) — ${row.batchIds.length} lotes distintos, ${row.sessionCount} sessões faturadas, datas de sessão de ${row.minDate?.toISOString?.().slice(0,10)} a ${row.maxDate?.toISOString?.().slice(0,10)}`);
      batches.forEach((b) => {
        console.log(`   lote ${b.batchNumber} | status=${b.status} | criado=${b.createdAt?.toISOString?.().slice(0,10)} | enviado=${b.sentDate ? b.sentDate.toISOString().slice(0,10) : '—'}`);
      });
      console.log('');
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
