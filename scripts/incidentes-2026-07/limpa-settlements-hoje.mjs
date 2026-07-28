import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

const TODAY = new Date('2026-07-27T00:00:00-03:00');
const TOMORROW = new Date('2026-07-28T00:00:00-03:00');

const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  await mongoose.connect(MONGO_URI);
  const Payment = (await import('../models/Payment.js')).default;
  const Patient = (await import('../models/Patient.js')).default;

  const settlements = await Payment.find({
    kind: 'monthly_settlement',
    status: { $in: ['paid', 'completed', 'confirmed'] },
    $or: [
      { paidAt: { $gte: TODAY, $lt: TOMORROW } },
      { financialDate: { $gte: TODAY, $lt: TOMORROW } },
      { createdAt: { $gte: TODAY, $lt: TOMORROW } }
    ]
  }).populate('patient', 'fullName').lean();

  console.log('══════════════════════════════════════════════════════════');
  console.log('  LIMPEZA DE MONTHLY_SETTLEMENTS DUPLICADOS DE HOJE');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`🧪 DRY_RUN: ${DRY_RUN}`);
  console.log(`Encontrados: ${settlements.length} monthly_settlement(s)\n`);

  let total = 0;
  for (const s of settlements) {
    total += s.amount || 0;
    console.log(`  ${s._id.toString()} | ${s.patient?.fullName || 'N/A'} | R$ ${(s.amount || 0).toFixed(2)} | ${s.paymentMethod} | settled: ${(s.settledPaymentIds || []).length}`);
  }
  console.log(`\nTotal a remover do caixa: R$ ${total.toFixed(2)}`);

  if (!DRY_RUN) {
    const ids = settlements.map(s => s._id);
    const result = await Payment.deleteMany({ _id: { $in: ids } });
    console.log(`\n✅ Removidos: ${result.deletedCount} documento(s)`);
  } else {
    console.log(`\n⚠️  MODO DRY-RUN — nenhuma alteração feita.`);
    console.log(`   Rode com --apply para executar a remoção.`);
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
