#!/usr/bin/env node
/**
 * 🔧 CORREÇÃO DE DADOS LEGADOS
 * 
 * Prepara dados do legado para migração V2
 * 
 * Uso: node scripts/corrigir_dados_legado.js --dry-run (preview)
 *       node scripts/corrigir_dados_legado.js --execute (aplicar)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isExecute = args.includes('--execute');

if (!isDryRun && !isExecute) {
  console.log('❌ Uso: node scripts/corrigir_dados_legado.js --dry-run | --execute');
  process.exit(1);
}

console.log(isDryRun ? '\n🔍 MODO: Preview (dry-run)\n' : '\n🔧 MODO: Aplicar correções\n');

await mongoose.connect(process.env.MONGO_URI);

const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
const Package = mongoose.model('Package', new mongoose.Schema({}, { strict: false }));
const Session = mongoose.model('Session', new mongoose.Schema({}, { strict: false }));
const Appointment = mongoose.model('Appointment', new mongoose.Schema({}, { strict: false }));

const changes = [];

// ═══════════════════════════════════════════════════════════════
// 1. Adicionar billingType em Payments
// ═══════════════════════════════════════════════════════════════
console.log('1️⃣  Adicionando billingType em Payments...\n');

// 1.1 Convenios (paymentMethod ou insurance presente)
const convenioQuery = {
  billingType: { $exists: false },
  $or: [
    { paymentMethod: 'convenio' },
    { 'insurance.provider': { $exists: true } },
    { insuranceProvider: { $exists: true } }
  ]
};

const conveniosToFix = await Payment.countDocuments(convenioQuery);
console.log(`   Convenios para corrigir: ${conveniosToFix}`);

if (!isDryRun && conveniosToFix > 0) {
  const result = await Payment.updateMany(convenioQuery, {
    $set: { billingType: 'convenio' }
  });
  console.log(`   ✅ Corrigidos: ${result.modifiedCount}`);
  changes.push({ field: 'billingType:convenio', count: result.modifiedCount });
}

// 1.2 Particulares (outros paymentMethods)
const particularQuery = {
  billingType: { $exists: false },
  paymentMethod: { $in: ['dinheiro', 'pix', 'cartao', 'cartão', 'transferencia'] }
};

const particularesToFix = await Payment.countDocuments(particularQuery);
console.log(`   Particulares para corrigir: ${particularesToFix}`);

if (!isDryRun && particularesToFix > 0) {
  const result = await Payment.updateMany(particularQuery, {
    $set: { billingType: 'particular' }
  });
  console.log(`   ✅ Corrigidos: ${result.modifiedCount}`);
  changes.push({ field: 'billingType:particular', count: result.modifiedCount });
}

// 1.3 Packages (paymentMethod='package') → analisar caso a caso
const packagePayments = await Payment.find({ 
  $or: [
    { paymentMethod: 'package' },
    { status: 'package_paid' }
  ]
});

console.log(`   ⚠️  Payments de pacote: ${packagePayments.length} (requer análise manual)`);

// ═══════════════════════════════════════════════════════════════
// 2. Adicionar type em Packages
// ═══════════════════════════════════════════════════════════════
console.log('\n2️⃣  Adicionando type em Packages...\n');

// 2.1 Convênios (têm insuranceGuide)
const pkgConvenioQuery = { 
  type: { $exists: false },
  $or: [
    { insuranceGuide: { $exists: true } },
    { insuranceProvider: { $exists: true } }
  ]
};

const pkgConveniosToFix = await Package.countDocuments(pkgConvenioQuery);
console.log(`   Packages convenio: ${pkgConveniosToFix}`);

if (!isDryRun && pkgConveniosToFix > 0) {
  const result = await Package.updateMany(pkgConvenioQuery, {
    $set: { type: 'convenio' }
  });
  console.log(`   ✅ Corrigidos: ${result.modifiedCount}`);
  changes.push({ field: 'type:convenio', count: result.modifiedCount });
}

// 2.2 Liminar (têm campos liminar)
const pkgLiminarQuery = {
  type: { $exists: false },
  $or: [
    { liminarProcessNumber: { $exists: true } },
    { liminarCourt: { $exists: true } }
  ]
};

const pkgLiminarToFix = await Package.countDocuments(pkgLiminarQuery);
console.log(`   Packages liminar: ${pkgLiminarToFix}`);

if (!isDryRun && pkgLiminarToFix > 0) {
  const result = await Package.updateMany(pkgLiminarQuery, {
    $set: { type: 'liminar' }
  });
  console.log(`   ✅ Corrigidos: ${result.modifiedCount}`);
  changes.push({ field: 'type:liminar', count: result.modifiedCount });
}

// 2.3 Therapy (restante)
const pkgTherapyQuery = { type: { $exists: false } };
const pkgTherapyToFix = await Package.countDocuments(pkgTherapyQuery);
console.log(`   Packages therapy (restante): ${pkgTherapyToFix}`);

if (!isDryRun && pkgTherapyToFix > 0) {
  const result = await Package.updateMany(pkgTherapyQuery, {
    $set: { type: 'therapy' }
  });
  console.log(`   ✅ Corrigidos: ${result.modifiedCount}`);
  changes.push({ field: 'type:therapy', count: result.modifiedCount });
}

// ═══════════════════════════════════════════════════════════════
// 3. Corrigir Sessions de pacote
// ═══════════════════════════════════════════════════════════════
console.log('\n3️⃣  Verificando Sessions...\n');

// Sessions de pacote devem ter isPaid=true (usam crédito)
const sessionsPacote = await Session.countDocuments({
  package: { $exists: true, $ne: null },
  $or: [{ isPaid: { $exists: false } }, { isPaid: false }]
});
console.log(`   Sessions de pacote sem isPaid=true: ${sessionsPacote}`);

if (!isDryRun && sessionsPacote > 0) {
  const result = await Session.updateMany(
    { package: { $exists: true, $ne: null } },
    { $set: { isPaid: true, paymentStatus: 'package_paid' } }
  );
  console.log(`   ✅ Corrigidas: ${result.modifiedCount}`);
  changes.push({ field: 'session.isPaid', count: result.modifiedCount });
}

// ═══════════════════════════════════════════════════════════════
// 4. Normalizar paymentDate (String)
// ═══════════════════════════════════════════════════════════════
console.log('\n4️⃣  Normalizando datas...\n');

// Converter Date para String "YYYY-MM-DD"
const paymentsDate = await Payment.find({
  paymentDate: { $type: 'date' }
}).limit(5);

console.log(`   Payments com paymentDate tipo Date: ${paymentsDate.length} (mostrando 5)`);

if (!isDryRun && paymentsDate.length > 0) {
  // Esta correção é complexa, requer migrar um por um
  console.log('   ⚠️  Correção manual necessária para datas');
}

// ═══════════════════════════════════════════════════════════════
// RESUMO
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(isDryRun ? '🔍 PREVIEW DAS CORREÇÕES' : '🔧 CORREÇÕES APLICADAS');
console.log('═══════════════════════════════════════════════════════════════\n');

if (isDryRun) {
  console.log('Modo preview - nenhuma alteração foi feita.');
  console.log('Para aplicar, execute com --execute\n');
} else {
  console.log('Alterações realizadas:');
  changes.forEach(c => console.log(`  • ${c.field}: ${c.count}`));
  
  // Salvar log
  const fs = await import('fs');
  const logPath = `/tmp/correcoes_legado_${Date.now()}.json`;
  fs.writeFileSync(logPath, JSON.stringify({ timestamp: new Date(), changes }, null, 2));
  console.log(`\n📄 Log salvo em: ${logPath}`);
}

await mongoose.disconnect();
console.log('\n✅ Completo!');
process.exit(0);
