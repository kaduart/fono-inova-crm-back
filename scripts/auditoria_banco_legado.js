#!/usr/bin/env node
/**
 * 🔍 AUDITORIA DO BANCO LEGADO
 * 
 * Analisa inconsistências entre dados legados e modelo V2
 * 
 * Uso: node scripts/auditoria_banco_legado.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crm_development';

console.log('🔍 Conectando ao banco...');
await mongoose.connect(MONGO_URI);
console.log('✅ Conectado\n');

// Models
const Payment = mongoose.model('Payment', new mongoose.Schema({}));
const Session = mongoose.model('Session', new mongoose.Schema({}));
const Package = mongoose.model('Package', new mongoose.Schema({}));
const Appointment = mongoose.model('Appointment', new mongoose.Schema({}));
const Patient = mongoose.model('Patient', new mongoose.Schema({}));
const InsuranceBatch = mongoose.model('InsuranceBatch', new mongoose.Schema({}));

const audit = {
  timestamp: new Date().toISOString(),
  database: mongoose.connection.db.databaseName,
  results: {}
};

console.log('═══════════════════════════════════════════════════════════════');
console.log('🔍 AUDITORIA DO BANCO LEGADO → V2');
console.log('═══════════════════════════════════════════════════════════════\n');

// ═══════════════════════════════════════════════════════════════
// 1. PAYMENTS - Análise
// ═══════════════════════════════════════════════════════════════
console.log('📊 1. PAYMENTS\n');

const totalPayments = await Payment.countDocuments();
console.log(`   Total de Payments: ${totalPayments}`);

// 1.1 Sem billingType
const paymentsNoBillingType = await Payment.countDocuments({ billingType: { $exists: false } });
console.log(`   ❌ Sem billingType: ${paymentsNoBillingType} (${(paymentsNoBillingType/totalPayments*100).toFixed(1)}%)`);

// 1.2 billingType preenchido
const paymentsWithBillingType = await Payment.countDocuments({ billingType: { $exists: true } });
console.log(`   ✅ Com billingType: ${paymentsWithBillingType} (${(paymentsWithBillingType/totalPayments*100).toFixed(1)}%)`);

// 1.3 Por billingType
const byBillingType = await Payment.aggregate([
  { $match: { billingType: { $exists: true } } },
  { $group: { _id: '$billingType', count: { $sum: 1 } } }
]);
console.log('   Por tipo:');
byBillingType.forEach(t => console.log(`      - ${t._id}: ${t.count}`));

// 1.4 PaymentMethod 'package' (problema V2)
const packageMethod = await Payment.countDocuments({ paymentMethod: 'package' });
console.log(`   ⚠️  paymentMethod='package': ${packageMethod}`);

// 1.5 Status 'package_paid' (problema V2)
const packagePaidStatus = await Payment.countDocuments({ status: 'package_paid' });
console.log(`   ⚠️  status='package_paid': ${packagePaidStatus}`);

// 1.6 Convênio sem insurance.status
const convenioNoStatus = await Payment.countDocuments({
  $or: [{ billingType: 'convenio' }, { paymentMethod: 'convenio' }],
  'insurance.status': { $exists: false }
});
console.log(`   🚨 Convênio sem insurance.status: ${convenioNoStatus}`);

// 1.7 paymentDate inconsistente (String vs Date)
const paymentDateTypes = await Payment.aggregate([
  { $project: { type: { $type: '$paymentDate' } } },
  { $group: { _id: '$type', count: { $sum: 1 } } }
]);
console.log('   Tipos de paymentDate:');
paymentDateTypes.forEach(t => {
  const typeName = t._id === 'string' ? 'String' : t._id === 'date' ? 'Date' : t._id;
  console.log(`      - ${typeName}: ${t.count}`);
});

audit.results.payments = {
  total: totalPayments,
  noBillingType: paymentsNoBillingType,
  packageMethod,
  packagePaidStatus,
  convenioNoStatus
};

// ═══════════════════════════════════════════════════════════════
// 2. PACKAGES - Análise
// ═══════════════════════════════════════════════════════════════
console.log('\n📦 2. PACKAGES\n');

const totalPackages = await Package.countDocuments();
console.log(`   Total de Packages: ${totalPackages}`);

// 2.1 Sem type
const packagesNoType = await Package.countDocuments({ type: { $exists: false } });
console.log(`   ❌ Sem type: ${packagesNoType} (${(packagesNoType/totalPackages*100).toFixed(1)}%)`);

// 2.2 Com type
const byType = await Package.aggregate([
  { $match: { type: { $exists: true } } },
  { $group: { _id: '$type', count: { $sum: 1 } } }
]);
console.log('   Por tipo:');
byType.forEach(t => console.log(`      - ${t._id}: ${t.count}`));

// 2.3 Sem insuranceGuide (potencialmente particular)
const noGuide = await Package.countDocuments({ insuranceGuide: { $exists: false } });
console.log(`   ⚠️  Sem insuranceGuide (possivelmente particular): ${noGuide}`);

// 2.4 SessionsDone vs Appointments vinculados (inconsistência)
const packagesWithDiff = await Package.aggregate([
  {
    $lookup: {
      from: 'appointments',
      localField: '_id',
      foreignField: 'package',
      as: 'appointments'
    }
  },
  {
    $project: {
      sessionsDone: 1,
      appointmentsCount: { $size: '$appointments' },
      completedAppointments: {
        $size: {
          $filter: {
            input: '$appointments',
            as: 'apt',
            cond: { $eq: ['$$apt.operationalStatus', 'completed'] }
          }
        }
      }
    }
  },
  {
    $match: {
      $expr: { $ne: ['$sessionsDone', '$completedAppointments'] }
    }
  },
  { $count: 'total' }
]);
const diffCount = packagesWithDiff[0]?.total || 0;
console.log(`   🚨 Packages com sessionsDone ≠ appointments completados: ${diffCount}`);

audit.results.packages = {
  total: totalPackages,
  noType: packagesNoType,
  noGuide,
  inconsistentSessionsDone: diffCount
};

// ═══════════════════════════════════════════════════════════════
// 3. SESSIONS - Análise
// ═══════════════════════════════════════════════════════════════
console.log('\n🗓️  3. SESSIONS\n');

const totalSessions = await Session.countDocuments();
console.log(`   Total de Sessions: ${totalSessions}`);

// 3.1 Status distribution
const sessionStatus = await Session.aggregate([
  { $group: { _id: '$status', count: { $sum: 1 } } }
]);
console.log('   Por status:');
sessionStatus.forEach(s => console.log(`      - ${s._id}: ${s.count}`));

// 3.2 isPaid=true mas sem Payment vinculado
const sessionsWithPackage = await Session.countDocuments({ package: { $exists: true, $ne: null } });
console.log(`   📦 Vinculadas a Package: ${sessionsWithPackage}`);

// 3.3 Sem package (particulares)
const sessionsWithoutPackage = await Session.countDocuments({
  $or: [{ package: { $exists: false } }, { package: null }]
});
console.log(`   👤 Sem package (particulares): ${sessionsWithoutPackage}`);

// 3.4 Com billingBatchId (campo novo V2)
const withBatchId = await Session.countDocuments({ billingBatchId: { $exists: true } });
console.log(`   ✅ Com billingBatchId (V2): ${withBatchId}`);

// 3.5 Com insuranceBillingProcessed (campo V2)
const withInsuranceProcessed = await Session.countDocuments({ insuranceBillingProcessed: { $exists: true } });
console.log(`   ✅ Com insuranceBillingProcessed (V2): ${withInsuranceProcessed}`);

audit.results.sessions = {
  total: totalSessions,
  withPackage: sessionsWithPackage,
  withoutPackage: sessionsWithoutPackage,
  withBatchId,
  withInsuranceProcessed
};

// ═══════════════════════════════════════════════════════════════
// 4. APPOINTMENTS - Análise
// ═══════════════════════════════════════════════════════════════
console.log('\n📅 4. APPOINTMENTS\n');

const totalAppointments = await Appointment.countDocuments();
console.log(`   Total de Appointments: ${totalAppointments}`);

// 4.1 Por operationalStatus
const aptStatus = await Appointment.aggregate([
  { $group: { _id: '$operationalStatus', count: { $sum: 1 } } }
]);
console.log('   Por operationalStatus:');
aptStatus.forEach(s => console.log(`      - ${s._id}: ${s.count}`));

// 4.2 Completados sem Session vinculada
const completedNoSession = await Appointment.countDocuments({
  operationalStatus: 'completed',
  $or: [{ session: { $exists: false } }, { session: null }]
});
console.log(`   🚨 Completados sem Session: ${completedNoSession}`);

// 4.3 Com package (de pacote)
const aptWithPackage = await Appointment.countDocuments({
  package: { $exists: true, $ne: null }
});
console.log(`   📦 De pacote: ${aptWithPackage}`);

audit.results.appointments = {
  total: totalAppointments,
  completedNoSession,
  withPackage: aptWithPackage
};

// ═══════════════════════════════════════════════════════════════
// 5. INSURANCE BATCHES (V2)
// ═══════════════════════════════════════════════════════════════
console.log('\n🏥 5. INSURANCE BATCHES (V2)\n');

const totalBatches = await InsuranceBatch.countDocuments().catch(() => 0);
console.log(`   Total de Batches: ${totalBatches}`);

if (totalBatches > 0) {
  const batchStatus = await InsuranceBatch.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]).catch(() => []);
  console.log('   Por status:');
  batchStatus.forEach(s => console.log(`      - ${s._id}: ${s.count}`));
}

audit.results.insuranceBatches = {
  total: totalBatches
};

// ═══════════════════════════════════════════════════════════════
// 6. RESUMO CRÍTICO
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('🚨 PROBLEMAS CRÍTICOS PARA MIGRAÇÃO V2');
console.log('═══════════════════════════════════════════════════════════════\n');

const problemas = [];

if (paymentsNoBillingType > 0) {
  problemas.push(`• ${paymentsNoBillingType} Payments sem billingType (impossível saber se é particular ou convênio)`);
}

if (packageMethod > 0) {
  problemas.push(`• ${packageMethod} Payments com paymentMethod='package' (não existe no V2)`);
}

if (packagesNoType > 0) {
  problemas.push(`• ${packagesNoType} Packages sem type (impossível saber se é therapy/convenio/liminar)`);
}

if (diffCount > 0) {
  problemas.push(`• ${diffCount} Packages com contador de sessões inconsistente`);
}

if (completedNoSession > 0) {
  problemas.push(`• ${completedNoSession} Appointments completados sem Session vinculada`);
}

if (convenioNoStatus > 0) {
  problemas.push(`• ${convenioNoStatus} Convênios sem status de faturamento`);
}

if (problemas.length === 0) {
  console.log('✅ Nenhum problema crítico encontrado!');
} else {
  problemas.forEach(p => console.log(p));
}

// ═══════════════════════════════════════════════════════════════
// 7. RECOMENDAÇÕES
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('📋 RECOMENDAÇÕES');
console.log('═══════════════════════════════════════════════════════════════\n');

if (paymentsNoBillingType > totalPayments * 0.1) {
  console.log('🔴 PRIORIDADE 1: Adicionar billingType em todos os Payments');
  console.log('   → Script: corrigir_payments_billingtype.js\n');
}

if (packagesNoType > 0) {
  console.log('🔴 PRIORIDADE 2: Classificar Packages sem type');
  console.log('   → Se tem insuranceGuide → convenio');
  console.log('   → Se não tem → therapy (particular)\n');
}

if (packageMethod > 0 || packagePaidStatus > 0) {
  console.log('🟡 PRIORIDADE 3: Migrar paymentMethod/status de pacote');
  console.log('   → Criar Payment para cada sessão de pacote\n');
}

console.log('💡 Após correções, execute: node scripts/migrar_v2.js\n');

// Salvar relatório
const fs = await import('fs');
const reportPath = `/tmp/auditoria_banco_${Date.now()}.json`;
fs.writeFileSync(reportPath, JSON.stringify(audit, null, 2));
console.log(`📄 Relatório salvo em: ${reportPath}`);

await mongoose.disconnect();
console.log('\n✅ Auditoria completa!');
process.exit(0);
