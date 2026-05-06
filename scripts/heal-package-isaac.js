/**
 * 🔧 HEAL PACKAGE — Paciente Isaac (6917116c5d4d8bdb65edd506)
 * 
 * Uso:
 *   export MONGO_URI="mongodb+srv://kaduart:SENHA@cluster0.g2c3sdk.mongodb.net/fono_inova_prod"
 *   cd /home/user/projetos/crm/back && node ../../scripts/heal-package-isaac.js --execute
 * 
 * Modo dry-run por padrão. Use --execute para salvar.
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
const EXECUTE = process.argv.includes('--execute');
const PATIENT_ID = '6917116c5d4d8bdb65edd506';
const PACKAGE_ID = '69d8f71f7bd82bc9e85e1388'; // pacote ativo do Isaac

if (!MONGO_URI) {
  console.error('❌ Defina MONGO_URI');
  console.error('   export MONGO_URI="mongodb+srv://..."');
  process.exit(1);
}

async function run() {
  console.log(EXECUTE ? '🔴 MODO EXECUÇÃO' : '🟡 DRY-RUN (só exibe, não salva)');
  console.log('   Adicione --execute para aplicar correções\n');

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const Patient = db.collection('patients');
  const Package = db.collection('packages');
  const Session = db.collection('sessions');
  const Appointment = db.collection('appointments');
  const Payment = db.collection('payments');

  const pid = new mongoose.Types.ObjectId(PATIENT_ID);
  const pkgId = new mongoose.Types.ObjectId(PACKAGE_ID);

  // ─── 1. ANÁLISE DO PACOTE ATUAL ───
  console.log('══════════════════════════════════════════');
  console.log('  PACOTE ATUAL (antes da correção)');
  console.log('══════════════════════════════════════════');
  const pkg = await Package.findOne({ _id: pkgId });
  if (!pkg) {
    console.error('❌ Package não encontrado:', PACKAGE_ID);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('Package ID:', pkg._id.toString());
  console.log('Status:', pkg.status);
  console.log('Total Sessions (campo):', pkg.totalSessions);
  console.log('Sessions Done (campo):', pkg.sessionsDone);
  console.log('Sessions Canceled (campo):', pkg.sessionsCanceled);
  console.log('Total Paid (campo):', pkg.totalPaid);
  console.log('Balance (campo):', pkg.balance);
  console.log('Session Value (campo):', pkg.sessionValue);
  console.log('Array sessions length:', pkg.sessions?.length || 0);
  console.log('Array appointments length:', pkg.appointments?.length || 0);

  // ─── 2. FONTE DE VERDADE: SESSIONS ───
  console.log('\n══════════════════════════════════════════');
  console.log('  FONTE DE VERDADE: Sessions (V2)');
  console.log('══════════════════════════════════════════');
  const sessions = await Session.find({ package: pkgId }).sort({ date: 1 }).toArray();
  console.log('Total sessions encontradas:', sessions.length);
  
  const completed = sessions.filter(s => s.status === 'completed');
  const canceled  = sessions.filter(s => s.status === 'canceled' || s.status === 'cancelled');
  const active    = sessions.filter(s => ['scheduled','pending','unpaid','pre_agendado'].includes(s.status));
  
  sessions.forEach((s, i) => {
    console.log(`  ${i+1}. [${s.status}] ${s.date} | isPaid:${s.isPaid} | sessionId:${s._id}`);
  });

  // ─── 3. FONTE DE VERDADE: APPOINTMENTS ───
  console.log('\n══════════════════════════════════════════');
  console.log('  FONTE DE VERDADE: Appointments');
  console.log('══════════════════════════════════════════');
  const appointments = await Appointment.find({ package: pkgId }).sort({ date: 1 }).toArray();
  console.log('Total appointments encontrados:', appointments.length);
  appointments.forEach((a, i) => {
    console.log(`  ${i+1}. [${a.status}] ${a.date} ${a.time} | appointmentId:${a._id}`);
  });

  // ─── 4. FONTE DE VERDADE: PAYMENTS ───
  console.log('\n══════════════════════════════════════════');
  console.log('  FONTE DE VERDADE: Payments');
  console.log('══════════════════════════════════════════');
  const payments = await Payment.find({ package: pkgId, status: { $in: ['paid','completed'] } }).toArray();
  const totalPaidReal = payments.reduce((sum, p) => sum + (p.value || p.amount || 0), 0);
  console.log('Total payments encontrados:', payments.length);
  console.log('Soma real dos pagamentos:', totalPaidReal);
  payments.forEach((p, i) => {
    console.log(`  ${i+1}. R$${p.value || p.amount || 0} | status:${p.status} | paymentId:${p._id}`);
  });

  // ─── 5. VERIFICAR PAYMENTS ÓRFÃOS ───
  console.log('\n══════════════════════════════════════════');
  console.log('  PAYMENTS ÓRFÃOS (appointment deletado)');
  console.log('══════════════════════════════════════════');
  const existingAppointmentIds = appointments.map(a => a._id.toString());
  const orphanPayments = await Payment.find({
    package: pkgId,
    appointment: { $exists: true, $ne: null },
    $expr: { $eq: [{ $type: '$appointment' }, 'objectId'] }
  }).toArray();
  
  const realOrphans = orphanPayments.filter(p => !existingAppointmentIds.includes(p.appointment?.toString?.()));
  console.log('Payments com appointment que não existe mais:', realOrphans.length);
  realOrphans.forEach((p, i) => {
    console.log(`  ${i+1}. R$${p.value || p.amount || 0} | orphan paymentId:${p._id} | appointmentRef:${p.appointment}`);
  });

  // ─── 6. CÁLCULO DO ESTADO CORRETO ───
  console.log('\n══════════════════════════════════════════');
  console.log('  RECONSTRUÇÃO DO ESTADO');
  console.log('══════════════════════════════════════════');
  
  const sessionValue = sessions[0]?.sessionValue || sessions[0]?.value || pkg.sessionValue || 160;
  const totalSessions = sessions.length;
  const sessionsDone = completed.length;
  const sessionsCanceled = canceled.length;
  const sessionsUsed = sessionsDone;
  const sessionsRemaining = Math.max(0, totalSessions - sessionsDone - sessionsCanceled);
  
  const consumedValue = sessionsDone * sessionValue;
  const balance = Math.max(0, totalPaidReal - consumedValue);
  
  let status = 'active';
  if (sessionsDone + sessionsCanceled >= totalSessions && active.length === 0) {
    status = 'finished';
  } else if (sessions.length === 0) {
    status = 'pending';
  }
  
  let financialStatus = 'unpaid';
  if (totalPaidReal >= totalSessions * sessionValue && sessionValue > 0) {
    financialStatus = 'paid';
  } else if (totalPaidReal > 0) {
    financialStatus = 'partially_paid';
  }

  console.log('Session Value usado:', sessionValue);
  console.log('totalSessions:', totalSessions, `(era: ${pkg.totalSessions})`);
  console.log('sessionsDone:', sessionsDone, `(era: ${pkg.sessionsDone})`);
  console.log('sessionsCanceled:', sessionsCanceled, `(era: ${pkg.sessionsCanceled || 0})`);
  console.log('sessionsRemaining:', sessionsRemaining, `(era: ${pkg.sessionsRemaining || 0})`);
  console.log('totalPaid:', totalPaidReal, `(era: ${pkg.totalPaid})`);
  console.log('balance:', balance, `(era: ${pkg.balance || 0})`);
  console.log('status:', status, `(era: ${pkg.status})`);
  console.log('financialStatus:', financialStatus, `(era: ${pkg.financialStatus || 'n/a'})`);

  // ─── 7. APLICAR CORREÇÃO ───
  if (EXECUTE) {
    console.log('\n🔴 APLICANDO CORREÇÃO...');
    
    await Package.updateOne(
      { _id: pkgId },
      {
        $set: {
          sessions: sessions.map(s => s._id),
          appointments: appointments.map(a => a._id),
          totalSessions,
          sessionsDone,
          sessionsCanceled,
          sessionsUsed,
          sessionsRemaining,
          totalPaid: totalPaidReal,
          balance,
          status,
          financialStatus,
          sessionValue,
          updatedAt: new Date()
        },
        $unset: { remainingSessions: '' }
      }
    );
    
    // Cancelar payments órfãos
    if (realOrphans.length > 0) {
      const orphanIds = realOrphans.map(p => p._id);
      await Payment.updateMany(
        { _id: { $in: orphanIds } },
        { $set: { status: 'canceled', updatedAt: new Date(), notes: 'Cancelado automaticamente: appointment vinculado foi removido' } }
      );
      console.log(`   ${orphanIds.length} payment(s) órfão(s) marcado(s) como canceled`);
    }
    
    console.log('✅ Correção aplicada com sucesso!');
  } else {
    console.log('\n🟡 DRY-RUN — nada foi salvo.');
    console.log('   Para aplicar, rode com: --execute');
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
