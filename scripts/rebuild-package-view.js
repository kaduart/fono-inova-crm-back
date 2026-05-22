import mongoose from 'mongoose';
import '../models/index.js';
import '../models/InsuranceGuide.js';
import { buildPackageView } from '../domains/billing/services/PackageProjectionService.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

const packageIds = [
  '6a01c30403cf8c44fece96b3', // Ercy
  '6a0f53eef932f0e78a883e25', // Manuela
  '6a0f7aa41b67c6b56fa3b75a', // Melissa
];

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  for (const id of packageIds) {
    try {
      console.log(`\nRebuilding PackagesView for package ${id}...`);
      const result = await buildPackageView(id, { correlationId: `manual_rebuild_${Date.now()}` });
      console.log('✅ Rebuilt:', JSON.stringify({
        packageId: result?.packageId || id,
        totalValue: result?.totalValue,
        totalPaid: result?.totalPaid,
        balance: result?.balance,
        financialStatus: result?.financialStatus,
      }, null, 2));
    } catch (err) {
      console.error(`❌ Failed to rebuild ${id}:`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main();
