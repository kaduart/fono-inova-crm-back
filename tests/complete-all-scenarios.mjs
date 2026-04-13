/**
 * 🧪 TESTE COMPLETO — completeSessionV2
 * Cobra todos os cenários críticos de produção
 */

import mongoose from 'mongoose';
import { completeSessionV2 } from '../services/completeSessionService.v2.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import FinancialLedger from '../models/FinancialLedger.js';

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/fono_inova_test';

const results = [];
function report(name, passed, detail = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  results.push({ name, passed, detail });
  console.log(`${status} | ${name} ${detail ? '| ' + detail : ''}`);
}

async function cleanup() {
  await Appointment.deleteMany({ correlationId: /^test_complete_/ });
  await Session.deleteMany({ correlationId: /^test_complete_/ });
  await Payment.deleteMany({ description: /^Teste complete/ });
  await FinancialLedger.collection.deleteMany({ correlationId: /^test_complete_/ });
  // Packages e Patients são reutilizados ou limpos no final
}

async function run() {
  console.log('\n🔌 Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado\n');

  await cleanup();

  // ===== SETUP BASE =====
  const doctor = await Doctor.create({
    fullName: 'Dr. Teste Complete',
    name: 'Dr. Teste Complete',
    email: `dr_complete_${Date.now()}@test.com`,
    specialty: 'fonoaudiologia',
    licenseNumber: `CRM-${Date.now()}`,
    phoneNumber: '61999999999'
  });
  const patient = await Patient.create({
    fullName: 'Paciente Teste Complete',
    name: 'Paciente Teste Complete',
    email: `pac_complete_${Date.now()}@test.com`,
    phone: '61999999999',
    dateOfBirth: new Date('2010-01-01')
  });

  // ============================================================
  // 1. SESSÃO AVULSA — particular pago no ato
  // ============================================================
  try { 
    const appt1 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      date: new Date(), startTime: '09:00',
      sessionValue: 200, billingType: 'particular', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_1_${Date.now()}`
    });
    const session1 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt1._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt1.correlationId });
    appt1.session = session1._id; await appt1.save();

    const result = await completeSessionV2(appt1._id.toString(), { correlationId: appt1.correlationId });
    const apptAfter = await Appointment.findById(appt1._id);
    const ledger = await FinancialLedger.findOne({ correlationId: appt1.correlationId, type: 'payment_received' });

    await new Promise(r => setTimeout(r, 200)); report('1. Sessão avulsa particular pago',
      result.success && apptAfter.operationalStatus === 'completed' && apptAfter.paymentStatus === 'paid' && ledger,
      `status=${apptAfter?.operationalStatus}, payment=${apptAfter?.paymentStatus}, ledger=${!!ledger}`
    );
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('1. Sessão avulsa particular pago', false, e.message);
  }

  // ============================================================
  // 2. SESSÃO AVULSA — particular fiado (addToBalance)
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const appt2 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      date: new Date(), startTime: '10:00',
      sessionValue: 250, billingType: 'particular', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_2_${Date.now()}`
    });
    const session2 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt2._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt2.correlationId });
    appt2.session = session2._id; await appt2.save();

    const result = await completeSessionV2(appt2._id.toString(), { addToBalance: true, correlationId: appt2.correlationId });
    const apptAfter = await Appointment.findById(appt2._id);
    const ledger = await FinancialLedger.findOne({ correlationId: appt2.correlationId, type: 'payment_pending' });

    await new Promise(r => setTimeout(r, 200)); report('2. Sessão avulsa particular fiado',
      result.success && apptAfter.paymentStatus === 'unpaid' && ledger?.amount === 250,
      `paymentStatus=${apptAfter?.paymentStatus}, ledgerAmount=${ledger?.amount}`
    );
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('2. Sessão avulsa particular fiado', false, e.message);
  }

  // ============================================================
  // 3. PACOTE THERAPY — completa normal
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const pkg3 = await Package.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      type: 'therapy', paymentType: 'per-session',
      totalSessions: 5, sessionValue: 180, totalValue: 900,
      durationMonths: 1, sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date()
    });
    const appt3 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', package: pkg3._id,
      date: new Date(), startTime: '11:00',
      sessionValue: 180, billingType: 'particular', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_3_${Date.now()}`
    });
    const session3 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt3._id, package: pkg3._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt3.correlationId });
    appt3.session = session3._id; await appt3.save();

    const result = await completeSessionV2(appt3._id.toString(), { correlationId: appt3.correlationId });
    const pkgAfter = await Package.findById(pkg3._id);
    await new Promise(r => setTimeout(r, 200)); report('3. Pacote therapy completa normal',
      result.success && pkgAfter.sessionsDone === 1,
      `sessionsDone=${pkgAfter?.sessionsDone}`
    );
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('3. Pacote therapy completa normal', false, e.message);
  }

  // ============================================================
  // 4. PACOTE THERAPY — addToBalance
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const pkg4 = await Package.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      type: 'therapy', paymentType: 'per-session',
      totalSessions: 5, sessionValue: 200, totalValue: 1000,
      durationMonths: 1, sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date()
    });
    const appt4 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', package: pkg4._id,
      date: new Date(), startTime: '12:00',
      sessionValue: 200, billingType: 'particular', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_4_${Date.now()}`
    });
    const session4 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt4._id, package: pkg4._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt4.correlationId });
    appt4.session = session4._id; await appt4.save();

    const result = await completeSessionV2(appt4._id.toString(), { addToBalance: true, correlationId: appt4.correlationId });
    const apptAfter = await Appointment.findById(appt4._id);
    const pkgAfter = await Package.findById(pkg4._id);
    await new Promise(r => setTimeout(r, 200)); report('4. Pacote therapy addToBalance',
      result.success && apptAfter.paymentStatus === 'unpaid' && pkgAfter.sessionsDone === 1,
      `paymentStatus=${apptAfter?.paymentStatus}, sessionsDone=${pkgAfter?.sessionsDone}`
    );
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('4. Pacote therapy addToBalance', false, e.message);
  }

  // ============================================================
  // 5. PACOTE PREPAID
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const pkg5 = await Package.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      model: 'prepaid', paymentType: 'full',
      totalSessions: 3, sessionValue: 300, totalValue: 900,
      durationMonths: 1, sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date()
    });
    const appt5 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', package: pkg5._id,
      date: new Date(), startTime: '13:00',
      sessionValue: 300, billingType: 'particular', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_5_${Date.now()}`
    });
    const session5 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt5._id, package: pkg5._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt5.correlationId });
    appt5.session = session5._id; await appt5.save();

    const result = await completeSessionV2(appt5._id.toString(), { correlationId: appt5.correlationId });
    const apptAfter = await Appointment.findById(appt5._id);
    const pkgAfter = await Package.findById(pkg5._id);
    await new Promise(r => setTimeout(r, 200)); report('5. Pacote prepaid (appointment billingType=particular prevalece)',
      result.success && pkgAfter.sessionsDone === 1 && result.billingType === 'particular',
      `billingType=${result?.billingType}, sessionsDone=${pkgAfter?.sessionsDone}`
    );
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('5. Pacote prepaid', false, e.message);
  }

  // ============================================================
  // 6. PACOTE CONVÊNIO
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const pkg6 = await Package.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      model: 'convenio', type: 'convenio',
      totalSessions: 4, sessionValue: 0, totalValue: 0,
      durationMonths: 1, sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date()
    });
    const appt6 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', package: pkg6._id,
      date: new Date(), startTime: '14:00',
      sessionValue: 0, billingType: 'convenio', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_6_${Date.now()}`
    });
    const session6 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt6._id, package: pkg6._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt6.correlationId });
    appt6.session = session6._id; await appt6.save();

    const result = await completeSessionV2(appt6._id.toString(), { correlationId: appt6.correlationId });
    const apptAfter = await Appointment.findById(appt6._id);
    const pkgAfter = await Package.findById(pkg6._id);
    await new Promise(r => setTimeout(r, 200)); report('6. Pacote convenio',
      result.success && apptAfter.paymentMethod === 'convenio' && pkgAfter.sessionsDone === 1,
      `paymentMethod=${apptAfter?.paymentMethod}, sessionsDone=${pkgAfter?.sessionsDone}`
    );
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('6. Pacote convenio', false, e.message);
  }

  // ============================================================
  // 7. PACOTE LIMINAR — com crédito suficiente
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const pkg7 = await Package.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      model: 'liminar', type: 'liminar',
      totalSessions: 2, sessionValue: 500, totalValue: 1000,
      liminarCreditBalance: 1000,
      durationMonths: 1, sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date()
    });
    const appt7 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', package: pkg7._id,
      date: new Date(), startTime: '15:00',
      sessionValue: 500, billingType: 'liminar', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_7_${Date.now()}`
    });
    const session7 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt7._id, package: pkg7._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt7.correlationId });
    appt7.session = session7._id; await appt7.save();

    const result = await completeSessionV2(appt7._id.toString(), { correlationId: appt7.correlationId });
    const pkgAfter = await Package.findById(pkg7._id);
    await new Promise(r => setTimeout(r, 200)); report('7. Pacote liminar com credito',
      result.success && pkgAfter.liminarCreditBalance === 500 && pkgAfter.sessionsDone === 1,
      `credit=${pkgAfter?.liminarCreditBalance}, sessionsDone=${pkgAfter?.sessionsDone}`
    );
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('7. Pacote liminar com credito', false, e.message);
  }

  // ============================================================
  // 8. PACOTE LIMINAR — sem crédito (deve falhar)
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const pkg8 = await Package.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      model: 'liminar', type: 'liminar',
      totalSessions: 2, sessionValue: 500, totalValue: 1000,
      liminarCreditBalance: 0,
      durationMonths: 1, sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date()
    });
    const appt8 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', package: pkg8._id,
      date: new Date(), startTime: '16:00',
      sessionValue: 500, billingType: 'liminar', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_8_${Date.now()}`
    });
    const session8 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt8._id, package: pkg8._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt8.correlationId });
    appt8.session = session8._id; await appt8.save();

    await completeSessionV2(appt8._id.toString(), { correlationId: appt8.correlationId });
    await new Promise(r => setTimeout(r, 200)); report('8. Pacote liminar sem credito', false, 'Deveria ter falhado');
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('8. Pacote liminar sem credito',
      e.message.includes('LIMINAR_NO_CREDIT'),
      e.message
    );
  }

  // ============================================================
  // 9. IDEMPOTÊNCIA — completar 2x
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const pkg9 = await Package.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      type: 'therapy', paymentType: 'per-session',
      totalSessions: 5, sessionValue: 150, totalValue: 750,
      durationMonths: 1, sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date()
    });
    const appt9 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', package: pkg9._id,
      date: new Date(), startTime: '17:00',
      sessionValue: 150, billingType: 'particular',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_9_${Date.now()}`
    });
    const session9 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt9._id, package: pkg9._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt9.correlationId });
    appt9.session = session9._id; await appt9.save();

    const r1 = await completeSessionV2(appt9._id.toString(), { correlationId: appt9.correlationId });
    const r2 = await completeSessionV2(appt9._id.toString(), { correlationId: appt9.correlationId });
    const pkgAfter = await Package.findById(pkg9._id);
    await new Promise(r => setTimeout(r, 200)); report('9. Idempotencia (2x complete)',
      r1.success && r2.idempotent && pkgAfter.sessionsDone === 1,
      `sessionsDone=${pkgAfter?.sessionsDone}, idempotent=${r2.idempotent}`
    );
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('9. Idempotencia (2x complete)', false, e.message);
  }

  // ============================================================
  // 10. SESSÃO CANCELADA — deve falhar
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const appt10 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      date: new Date(), startTime: '18:00',
      sessionValue: 100, billingType: 'particular',
      operationalStatus: 'canceled', clinicalStatus: 'canceled',
      correlationId: `test_complete_10_${Date.now()}`
    });
    await completeSessionV2(appt10._id.toString(), { correlationId: appt10.correlationId });
    await new Promise(r => setTimeout(r, 200)); report('10. Sessao cancelada', false, 'Deveria ter falhado');
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('10. Sessao cancelada',
      e.message.includes('SESSION_CANCELLED'),
      e.message
    );
  }

  // ============================================================
  // 11. PACOTE ESGOTADO — deve falhar (PACKAGE_LIMIT_REACHED)
  // ============================================================
  try { await new Promise(r => setTimeout(r, 300));
    const pkg11 = await Package.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia',
      type: 'therapy', paymentType: 'per-session',
      totalSessions: 1, sessionValue: 100, totalValue: 100,
      sessionsDone: 1,
      durationMonths: 1, sessionsPerWeek: 1,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date()
    });
    const appt11 = await Appointment.create({
      patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', package: pkg11._id,
      date: new Date(), startTime: '19:00',
      sessionValue: 100, billingType: 'particular', specialty: 'fonoaudiologia',
      operationalStatus: 'scheduled', clinicalStatus: 'scheduled',
      correlationId: `test_complete_11_${Date.now()}`
    });
    const session11 = await Session.create({ patient: patient._id, doctor: doctor._id,
      specialty: 'fonoaudiologia', appointment: appt11._id, package: pkg11._id, status: 'scheduled', sessionType: 'fonoaudiologia', correlationId: appt11.correlationId });
    appt11.session = session11._id; await appt11.save();

    await completeSessionV2(appt11._id.toString(), { correlationId: appt11.correlationId });
    await new Promise(r => setTimeout(r, 200)); report('11. Pacote esgotado', false, 'Deveria ter falhado');
  } catch (e) {
    await new Promise(r => setTimeout(r, 200)); report('11. Pacote esgotado',
      e.message.includes('PACKAGE_LIMIT_REACHED'),
      e.message
    );
  }

  // ===== RESUMO =====
  console.log('\n═══════════════════════════════════════════');
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`RESULTADO: ${passed}/${total} passaram`);
  if (passed === total) {
    console.log('🎉 TODOS OS CENÁRIOS OK');
  } else {
    console.log('⚠️  HÁ FALHAS — VERIFIQUE ACIMA');
    results.filter(r => !r.passed).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail}`));
  }
  console.log('═══════════════════════════════════════════\n');

  await cleanup();
  await Doctor.deleteOne({ _id: doctor._id });
  await Patient.deleteOne({ _id: patient._id });
  await mongoose.connection.close();
  process.exit(passed === total ? 0 : 1);
}

run().catch(err => {
  console.error('Erro fatal no teste:', err);
  process.exit(1);
});
