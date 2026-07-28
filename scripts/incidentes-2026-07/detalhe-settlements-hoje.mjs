import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI não configurada'); process.exit(1); }

const TODAY = new Date('2026-07-27T00:00:00-03:00');
const TOMORROW = new Date('2026-07-28T00:00:00-03:00');

async function main() {
  await mongoose.connect(MONGO_URI);
  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;
  const Package = (await import('../models/Package.js')).default;

  // Analisar todos os monthly_settlements de hoje
  const settlements = await Payment.find({
    kind: 'monthly_settlement',
    status: { $in: ['paid', 'completed', 'confirmed'] },
    $or: [
      { paidAt: { $gte: TODAY, $lt: TOMORROW } },
      { financialDate: { $gte: TODAY, $lt: TOMORROW } },
      { createdAt: { $gte: TODAY, $lt: TOMORROW } }
    ]
  })
  .populate('patient', 'fullName')
  .populate('settledPaymentIds')
  .sort({ createdAt: -1 })
  .lean();

  console.log('══════════════════════════════════════════════════════════');
  console.log('  DETALHAMENTO DOS MONTHLY_SETTLEMENTS DE HOJE');
  console.log('══════════════════════════════════════════════════════════\n');

  for (const ms of settlements) {
    console.log(`\n👤 Paciente: ${ms.patient?.fullName || 'N/A'} | ID: ${ms.patient?._id?.toString()}`);
    console.log(`💰 Settlement ID: ${ms._id.toString()}`);
    console.log(`   Valor: R$ ${(ms.amount || 0).toFixed(2)} | Método: ${ms.paymentMethod} | Notas: ${ms.notes || '—'}`);
    console.log(`   paidAt: ${ms.paidAt ? new Date(ms.paidAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}`);
    console.log(`   settledPaymentIds: ${ms.settledPaymentIds?.length || 0} payment(s)`);
    
    let sumSettled = 0;
    for (const sp of (ms.settledPaymentIds || [])) {
      sumSettled += sp.amount || 0;
      const appt = sp.appointment ? await Appointment.findById(sp.appointment).lean() : null;
      console.log(`      → ${sp._id.toString()} | R$ ${(sp.amount || 0).toFixed(2)} | status ${sp.status} | ${appt?.date ? new Date(appt.date).toLocaleDateString('pt-BR') : '—'} ${appt?.time || ''} | ${appt?.specialty || ''}`);
    }
    console.log(`   Soma dos settledPaymentIds: R$ ${sumSettled.toFixed(2)}`);
    
    // Se pacote, mostrar detalhes
    if (ms.package) {
      const pkg = await Package.findById(ms.package).lean();
      console.log(`   Pacote: ${pkg?._id?.toString()} | ${pkg?.specialty} | total ${pkg?.totalValue} | pago ${pkg?.totalPaid} | balanço ${pkg?.balance}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
