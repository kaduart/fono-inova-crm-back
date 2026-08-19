// WRITE (aguardando confirmação do usuário antes de rodar).
// Corrige insuranceProvider desatualizado ("unimed-goiania", convênio desativado
// em 2026-07-03) para o código correto/ativo ("unimed-anapolis") nos appointments
// da paciente Isabela Ferreira De Mendonca. Puramente de exibição — não afeta
// elegibilidade de faturamento (confirmado: convenioHandler.js não filtra por
// insuranceProvider, só por guia/patient/specialty/status). Delete after use.
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Appointment from './models/Appointment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const PATIENT_ID = '69d3f4b8a9bd5f4411488492';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const affected = await Appointment.find({
    patient: PATIENT_ID,
    insuranceProvider: 'unimed-goiania',
  }).select('_id date insuranceProvider').lean();

  console.log(`Encontrados ${affected.length} appointments com insuranceProvider="unimed-goiania"`);
  affected.forEach(a => console.log(` - ${a._id} (${new Date(a.date).toISOString().slice(0, 10)})`));

  if (affected.length === 0) {
    console.log('Nada para corrigir.');
    await mongoose.disconnect();
    return;
  }

  const result = await Appointment.updateMany(
    { patient: PATIENT_ID, insuranceProvider: 'unimed-goiania' },
    { $set: { insuranceProvider: 'unimed-anapolis' } }
  );

  console.log('Atualizados:', result.modifiedCount);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
