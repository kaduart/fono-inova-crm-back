#!/usr/bin/env node
/**
 * verify-paymentsview-1x1.js
 *
 * Verifica 1:1 entre Payment e PaymentsView.
 */

import mongoose from 'mongoose';
import '../models/index.js';
import Payment from '../models/Payment.js';
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
    const totalPayments = await Payment.countDocuments({ isDeleted: { $ne: true } });
    const totalViews = await PaymentsView.countDocuments({ isDeleted: { $ne: true } });

    console.log(`\n📊 Payments: ${totalPayments}`);
    console.log(`📊 PaymentsView (isDeleted!=true): ${totalViews}`);
    console.log(`📊 Diferença: ${totalPayments - totalViews}`);

    // Views sem Payment correspondente (órfãos)
    const orphanViews = await PaymentsView.aggregate([
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
      { $count: 'orphanViews' }
    ]);
    console.log('\n📊 Views órfãs (sem Payment):', orphanViews[0]?.orphanViews || 0);

    // Payments sem View
    const paymentsWithoutView = await Payment.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      {
        $lookup: {
          from: 'payments_view',
          localField: '_id',
          foreignField: 'paymentId',
          as: 'view'
        }
      },
      { $match: { view: { $size: 0 } } },
      { $count: 'missingViews' }
    ]);
    console.log('📊 Payments sem View:', paymentsWithoutView[0]?.missingViews || 0);

    // Distribuição por categoria na view
    const categories = await PaymentsView.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    console.log('\n📈 Categorias na PaymentsView:', categories);

    if (totalPayments === totalViews && !orphanViews.length && !paymentsWithoutView.length) {
      console.log('\n✅ 1:1 confirmado entre Payment e PaymentsView');
    } else {
      console.log('\n⚠️  1:1 não está perfeito. Verifique os detalhes acima.');
    }
  } catch (error) {
    console.error('❌ Erro na verificação:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado');
  }
}

main();
