#!/usr/bin/env node
// scripts/audit-financial-integrity.js
/**
 * Auditoria de Integridade Financeira
 * 
 * Detecta inconsistências silenciosas no sistema financeiro:
 * - Sessões completed sem pagamento
 * - Pacotes inconsistentes
 * - Payments duplicados
 * - Guias estouradas
 * - Sessions consumed com status errado
 */

import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

const issues = [];

function addIssue(severity, category, description, data) {
  issues.push({
    severity,  // CRITICAL, HIGH, MEDIUM, LOW
    category,
    description,
    data,
    timestamp: new Date().toISOString()
  });
}

async function auditSessionsWithoutPayment() {
  console.log('🔍 Auditando: Sessions completed sem payment...');
  
  // Particular/Per-session sem payment
  const sessions = await Session.find({
    status: 'completed',
    isPaid: true,
    paymentStatus: 'paid',
    package: null,
    $or: [
      { paymentId: null },
      { paymentId: { $exists: false } }
    ]
  }).limit(1000);
  
  for (const session of sessions) {
    // Verifica se tem payment no banco
    const payment = await Payment.findOne({
      $or: [
        { session: session._id },
        { appointmentId: session.appointmentId }
      ],
      status: 'paid'
    });
    
    if (!payment) {
      addIssue(
        'CRITICAL',
        'MISSING_PAYMENT',
        `Sessão ${session._id} completada/paga sem registro de payment`,
        {
          sessionId: session._id,
          appointmentId: session.appointmentId,
          sessionValue: session.sessionValue,
          paidAt: session.paidAt
        }
      );
    }
  }
  
  console.log(`   ${sessions.length} sessões verificadas`);
}

async function auditPackageInconsistencies() {
  console.log('🔍 Auditando: Inconsistências de pacotes...');
  
  const packages = await Package.find({});
  
  for (const pkg of packages) {
    // Conta sessões completadas deste pacote
    const completedSessions = await Session.countDocuments({
      package: pkg._id,
      status: 'completed'
    });
    
    // Verifica se sessionsDone bate com realidade
    if (pkg.sessionsDone !== completedSessions) {
      addIssue(
        'HIGH',
        'PACKAGE_INCONSISTENT',
        `Pacote ${pkg._id} com contador inconsistente`,
        {
          packageId: pkg._id,
          sessionsDoneDeclared: pkg.sessionsDone,
          sessionsDoneReal: completedSessions,
          totalSessions: pkg.totalSessions
        }
      );
    }
    
    // Verifica se não estourou
    if (pkg.sessionsDone > pkg.totalSessions) {
      addIssue(
        'CRITICAL',
        'PACKAGE_EXHAUSTED_OVERFLOW',
        `Pacote ${pkg._id} consumiu mais sessões do que tem!`,
        {
          packageId: pkg._id,
          sessionsDone: pkg.sessionsDone,
          totalSessions: pkg.totalSessions,
          overflow: pkg.sessionsDone - pkg.totalSessions
        }
      );
    }
    
    // Verifica paidSessions vs totalPaid (per-session)
    if (pkg.paymentType === 'per-session' && pkg.paidSessions > 0) {
      const expectedPaid = pkg.paidSessions * pkg.sessionValue;
      if (Math.abs(pkg.totalPaid - expectedPaid) > 0.01) {
        addIssue(
          'HIGH',
          'PACKAGE_PAYMENT_MISMATCH',
          `Pacote per-session com valor pago inconsistente`,
          {
            packageId: pkg._id,
            paidSessions: pkg.paidSessions,
            sessionValue: pkg.sessionValue,
            expectedPaid,
            totalPaid: pkg.totalPaid
          }
        );
      }
    }
  }
  
  console.log(`   ${packages.length} pacotes verificados`);
}

async function auditDuplicatePayments() {
  console.log('🔍 Auditando: Payments duplicados...');
  
  // Agrupa payments por appointment + valor + status
  const duplicates = await Payment.aggregate([
    {
      $match: {
        status: { $in: ['paid', 'pending'] }
      }
    },
    {
      $group: {
        _id: {
          appointment: '$appointmentId',
          value: '$value',
          status: '$status'
        },
        count: { $sum: 1 },
        paymentIds: { $push: '$_id' }
      }
    },
    {
      $match: {
        count: { $gt: 1 }
      }
    }
  ]);
  
  for (const dup of duplicates) {
    addIssue(
      'CRITICAL',
      'DUPLICATE_PAYMENT',
      `Payments duplicados detectados`,
      {
        appointmentId: dup._id.appointment,
        value: dup._id.value,
        status: dup._id.status,
        count: dup.count,
        paymentIds: dup.paymentIds
      }
    );
  }
  
  console.log(`   ${duplicates.length} duplicatas encontradas`);
}

async function auditInsuranceGuides() {
  console.log('🔍 Auditando: Guias de convênio estouradas...');
  
  const guides = await InsuranceGuide.find({
    status: { $ne: 'canceled' }
  });
  
  for (const guide of guides) {
    if (guide.usedSessions > guide.totalSessions) {
      addIssue(
        'CRITICAL',
        'GUIDE_EXHAUSTED',
        `Guia ${guide._id} estourada`,
        {
          guideId: guide._id,
          guideNumber: guide.number,
          usedSessions: guide.usedSessions,
          totalSessions: guide.totalSessions,
          overflow: guide.usedSessions - guide.totalSessions
        }
      );
    }
  }
  
  console.log(`   ${guides.length} guias verificadas`);
}

async function auditSessionConsumedFlag() {
  console.log('🔍 Auditando: Flags sessionConsumed inconsistentes...');
  
  // Sessions com sessionConsumed=true mas status != completed
  const wrongConsumed = await Session.find({
    sessionConsumed: true,
    status: { $ne: 'completed' }
  });
  
  for (const session of wrongConsumed) {
    addIssue(
      'MEDIUM',
      'SESSION_CONSUMED_FLAG',
      `Sessão marcada como consumida mas status é ${session.status}`,
      {
        sessionId: session._id,
        status: session.status,
        sessionConsumed: session.sessionConsumed,
        package: session.package
      }
    );
  }
  
  // Sessions completed com package mas sessionConsumed=false
  const notConsumed = await Session.find({
    status: 'completed',
    package: { $ne: null },
    $or: [
      { sessionConsumed: false },
      { sessionConsumed: { $exists: false } }
    ]
  });
  
  for (const session of notConsumed) {
    addIssue(
      'MEDIUM',
      'SESSION_NOT_CONSUMED',
      `Sessão completada de pacote não marcada como consumida`,
      {
        sessionId: session._id,
        package: session.package,
        sessionConsumed: session.sessionConsumed
      }
    );
  }
  
  console.log(`   ${wrongConsumed.length + notConsumed.length} flags inconsistentes`);
}

async function auditAppointmentSessionMismatch() {
  console.log('🔍 Auditando: Appointment vs Session inconsistentes...');
  
  // Appointments com session referenciada mas sessão não existe
  const appointments = await Appointment.find({
    session: { $ne: null }
  }).limit(500);
  
  for (const appt of appointments) {
    const session = await Session.findById(appt.session);
    if (!session) {
      addIssue(
        'HIGH',
        'ORPHAN_SESSION_REF',
        `Appointment ${appt._id} referencia sessão inexistente`,
        {
          appointmentId: appt._id,
          sessionId: appt.session
        }
      );
    }
  }
  
  // Sessions com appointmentId mas appointment não existe
  const orphanSessions = await Session.find({
    $or: [
      { appointmentId: { $exists: true } },
      { appointment: { $exists: true } }
    ]
  });
  
  for (const session of orphanSessions) {
    const apptId = session.appointmentId || session.appointment;
    if (apptId) {
      const appt = await Appointment.findById(apptId);
      if (!appt) {
        addIssue(
          'HIGH',
          'ORPHAN_SESSION',
          `Session ${session._id} referencia appointment inexistente`,
          {
            sessionId: session._id,
            appointmentId: apptId
          }
        );
      }
    }
  }
  
  console.log(`   ${appointments.length + orphanSessions.length} registros verificados`);
}

async function generateReport() {
  console.log('\n' + '='.repeat(70));
  console.log('📊 RELATÓRIO DE AUDITORIA FINANCEIRA');
  console.log('='.repeat(70));
  
  const bySeverity = {
    CRITICAL: issues.filter(i => i.severity === 'CRITICAL'),
    HIGH: issues.filter(i => i.severity === 'HIGH'),
    MEDIUM: issues.filter(i => i.severity === 'MEDIUM'),
    LOW: issues.filter(i => i.severity === 'LOW')
  };
  
  console.log(`\n🔴 CRÍTICO: ${bySeverity.CRITICAL.length}`);
  bySeverity.CRITICAL.forEach(i => {
    console.log(`   ❌ [${i.category}] ${i.description}`);
  });
  
  console.log(`\n🟠 ALTO: ${bySeverity.HIGH.length}`);
  bySeverity.HIGH.forEach(i => {
    console.log(`   ⚠️  [${i.category}] ${i.description}`);
  });
  
  console.log(`\n🟡 MÉDIO: ${bySeverity.MEDIUM.length}`);
  bySeverity.MEDIUM.forEach(i => {
    console.log(`   ℹ️  [${i.category}] ${i.description}`);
  });
  
  console.log(`\n🟢 BAIXO: ${bySeverity.LOW.length}`);
  
  console.log('\n' + '='.repeat(70));
  console.log(`Total: ${issues.length} problemas encontrados`);
  console.log('='.repeat(70));
  
  // Salva relatório
  const reportPath = resolve(__dirname, `../logs/audit-${Date.now()}.json`);
  await import('fs').then(fs => {
    fs.mkdirSync(resolve(__dirname, '../logs'), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: issues.length,
        critical: bySeverity.CRITICAL.length,
        high: bySeverity.HIGH.length,
        medium: bySeverity.MEDIUM.length,
        low: bySeverity.LOW.length
      },
      issues
    }, null, 2));
    console.log(`\n💾 Relatório salvo em: ${reportPath}`);
  });
  
  return bySeverity.CRITICAL.length === 0;
}

async function main() {
  console.log('🚀 Iniciando auditoria de integridade financeira...\n');
  
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB conectado\n');
  
  await auditSessionsWithoutPayment();
  await auditPackageInconsistencies();
  await auditDuplicatePayments();
  await auditInsuranceGuides();
  await auditSessionConsumedFlag();
  await auditAppointmentSessionMismatch();
  
  const isClean = await generateReport();
  
  await mongoose.disconnect();
  
  console.log('\n' + (isClean ? '✅ SISTEMA LIMPO' : '❌ PROBLEMAS ENCONTRADOS'));
  process.exit(isClean ? 0 : 1);
}

main().catch(err => {
  console.error('💥 Erro na auditoria:', err);
  process.exit(1);
});
