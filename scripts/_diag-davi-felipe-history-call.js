import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Patient from '../models/Patient.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patient = await Patient.findOne({ fullName: { $regex: 'Davi Felipe', $options: 'i' } }).select('_id fullName').lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    await mongoose.disconnect();
    return;
  }

  const { getInsuranceHistory } = await import('../controllers/insuranceV2Controller.js');

  const req = { query: { year: '2026' } };
  const res = {
    status: () => res,
    json: (body) => { res._body = body; return res; }
  };

  await getInsuranceHistory(req, res);
  const history = res._body;

  const junho = history.data.find(m => m.monthKey === '2026-06');
  console.log('Junho 2026:', JSON.stringify(junho, null, 2));

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
