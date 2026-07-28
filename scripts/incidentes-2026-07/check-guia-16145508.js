import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function main() {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000 });
  const InsuranceGuide = mongoose.connection.collection('insuranceguides');
  const Doctor = mongoose.connection.collection('doctors');
  const Patient = mongoose.connection.collection('patients');

  const guide = await InsuranceGuide.findOne({ number: '16145508' });
  console.log('Guia 16145508:', guide ? JSON.stringify(guide, null, 2) : 'NÃO EXISTE no banco');

  const doctor = await Doctor.findOne({ _id: new mongoose.Types.ObjectId('68bedf1104ec4875aaea8188') });
  console.log('\nMédico da sessão das 18:20 (02/06):', doctor?.name, '| especialidade(s):', JSON.stringify(doctor?.specialty || doctor?.specialties));

  // Checar se há outro paciente da mesma família com guia 16145508 (irmão)
  const patient = await Patient.findOne({ _id: new mongoose.Types.ObjectId('69c16797c19d35b8454a354d') });
  console.log('\nPaciente:', patient?.fullName);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
