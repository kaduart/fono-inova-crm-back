// Scanner READ-ONLY para o bug legado: Session.sessionValue=0 em sessões de
// convênio completed, quando a guia tem sessionValue > 0 (valor nunca propagado
// na criação da Session). Não altera nada — só dimensiona o problema.
//
// Critérios (conforme decisão 2026-07-20):
//   Session.status = 'completed'
//   Session.insuranceGuide existe
//   Session.sessionValue = 0
//   InsuranceGuide.sessionValue > 0
//   InsuranceGuide.status != 'cancelled'
//
// Uso: node scripts/scan-legacy-insurance-session-values.mjs
import 'dotenv/config';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

const guides = await db.collection('insuranceguides')
  .find({ sessionValue: { $gt: 0 }, status: { $ne: 'cancelled' } })
  .project({ number: 1, sessionValue: 1, patientId: 1, status: 1 })
  .toArray();

const guideById = new Map(guides.map(g => [g._id.toString(), g]));
const guideIds = guides.map(g => g._id);
const guideIdsAsStrings = guideIds.map(id => id.toString());

const sessions = await db.collection('sessions')
  .find({
    status: 'completed',
    sessionValue: 0,
    insuranceGuide: { $in: [...guideIds, ...guideIdsAsStrings] }
  })
  .project({ _id: 1, insuranceGuide: 1, appointmentId: 1, date: 1, patient: 1 })
  .toArray();

console.log(`Sessions candidatas (status=completed, sessionValue=0, guia com sessionValue>0, guia não cancelada): ${sessions.length}`);

// Cruza com Payment via appointmentId -> Appointment.payment
const appointmentIds = sessions.map(s => s.appointmentId).filter(Boolean);
const appointments = await db.collection('appointments')
  .find({ _id: { $in: appointmentIds } })
  .project({ _id: 1, payment: 1 })
  .toArray();
const paymentIdByAppointment = new Map(appointments.map(a => [a._id.toString(), a.payment]));

const paymentIds = appointments.map(a => a.payment).filter(Boolean);
const payments = await db.collection('payments')
  .find({ _id: { $in: paymentIds } })
  .project({ _id: 1, amount: 1, 'insurance.grossAmount': 1 })
  .toArray();
const paymentById = new Map(payments.map(p => [p._id.toString(), p]));

let caseA = 0, caseB = 0, caseC = 0;
let recoverableValue = 0;
const byPatient = new Map(); // patientId -> { count, value, guides: Set }

for (const s of sessions) {
  const guide = guideById.get(String(s.insuranceGuide));
  if (!guide) continue;
  const guideValue = guide.sessionValue;
  recoverableValue += guideValue;

  const patientKey = String(s.patient || guide.patientId);
  if (!byPatient.has(patientKey)) byPatient.set(patientKey, { count: 0, value: 0, guides: new Set() });
  const bucket = byPatient.get(patientKey);
  bucket.count += 1;
  bucket.value += guideValue;
  bucket.guides.add(guide.number);

  const paymentId = s.appointmentId ? paymentIdByAppointment.get(String(s.appointmentId)) : null;
  const payment = paymentId ? paymentById.get(String(paymentId)) : null;

  if (!payment) {
    caseC += 1;
  } else {
    const payValue = payment.insurance?.grossAmount ?? payment.amount ?? 0;
    if (payValue === 0) caseA += 1;
    else caseB += 1;
  }
}

console.log('');
console.log(`Caso A (Session=0, Payment=0, corrige os dois): ${caseA}`);
console.log(`Caso B (Session=0, Payment já correto, corrige só Session): ${caseB}`);
console.log(`Caso C (Session=0, sem Payment associado, corrige só Session): ${caseC}`);
console.log('');
console.log(`Valor total recuperável (usando InsuranceGuide.sessionValue como referência): R$ ${recoverableValue.toLocaleString('pt-BR')}`);
console.log('');

const patientIds = [...byPatient.keys()].map(id => new mongoose.Types.ObjectId(id));
const patients = await db.collection('patients').find({ _id: { $in: patientIds } }).project({ fullName: 1 }).toArray();
const nameById = new Map(patients.map(p => [p._id.toString(), p.fullName]));

console.log(`Pacientes afetados: ${byPatient.size}`);
const sorted = [...byPatient.entries()].sort((a, b) => b[1].value - a[1].value);
for (const [pid, data] of sorted) {
  console.log(`  ${nameById.get(pid) || pid}: ${data.count} sessões, R$ ${data.value.toLocaleString('pt-BR')}, guias: ${[...data.guides].join(', ')}`);
}

process.exit(0);
