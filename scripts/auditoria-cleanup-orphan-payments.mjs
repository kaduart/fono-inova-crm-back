import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongoUri) {
  console.error('MONGODB_URI/MONGO_URI não encontrado');
  process.exit(1);
}

await mongoose.connect(mongoUri);

const Payment = mongoose.connection.db.collection('payments');
const Appointment = mongoose.connection.db.collection('appointments');
const Patient = mongoose.connection.db.collection('patients');

const start = new Date('2026-07-27T00:00:00Z');
const end = new Date('2026-07-29T00:00:00Z');

console.log('[Cleanup] Buscando payments órfãos de 27/07 e 28/07...');

const candidates = await Payment.find({
  createdAt: { $gte: start, $lte: end }
}).toArray();

console.log(`[Cleanup] Total de payments no período: ${candidates.length}`);

const orphanPayments = [];
for (const p of candidates) {
  let isOrphan = false;
  if (p.patient) {
    const patientExists = await Patient.findOne({ _id: p.patient }, { _id: 1 });
    if (!patientExists) isOrphan = true;
  }
  if (p.appointment) {
    const apptExists = await Appointment.findOne({ _id: p.appointment }, { _id: 1 });
    if (!apptExists) isOrphan = true;
  }
  if (isOrphan) {
    orphanPayments.push(p);
  }
}

console.log(`[Cleanup] Payments órfãos encontrados: ${orphanPayments.length}`);
if (orphanPayments.length === 0) {
  await mongoose.disconnect();
  process.exit(0);
}

for (const p of orphanPayments) {
  console.log(`  ${p._id.toString()} | R$ ${p.amount} | ${p.paymentMethod} | patient=${p.patient?.toString()} | appointment=${p.appointment?.toString()} | createdAt=${p.createdAt}`);
}

// Backup
const backupFile = join(__dirname, `../../backups-mongo/orphan-payments-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(dirname(backupFile), { recursive: true });
fs.writeFileSync(backupFile, JSON.stringify(orphanPayments, null, 2));
console.log(`\n[Cleanup] Backup salvo em: ${backupFile}`);

// Deletar
const idsToDelete = orphanPayments.map(p => p._id);
const result = await Payment.deleteMany({ _id: { $in: idsToDelete } });
console.log(`[Cleanup] Deletados: ${result.deletedCount} payments`);

await mongoose.disconnect();
console.log('[Cleanup] Done.');
