import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

const PATIENT_ID = '685b0cfaaec14c7163585b5b';
const PATIENT_OID = new mongoose.Types.ObjectId(PATIENT_ID);

async function main() {
  await mongoose.connect(MONGO_URI);
  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Package = (await import('../models/Package.js')).default;

  console.log('══════════════════════════════════════════════════════════');
  console.log('  PACOTES DA ISIS CALDAS REBELATTO');
  console.log('══════════════════════════════════════════════════════════\n');

  const packages = await Package.find({ patient: PATIENT_OID }).lean();
  for (const pkg of packages) {
    console.log(`\n📦 Pacote ID: ${pkg._id.toString()}`);
    console.log(`   Especialidade: ${pkg.specialty || pkg.sessionType}`);
    console.log(`   Modelo: ${pkg.model || '—'}`);
    console.log(`   Status: ${pkg.status}`);
    console.log(`   Valor total: R$ ${(pkg.totalValue || 0).toFixed(2)}`);
    console.log(`   Total pago: R$ ${(pkg.totalPaid || 0).toFixed(2)}`);
    console.log(`   Balance: R$ ${(pkg.balance || 0).toFixed(2)}`);
    console.log(`   Sessões feitas: ${pkg.sessionsDone || 0} / ${pkg.totalSessions || 0}`);
    console.log(`   Sessões pagas: ${pkg.sessionsPaid || 0}`);
    console.log(`   Valor por sessão: R$ ${(pkg.sessionValue || 0).toFixed(2)}`);

    // Buscar appointments deste pacote
    const appts = await Appointment.find({ package: pkg._id }).sort({ date: 1 }).lean();
    console.log(`\n   Sessões agendadas (${appts.length}):`);
    for (const a of appts) {
      const payments = await Payment.find({ appointment: a._id }).lean();
      const payInfo = payments.map(p => `${p.status}=R$${(p.amount||0).toFixed(2)}`).join(' | ') || 'nenhum';
      console.log(`      ${new Date(a.date).toLocaleDateString('pt-BR')} ${a.time} | ${a.operationalStatus} / ${a.paymentStatus} | ${payInfo}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
