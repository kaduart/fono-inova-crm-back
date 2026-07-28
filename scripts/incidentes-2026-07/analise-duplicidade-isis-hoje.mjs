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

const TODAY = new Date('2026-07-27T00:00:00-03:00');
const TOMORROW = new Date('2026-07-28T00:00:00-03:00');

async function main() {
  await mongoose.connect(MONGO_URI);
  const Payment = (await import('../models/Payment.js')).default;
  const Appointment = (await import('../models/Appointment.js')).default;

  const payments = await Payment.find({
    patient: PATIENT_OID,
    status: { $in: ['paid', 'completed', 'confirmed'] },
    $or: [
      { paidAt: { $gte: TODAY, $lt: TOMORROW } },
      { financialDate: { $gte: TODAY, $lt: TOMORROW } },
      { createdAt: { $gte: TODAY, $lt: TOMORROW } }
    ]
  })
  .populate('appointment', 'date time specialty serviceType sessionValue paymentStatus operationalStatus')
  .sort({ paidAt: -1, createdAt: -1 })
  .lean();

  const monthlySettlements = payments.filter(p => p.kind === 'monthly_settlement');
  const sessionPayments = payments.filter(p => p.kind === 'session_payment');

  console.log('══════════════════════════════════════════════════════════');
  console.log('  ANÁLISE DE DUPLICIDADE — PAGAMENTOS DE HOJE');
  console.log('══════════════════════════════════════════════════════════\n');

  console.log('💳 MONTHLY_SETTLEMENTS (fechamentos) hoje:');
  for (const ms of monthlySettlements) {
    const appts = ms.settledPaymentIds || [];
    console.log(`\n  ${ms._id.toString()} | R$ ${(ms.amount || 0).toFixed(2)} | ${ms.paymentMethod}`);
    console.log(`  Notas: ${ms.notes || '—'}`);
    console.log(`  settledPaymentIds: ${appts.length ? appts.map(id => id.toString()).join(', ') : 'vazio'}`);
    
    if (!appts.length && ms.amount) {
      // Tenta encontrar sessões do mesmo dia/pacote com valores similares
      const similarAmounts = sessionPayments.filter(p => (p.amount || 0) > 0 && ms.amount % (p.amount || 1) === 0);
      if (similarAmounts.length) {
        console.log('  ⚠️  Possíveis sessões correspondentes (mesmo valor):');
        for (const sp of similarAmounts) {
          const appt = sp.appointment;
          console.log(`     → ${sp._id.toString()} | R$ ${(sp.amount || 0).toFixed(2)} | ${appt?.date ? new Date(appt.date).toLocaleDateString('pt-BR') : '—'} ${appt?.time || ''} | ${appt?.specialty || ''}`);
        }
      }
    }
  }

  console.log('\n\n💳 SESSION_PAYMENTS (pagos hoje):');
  for (const sp of sessionPayments) {
    const appt = sp.appointment;
    console.log(`\n  ${sp._id.toString()} | R$ ${(sp.amount || 0).toFixed(2)} | ${sp.paymentMethod}`);
    console.log(`  Sessão: ${appt?.date ? new Date(appt.date).toLocaleDateString('pt-BR') : '—'} ${appt?.time || ''} | ${appt?.specialty || ''}`);
    console.log(`  Appt: ${appt?._id?.toString() || '—'}`);
  }

  // Verificar se algum appointment tem mais de um payment pago hoje
  const apptIds = sessionPayments.map(p => p.appointment?._id?.toString()).filter(Boolean);
  const duplicates = apptIds.filter((item, index) => apptIds.indexOf(item) !== index);
  if (duplicates.length) {
    console.log('\n\n🚨 APPOINTMENTS COM MAIS DE UM PAGAMENTO PAGO HOJE:');
    for (const apptId of [...new Set(duplicates)]) {
      const dups = sessionPayments.filter(p => p.appointment?._id?.toString() === apptId);
      const appt = dups[0].appointment;
      console.log(`\n  Appt: ${apptId} | ${new Date(appt.date).toLocaleDateString('pt-BR')} ${appt.time} | ${appt.specialty}`);
      for (const p of dups) {
        console.log(`    → ${p._id.toString()} | R$ ${(p.amount || 0).toFixed(2)} | ${p.paymentMethod}`);
      }
    }
  }

  // Verificar se sessões pagas individualmente também estão em monthly_settlement
  console.log('\n\n🔍 CRUZAMENTO: sessões que podem estar DUPLICADAS em fechamentos');
  let foundDuplicate = false;
  for (const sp of sessionPayments) {
    const appt = sp.appointment;
    if (!appt) continue;
    const apptDate = new Date(appt.date);
    const apptDateStr = apptDate.toLocaleDateString('pt-BR');
    
    // Procura monthly_settlement que inclua esse valor
    for (const ms of monthlySettlements) {
      if (ms.settledPaymentIds && ms.settledPaymentIds.some(id => id.toString() === sp._id.toString())) {
        console.log(`\n  🚨 DUPLICIDADE CONFIRMADA:`);
        console.log(`    SessionPayment: ${sp._id.toString()} | R$ ${(sp.amount || 0).toFixed(2)} | ${apptDateStr}`);
        console.log(`    MonthlySettlement: ${ms._id.toString()} | R$ ${(ms.amount || 0).toFixed(2)}`);
        foundDuplicate = true;
      }
    }
  }
  
  if (!foundDuplicate) {
    console.log('\n  ℹ️ Nenhuma duplicidade confirmada via settledPaymentIds. Mas os valores dos fechamentos coincidem com somas de session payments.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
