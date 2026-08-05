#!/usr/bin/env node
/**
 * test-paymentsview-event.js
 *
 * Testa handlePaymentEvent com um payment real da produção (read-only,
 * mas faz upsert na view para validar o fluxo).
 */

import mongoose from 'mongoose';
import '../models/index.js';
import Payment from '../models/Payment.js';
import PaymentsView from '../models/PaymentsView.js';
import { handlePaymentEvent } from '../projections/paymentsProjection.js';

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
    // Pega um payment de cada categoria para testar
    const samples = await Payment.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $group: { _id: '$billingType', paymentId: { $first: '$_id' } } },
      { $limit: 5 }
    ]);

    console.log('\n🧪 Amostra por billingType:', samples);

    for (const s of samples) {
      const paymentId = s.paymentId.toString();
      console.log(`\n→ Testando payment ${paymentId} (billingType=${s._id})`);

      const before = await PaymentsView.findOne({ paymentId }).lean();
      console.log(`  Antes: ${before ? 'existe' : 'não existe'}`);

      const result = await handlePaymentEvent({
        type: 'PAYMENT_UPDATED',
        payload: { paymentId },
        timestamp: new Date().toISOString()
      });

      console.log(`  Resultado:`, result);

      const after = await PaymentsView.findOne({ paymentId }).lean();
      if (after) {
        console.log(`  Depois: OK`, {
          category: after.category,
          status: after.status,
          method: after.method,
          patient: after.patient?.name,
          serviceType: after.serviceType,
          serviceLabel: after.serviceLabel
        });
      } else {
        console.log(`  Depois: ❌ ainda não existe`);
      }
    }

    console.log('\n✅ Teste concluído');
  } catch (error) {
    console.error('❌ Erro:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
  }
}

main();
