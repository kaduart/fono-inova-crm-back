import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';

const MONGO_URI = 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

async function main() {
  await mongoose.connect(MONGO_URI);
  const patientId = '685b0cfaaec14c7163585b5b';
  const patientOid = new mongoose.Types.ObjectId(patientId);
  
  const start = new Date('2026-04-27T00:00:00-03:00');
  const end = new Date('2026-05-22T23:59:59-03:00');
  
  const appointments = await Appointment.find({
    patient: patientOid,
    date: { $gte: start, $lte: end },
    operationalStatus: 'completed'
  }).sort({ date: 1, time: 1 }).lean();
  
  let totalPendente = 0;
  let totalPago = 0;
  
  console.log('ATENDIMENTOS DE 27/04 A 22/05 — STATUS DE PAGAMENTO');
  console.log('');
  
  for (const appt of appointments) {
    const payments = await Payment.find({ appointment: appt._id }).lean();
    const d = new Date(appt.date).toLocaleDateString('pt-BR');
    const valor = appt.sessionValue || 0;
    
    // Determina status
    const hasPaid = payments.some(p => p.status === 'paid');
    const hasPending = payments.some(p => p.status === 'pending');
    let status = '—';
    if (hasPaid && !hasPending) {
      status = 'PAGO';
      totalPago += valor;
    } else if (hasPending) {
      status = 'PENDENTE';
      totalPendente += valor;
    }
    
    console.log(d + ' ' + appt.time + ' | ' + (appt.specialty || '—').padEnd(22) + ' | R$ ' + valor.toFixed(2).padStart(6) + ' | ' + status);
  }
  
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  RESUMO FINANCEIRO');
  console.log('══════════════════════════════════════════════════════════');
  console.log('   Total PAGO:     R$ ' + totalPago.toFixed(2));
  console.log('   Total PENDENTE: R$ ' + totalPendente.toFixed(2));
  console.log('   ──────────────────────────────────────────');
  console.log('   TOTAL:          R$ ' + (totalPago + totalPendente).toFixed(2));
  console.log('══════════════════════════════════════════════════════════');
  
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
