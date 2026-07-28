import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

const TODAY = new Date('2026-07-27T00:00:00-03:00');
const TOMORROW = new Date('2026-07-28T00:00:00-03:00');

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

  const backupPath = path.resolve(__dirname, `../../auditoria-output/backup-settlements-removidos-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, JSON.stringify(settlements, null, 2));
  console.log(`💾 Backup salvo: ${backupPath}`);
  console.log(`   ${settlements.length} monthly_settlement(s) serão removidos.`);

  const ids = settlements.map(s => s._id);
  const result = await Payment.deleteMany({ _id: { $in: ids } });
  console.log(`✅ Removidos: ${result.deletedCount} documento(s)`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
