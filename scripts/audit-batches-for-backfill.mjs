/**
 * Auditoria rápida: correlaciona payments billed sem insurance.billedAt
 * com InsuranceBatches para entender por que o backfill não encontrou batches.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI não definido');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('🚀 Conectado ao MongoDB\n');

  const billedWithoutBilledAt = await Payment.countDocuments({
    billingType: 'convenio',
    'insurance.status': 'billed',
    $or: [{ 'insurance.billedAt': { $exists: false } }, { 'insurance.billedAt': null }]
  });
  console.log(`Payments billed sem insurance.billedAt: ${billedWithoutBilledAt}`);

  const totalBatches = await InsuranceBatch.countDocuments();
  const faturamentoBatches = await InsuranceBatch.countDocuments({ type: 'faturamento' });
  const sentReceivedBatches = await InsuranceBatch.countDocuments({
    type: 'faturamento',
    status: { $in: ['sent', 'received'] }
  });

  console.log(`\nInsuranceBatch total: ${totalBatches}`);
  console.log(`InsuranceBatch tipo 'faturamento': ${faturamentoBatches}`);
  console.log(`InsuranceBatch 'faturamento' status sent/received: ${sentReceivedBatches}`);

  // Distribuição de status e types
  const statusTypes = await InsuranceBatch.aggregate([
    { $group: { _id: { type: '$type', status: '$status' }, count: { $sum: 1 } } }
  ]);
  console.log('\nDistribuição de batches por type/status:');
  for (const st of statusTypes) {
    console.log(`  type=${st._id.type || 'null'} status=${st._id.status || 'null'} -> ${st.count}`);
  }

  // Verifica se algum payment sem billedAt tem session em algum batch
  const payments = await Payment.find({
    billingType: 'convenio',
    'insurance.status': 'billed',
    $or: [{ 'insurance.billedAt': { $exists: false } }, { 'insurance.billedAt': null }]
  }).select('_id session').lean();

  const paymentIds = payments.map(p => p._id.toString());
  const sessionIds = payments.map(p => p.session?.toString()).filter(Boolean);

  console.log(`\nPayments sem billedAt: ${paymentIds.length}`);
  console.log(`SessionIds entre eles: ${sessionIds.length}`);

  const batchesWithSession = await InsuranceBatch.find({
    'sessions.session': { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) }
  }).select('_id type status sentDate createdAt sessions').lean();

  console.log(`Batches que contêm alguma session desses payments: ${batchesWithSession.length}`);

  for (const b of batchesWithSession.slice(0, 5)) {
    const relatedSessions = b.sessions.filter(s => sessionIds.includes(s.session?.toString()));
    console.log(`  Batch ${b._id} type=${b.type} status=${b.status} sentDate=${b.sentDate} createdAt=${b.createdAt} sessionsMatch=${relatedSessions.length}`);
  }

  const batchesWithPayment = await InsuranceBatch.find({
    'sessions.payment': { $in: paymentIds.map(id => new mongoose.Types.ObjectId(id)) }
  }).select('_id type status sentDate createdAt').lean();

  console.log(`\nBatches que contêm algum paymentId direto: ${batchesWithPayment.length}`);
  for (const b of batchesWithPayment.slice(0, 5)) {
    console.log(`  Batch ${b._id} type=${b.type} status=${b.status} sentDate=${b.sentDate} createdAt=${b.createdAt}`);
  }

  await mongoose.disconnect();
  console.log('\n🔌 Desconectado.');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
