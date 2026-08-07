import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Payment from '../models/Payment.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import Package from '../models/Package.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patient = await Patient.findOne({ fullName: { $regex: 'Davi Felipe', $options: 'i' } }).select('_id fullName').lean();
  if (!patient) {
    console.log('Paciente não encontrado');
    await mongoose.disconnect();
    return;
  }

  const filterYear = 2026;
  const startDate = new Date(`${filterYear}-01-01T00:00:00-03:00`);
  const endDate = new Date(`${filterYear}-12-31T23:59:59-03:00`);

  const packages = await Package.find({ type: 'convenio', patient: patient._id })
    .populate('patient', 'fullName name phone')
    .lean();

  console.log(`Packages do Davi Felipe: ${packages.length}`);
  for (const pkg of packages) {
    console.log(`\nPackage ${pkg._id}`);
    console.log(`  specialty=${pkg.specialty}`);
    console.log(`  insuranceProvider=${pkg.insuranceProvider}`);
    console.log(`  insuranceBillingStatus=${pkg.insuranceBillingStatus}`);
    console.log(`  sessionValue=${pkg.sessionValue}`);
    console.log(`  appointments=${pkg.appointments?.length || 0}`);

    const apptIds = (pkg.appointments || []).filter(Boolean);
    if (apptIds.length === 0) continue;

    const appts = await Appointment.find({ _id: { $in: apptIds }, operationalStatus: 'completed', date: { $gte: startDate, $lte: endDate } })
      .select('_id date specialty operationalStatus session')
      .lean();

    console.log(`  Appointments completed no ano: ${appts.length}`);
    for (const a of appts) {
      const d = new Date(a.date);
      const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      console.log(`    ${a._id} ${mk} ${a.date} ${a.specialty} ${a.operationalStatus} session=${a.session}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
