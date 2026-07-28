import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000 });
  const Session = mongoose.connection.collection('sessions');
  const Payment = mongoose.connection.collection('payments');

  const guideId = new mongoose.Types.ObjectId('69c2eb9f5c4ad17fefccc5b8'); // 15924845

  // Reproduz a query de buildBatchFromGuides (não olha Payment, só Session)
  const eligibleForBatch = await Session.find({
    status: 'completed',
    insuranceGuide: guideId,
    $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }]
  }).toArray();
  console.log(`buildBatchFromGuides incluiria ${eligibleForBatch.length} sessões:`, eligibleForBatch.map(s => s._id.toString()));

  // Reproduz a exclusão via findAlreadyHandledSessionIds (só olha billed/received/partial)
  const sessionIds = eligibleForBatch.map(s => s._id);
  const handled = await Payment.find({
    session: { $in: sessionIds },
    $or: [
      { 'insurance.status': { $in: ['billed', 'received', 'partial'] } },
      { status: { $in: ['billed', 'received', 'partial'] } }
    ]
  }).toArray();
  const handledIds = new Set(handled.map(p => p.session?.toString()));
  console.log('Sessões consideradas "já tratadas" (billed/received/partial) pela listagem:', [...handledIds]);
  console.log('Sessão fantasma (6a0c540580cc438aa0b67d3c) seria excluída da listagem?', handledIds.has('6a0c540580cc438aa0b67d3c'));

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
