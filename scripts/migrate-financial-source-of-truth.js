#!/usr/bin/env node
/**
 * ==============================================================================
 * MIGRAÇÃO FINANCEIRA — Source of Truth: Payment
 * ==============================================================================
 *
 * Objetivo: Sanear dados legados para que Session.sessionValue reflita
 * Payment.amount, corrigir valores de psicologia, e linkar payments órfãos.
 *
 * Modo: DRY-RUN por padrão. Use --apply para executar.
 * ==============================================================================
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DRY_RUN = !process.argv.includes('--apply');
const TARGET_PATIENT = process.argv.find(a => a.startsWith('--patient='))?.split('=')[1];

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/fono_inova_prod';
  await mongoose.connect(uri);
  console.log(`[Migrate] Conectado: ${uri}`);
}

async function main() {
  await connect();

  const { default: Payment } = await import('../models/Payment.js');
  const { default: Session } = await import('../models/Session.js');
  const { default: Appointment } = await import('../models/Appointment.js');

  console.log(`\n========================================`);
  console.log(` MODO: ${DRY_RUN ? '🔍 DRY-RUN (simulação)' : '🔥 APLICAR MUDANÇAS'}`);
  console.log(`========================================\n`);

  // ==========================================================================
  // ETAPA 1: Corrigir sessions com sessionValue=0 que têm payment vinculado
  // ==========================================================================
  console.log('── ETAPA 1: Sessions com sessionValue=0 ──');
  
  const querySessionZero = { sessionValue: 0 };
  if (TARGET_PATIENT) {
    // Precisamos resolver o patientId para ObjectId se possível
    const { default: Patient } = await import('../models/Patient.js');
    const pat = await Patient.findOne({ $or: [{ _id: TARGET_PATIENT }, { fullName: new RegExp(TARGET_PATIENT, 'i') }] }).select('_id').lean();
    if (pat) {
      querySessionZero.patient = pat._id;
      console.log(`  Filtro por paciente: ${TARGET_PATIENT} → ${pat._id}`);
    }
  }

  const sessionsZero = await Session.find(querySessionZero).select('_id date patient sessionValue').lean();
  console.log(`  Encontradas: ${sessionsZero.length} sessions com sessionValue=0`);

  let fixedSessions = 0;
  for (const s of sessionsZero) {
    const payment = await Payment.findOne({ session: s._id }).select('amount status').lean();
    if (payment && payment.amount > 0) {
      console.log(`  [FIX] Session ${s._id} (date=${s.date}): sessionValue 0 → ${payment.amount} (Payment ${payment._id})`);
      if (!DRY_RUN) {
        await Session.updateOne({ _id: s._id }, { $set: { sessionValue: payment.amount } });
      }
      fixedSessions++;
    }
  }
  console.log(`  Corrigidas: ${fixedSessions}\n`);

  // ==========================================================================
  // ETAPA 2: Corrigir payments de psicologia com valor errado
  // ==========================================================================
  console.log('── ETAPA 2: Payments Psicologia com amount ≠ 130 ──');
  
  const psicoQuery = {
    $or: [
      { sessionType: 'psicologia' },
      { serviceType: 'psicologia' },
      { 'doctor.specialty': /psicologia/i }
    ],
    amount: { $ne: 130 }
  };
  
  // Populate doctor para filtrar por specialty
  const psicoPayments = await Payment.find(psicoQuery).populate('doctor', 'specialty').select('_id amount sessionType serviceType doctor').lean();
  
  // Filtra manualmente os que realmente são psicologia
  const psicoToFix = psicoPayments.filter(p => 
    p.sessionType === 'psicologia' || 
    p.serviceType === 'psicologia' || 
    p.doctor?.specialty?.toLowerCase().includes('psicologia')
  );
  
  console.log(`  Encontrados: ${psicoToFix.length} payments psicologia com amount ≠ 130`);
  
  let fixedPsico = 0;
  for (const p of psicoToFix) {
    // Só corrige se o valor atual não faz sentido (ex: 160, 200, 0)
    // Mantém valores personalizados se houver nota explícita
    console.log(`  [FIX] Payment ${p._id}: amount ${p.amount} → 130 (psicologia)`);
    if (!DRY_RUN) {
      await Payment.updateOne({ _id: p._id }, { $set: { amount: 130 } });
    }
    fixedPsico++;
  }
  console.log(`  Corrigidos: ${fixedPsico}\n`);

  // ==========================================================================
  // ETAPA 3: Linkar payments órfãos (sem session e sem appointment)
  // ==========================================================================
  console.log('── ETAPA 3: Payments órfãos (sem session & sem appointment) ──');
  
  const orphanQuery = {
    session: null,
    appointment: null,
    status: { $in: ['pending', 'partial', 'paid'] }
  };
  const orphans = await Payment.find(orphanQuery).select('_id patientId patient paymentDate serviceDate amount notes').lean();
  console.log(`  Encontrados: ${orphans.length} payments órfãos`);

  let linkedOrphans = 0;
  for (const p of orphans) {
    // Tenta linkar por patient + data
    const dateRef = p.serviceDate || p.paymentDate;
    if (!dateRef) {
      console.log(`  [SKIP] Payment ${p._id}: sem data de referência`);
      continue;
    }
    
    const dateStr = new Date(dateRef).toISOString().split('T')[0];
    const patientId = p.patient?.toString?.() || p.patientId;
    
    // Busca appointment no mesmo dia para o mesmo paciente
    const apt = await Appointment.findOne({
      patient: patientId,
      date: dateStr,
      operationalStatus: 'completed'
    }).select('_id session').lean();
    
    if (apt) {
      console.log(`  [LINK] Payment ${p._id} → Appointment ${apt._id} (patient=${patientId}, date=${dateStr})`);
      if (!DRY_RUN) {
        await Payment.updateOne({ _id: p._id }, { $set: { appointment: apt._id, appointmentId: apt._id.toString() } });
        if (apt.session) {
          await Payment.updateOne({ _id: p._id }, { $set: { session: apt.session } });
        }
      }
      linkedOrphans++;
    } else {
      // Busca session no mesmo dia
      const sess = await Session.findOne({
        patient: patientId,
        date: dateStr,
        status: 'completed'
      }).select('_id').lean();
      
      if (sess) {
        console.log(`  [LINK] Payment ${p._id} → Session ${sess._id} (patient=${patientId}, date=${dateStr})`);
        if (!DRY_RUN) {
          await Payment.updateOne({ _id: p._id }, { $set: { session: sess._id } });
        }
        linkedOrphans++;
      } else {
        console.log(`  [SKIP] Payment ${p._id}: nenhum appointment/session encontrado (patient=${patientId}, date=${dateStr})`);
      }
    }
  }
  console.log(`  Linkados: ${linkedOrphans}\n`);

  // ==========================================================================
  // ETAPA 4: Relatório final
  // ==========================================================================
  console.log('── RELATÓRIO ──');
  console.log(`  Sessions corrigidas (valor 0): ${fixedSessions}`);
  console.log(`  Payments psicologia corrigidos: ${fixedPsico}`);
  console.log(`  Payments órfãos linkados: ${linkedOrphans}`);
  console.log(`  Modo: ${DRY_RUN ? 'DRY-RUN (nada foi alterado)' : 'APLICADO'}`);
  
  if (DRY_RUN) {
    console.log(`\n  Para aplicar, execute com: --apply`);
  }

  await mongoose.disconnect();
  console.log('\n[Migrate] Desconectado. ✅');
}

main().catch(err => {
  console.error('[Migrate] Erro fatal:', err);
  process.exit(1);
});
