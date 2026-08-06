import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Doctor from '../models/Doctor.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const doctors = await Doctor.find({ fullName: /Alexandre Vieira/i }).lean();
  console.log(`Encontrados: ${doctors.length}`);
  for (const d of doctors) {
    console.log(JSON.stringify({
      _id: d._id,
      fullName: d.fullName,
      active: d.active,
      specialty: d.specialty,
      specialties: d.specialties,
      commissionRules: d.commissionRules,
      commissionRuleVersion: d.commissionRuleVersion
    }, null, 2));
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
