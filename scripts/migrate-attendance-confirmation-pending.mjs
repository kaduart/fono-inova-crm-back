/**
 * Backfill idempotente da confirmação de presença.
 *
 * Dry-run (padrão): node scripts/migrate-attendance-confirmation-pending.mjs
 * Aplicar:           node scripts/migrate-attendance-confirmation-pending.mjs --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
const shouldApply = process.argv.includes('--apply');

// Início de 20/10/2026 em America/Sao_Paulo (UTC-3). A data é explícita para
// tornar esta migração auditável e reproduzível, sem depender do fuso do servidor.
const fromDate = new Date('2026-10-20T00:00:00-03:00');

if (!mongoUri) {
  console.error('MONGODB_URI/MONGO_URI não encontrado no ambiente.');
  process.exit(1);
}

const filter = {
  date: { $gte: fromDate },
  $or: [
    { attendanceConfirmation: { $exists: false } },
    { attendanceConfirmation: null },
    { 'attendanceConfirmation.status': { $exists: false } },
  ],
};

try {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 30000 });
  const appointments = mongoose.connection.db.collection('appointments');

  const [total, byStatus] = await Promise.all([
    appointments.countDocuments(filter),
    appointments.aggregate([
      { $match: filter },
      { $group: { _id: '$operationalStatus', total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
  ]);

  console.log(JSON.stringify({ mode: shouldApply ? 'apply' : 'dry-run', fromDate, total, byStatus }, null, 2));

  if (shouldApply && total > 0) {
    const result = await appointments.updateMany(filter, {
      $set: {
        attendanceConfirmation: {
          status: 'pending',
          channel: 'whatsapp',
        },
      },
    });
    console.log(JSON.stringify({ matched: result.matchedCount, modified: result.modifiedCount }, null, 2));
  }
} finally {
  await mongoose.disconnect();
}
