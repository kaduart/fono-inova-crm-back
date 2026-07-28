import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000 });
  const InsuranceCommunication = mongoose.connection.collection('insurancecommunications');
  const guideId = new mongoose.Types.ObjectId('69c2eb9f5c4ad17fefccc5b8');

  const comm = await InsuranceCommunication.findOne({ guideId, purpose: 'billing', status: 'sent' }, { sort: { updatedAt: -1 } });
  console.log('Comunicação de faturamento (NF) encontrada:', comm ? JSON.stringify({ invoiceNumber: comm.invoiceNumber, invoiceDate: comm.invoiceDate, status: comm.status }, null, 2) : 'NENHUMA — invoiceNumber ficaria null');

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
