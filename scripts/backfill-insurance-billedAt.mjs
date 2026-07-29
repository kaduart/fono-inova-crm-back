/**
 * Backfill rastreável: preenche insurance.billedAt em payments de convênio faturados.
 *
 * Regra de prioridade para descobrir a data de faturamento:
 * 1. Payment.billedAt (campo de nível superior) se existir
 * 2. InsuranceBatch.sentDate/createdAt quando o payment/session está em um lote
 * 3. Payment.updatedAt como fallback final
 *
 * Uso: node back/scripts/backfill-insurance-billedAt.mjs [--dry-run]
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI não definido');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`🚀 Conectado ao MongoDB${DRY_RUN ? ' (DRY-RUN)' : ''}`);

  // Payments elegíveis: convênio, insurance.status=billed, sem insurance.billedAt
  const filter = {
    billingType: 'convenio',
    'insurance.status': 'billed',
    $or: [
      { 'insurance.billedAt': { $exists: false } },
      { 'insurance.billedAt': null }
    ]
  };

  const total = await Payment.countDocuments(filter);
  console.log(`📊 Payments elegíveis para backfill: ${total}`);

  if (total === 0) {
    console.log('✅ Nada a fazer.');
    await mongoose.disconnect();
    return;
  }

  // Carrega batches enviados. No banco real, type pode ser null; o que importa é status=sent.
  const batches = await InsuranceBatch.find({
    status: { $in: ['sent', 'received'] }
  }).select('sessions sentDate createdAt').lean();

  // Mapas de lookup
  const billedAtByPaymentId = new Map();
  const billedAtBySessionId = new Map();

  for (const batch of batches) {
    const fallbackDate = batch.sentDate || batch.createdAt;
    if (!fallbackDate) continue;
    for (const s of batch.sessions || []) {
      if (s.payment) billedAtByPaymentId.set(s.payment.toString(), fallbackDate);
      if (s.session) billedAtBySessionId.set(s.session.toString(), fallbackDate);
    }
  }

  const cursor = Payment.find(filter).select('_id billedAt session updatedAt').cursor();
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let payment = await cursor.next(); payment != null; payment = await cursor.next()) {
    try {
      let resolvedDate = null;
      const source = [];

      if (payment.billedAt) {
        resolvedDate = payment.billedAt;
        source.push('Payment.billedAt');
      } else {
        const paymentId = payment._id.toString();
        const sessionId = payment.session?.toString();

        if (billedAtByPaymentId.has(paymentId)) {
          resolvedDate = billedAtByPaymentId.get(paymentId);
          source.push('InsuranceBatch.payment');
        } else if (sessionId && billedAtBySessionId.has(sessionId)) {
          resolvedDate = billedAtBySessionId.get(sessionId);
          source.push('InsuranceBatch.session');
        } else {
          resolvedDate = payment.updatedAt;
          source.push('Payment.updatedAt(fallback)');
        }
      }

      if (!resolvedDate) {
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`[DRY-RUN] ${payment._id} <- ${resolvedDate.toISOString()} (${source.join(', ')})`);
        updated++;
        continue;
      }

      const sourceTag = source.includes('Payment.billedAt')
        ? 'payment.billedAt'
        : source.includes('InsuranceBatch.payment')
        ? 'batch.sentDate'
        : source.includes('InsuranceBatch.session')
        ? 'batch.sentDate'
        : 'updatedAt';

      await Payment.updateOne(
        { _id: payment._id },
        { $set: { 'insurance.billedAt': resolvedDate, 'insurance.billedAtSource': sourceTag } }
      );
      updated++;
    } catch (err) {
      errors++;
      console.error(`❌ Erro no payment ${payment._id}:`, err.message);
    }
  }

  await cursor.close();

  console.log('\n📋 Resumo:');
  console.log(`  Total elegível: ${total}`);
  console.log(`  Atualizados:    ${updated}`);
  console.log(`  Ignorados:      ${skipped}`);
  console.log(`  Erros:          ${errors}`);

  await mongoose.disconnect();
  console.log('🔌 Desconectado.');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
