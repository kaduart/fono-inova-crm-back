import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

async function main() {
  await mongoose.connect(MONGO_URI);
  await import('../models/PatientsView.js');
  const Patient = (await import('../models/Patient.js')).default;
  const { listGuidesPendingBilling } = await import('../services/insuranceBatchGuideAdapter.js');

  const p = await Patient.findOne({ fullName: { $regex: 'Nicolas Lucca', $options: 'i' } }).lean();
  if (!p) { console.error('Paciente não encontrado'); await mongoose.disconnect(); return; }
  const patientId = p._id.toString();
  console.log('Paciente:', patientId, p.fullName);

  const result = await listGuidesPendingBilling({ patientId, includeOverdue: true });
  console.log('\nTotal guias:', result.guides.length);
  console.log('Total orphanSessions:', result.orphanSessions.length);
  console.log('Competence breakdown:', JSON.stringify(result.competenceBreakdown, null, 2));
  console.log('Overdue summary:', JSON.stringify(result.overdueSummary, null, 2));

  for (const g of result.guides) {
    console.log('\nGuia:', g.number, '| insurance:', g.insurance, '| specialty:', g.specialty, '| status:', g.guideStatus, '| billingMode:', g.billingMode);
    console.log('  pendingSessions:', g.pendingSessions, '| pendingValue:', g.pendingValue, '| sessions.length:', g.sessions?.length);
    console.log('  billingState:', JSON.stringify(g.billingState));
    for (const s of g.sessions || []) {
      console.log('  - Session', s.sessionId, s.date, s.time, s.specialty, s.doctorName, 'R$' + s.value);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
