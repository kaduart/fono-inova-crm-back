import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function run() {
  await mongoose.connect(MONGO_URI);
  const { default: FinancialDailySnapshot } = await import('../models/FinancialDailySnapshot.js');
  const count = await FinancialDailySnapshot.countDocuments({ date: { $gte: '2026-06-01', $lte: '2026-06-13' } });
  console.log('Snapshots junho:', count);
  const sample = await FinancialDailySnapshot.findOne({ date: '2026-06-13' }).lean();
  console.log('Sample 13/06:', JSON.stringify(sample, null, 2));
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
