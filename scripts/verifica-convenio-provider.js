import 'dotenv/config';
import mongoose from 'mongoose';
import '../models/index.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import Payment from '../models/Payment.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGODB_URI nao configurado'); process.exit(1); }

async function main() {
  await mongoose.connect(MONGO_URI);
  const batchCount = await InsuranceBatch.countDocuments({ insuranceProvider: { $in: ['convenio', 'Convênio', 'Convenio'] } });
  const newAnapolis = await InsuranceBatch.countDocuments({ insuranceProvider: 'unimed-anapolis' });
  const newCampinas = await InsuranceBatch.countDocuments({ insuranceProvider: 'unimed-campinas' });
  const paymentCount = await Payment.countDocuments({ billingType: 'convenio', package: null, 'insurance.provider': { $in: ['convenio', 'Convênio', 'Convenio'] } });
  console.log({ batchProviderConvenio: batchCount, unimedAnapolisBatches: newAnapolis, unimedCampinasBatches: newCampinas, paymentProviderConvenio: paymentCount });
  await mongoose.disconnect();
}
main().catch(err => { console.error(err); process.exit(1); });
