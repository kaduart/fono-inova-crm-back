/**
 * 🔗 Auto-Link Seguro — 4 Packages
 *
 * Regras de ouro (TODAS devem passar):
 * 1. payment.patientId === package.patientId
 * 2. payment.amount === package.sessionValue (ou totalPaid)
 * 3. payment.status === 'paid'
 * 4. payment.package == null
 * 5. payment existe no banco
 * 6. package existe no banco
 *
 * MODO: sempre dry-run primeiro. Para executar: --execute
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const EXECUTE = process.argv.includes('--execute');

// Os 4 alvos
const TARGETS = [
  {
    packageId: '69e10d35c4148f753a6d1ade',
    patientId: '691237ba37e44afa188bed53',
    expectedAmount: 180,
    paymentId: '69ef743e80f633378a205a6c',
    patientName: 'Mikhael Venâncio da Cunha'
  },
  {
    packageId: '69e229164e856f552b1a9e84',
    patientId: '69df8fb7184611c8dae768a2',
    expectedAmount: 180,
    paymentId: '69ebaf0523b886d509abd394',
    patientName: 'Ercy Jacinto da Silva'
  },
  {
    packageId: '69e2680f11988055724858ce',
    patientId: '69d6626d19c6571d8c76c728',
    expectedAmount: 180,
    paymentId: '69efd75a6d3b7ccdae9d5e76',
    patientName: 'Benício Oliveira Wagner'
  },
  {
    packageId: '69efd3176d3b7ccdae9d574a',
    patientId: '69df8fa6184611c8dae76864',
    expectedAmount: 140,
    paymentId: '69eff13f32e591f35ccc33d9',
    patientName: 'Isaac Flávio Lacerda Dantas'
  }
];

async function run() {
  console.log(EXECUTE ? '🔴 MODO EXECUÇÃO' : '🟡 MODO DRY-RUN (só loga, não salva)');
  console.log('Para executar de verdade: node scripts/auto-link-4-packages.js --execute\n');

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const payments = db.collection('payments');
  const packages = db.collection('packages');

  const results = [];

  for (const target of TARGETS) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📦 ${target.patientName}`);
    console.log(`   Package: ${target.packageId}`);
    console.log(`   Payment: ${target.paymentId}`);
    console.log(`   Valor esperado: R$ ${target.expectedAmount}\n`);

    const result = {
      packageId: target.packageId,
      patientName: target.patientName,
      status: 'PENDING',
      validations: []
    };

    // 1. Buscar package
    const pkg = await packages.findOne({ _id: new mongoose.Types.ObjectId(target.packageId) });
    if (!pkg) {
      result.status = 'FAILED';
      result.error = 'Package não encontrado';
      results.push(result);
      console.log('   ❌ Package não encontrado\n');
      continue;
    }
    result.validations.push('✅ Package existe');

    // 2. Buscar payment
    const payment = await payments.findOne({ _id: new mongoose.Types.ObjectId(target.paymentId) });
    if (!payment) {
      result.status = 'FAILED';
      result.error = 'Payment não encontrado';
      results.push(result);
      console.log('   ❌ Payment não encontrado\n');
      continue;
    }
    result.validations.push('✅ Payment existe');

    // 3. Validar patient match
    const pkgPatient = pkg.patient?.toString();
    const payPatient = payment.patient?.toString();
    if (pkgPatient !== payPatient) {
      result.status = 'FAILED';
      result.error = `Patient mismatch: package=${pkgPatient} vs payment=${payPatient}`;
      results.push(result);
      console.log(`   ❌ Patient mismatch: package=${pkgPatient} vs payment=${payPatient}\n`);
      continue;
    }
    result.validations.push('✅ Patient match');

    // 4. Validar amount
    if (payment.amount !== target.expectedAmount) {
      result.status = 'FAILED';
      result.error = `Amount mismatch: esperado=${target.expectedAmount} vs payment=${payment.amount}`;
      results.push(result);
      console.log(`   ❌ Amount mismatch: esperado=${target.expectedAmount} vs payment=${payment.amount}\n`);
      continue;
    }
    result.validations.push('✅ Amount match');

    // 5. Validar status = paid
    if (payment.status !== 'paid') {
      result.status = 'FAILED';
      result.error = `Payment status=${payment.status} (esperado: paid)`;
      results.push(result);
      console.log(`   ❌ Payment status=${payment.status} (esperado: paid)\n`);
      continue;
    }
    result.validations.push('✅ Status = paid');

    // 6. Validar payment.package == null
    if (payment.package) {
      result.status = 'FAILED';
      result.error = `Payment já vinculado ao package ${payment.package}`;
      results.push(result);
      console.log(`   ❌ Payment já vinculado ao package ${payment.package}\n`);
      continue;
    }
    result.validations.push('✅ Payment não vinculado');

    // 7. Tudo passou — executar ou logar
    console.log('   ' + result.validations.join('\n   '));

    if (EXECUTE) {
      await payments.updateOne(
        { _id: payment._id },
        {
          $set: {
            package: pkg._id,
            updatedAt: new Date()
          }
        }
      );

      result.status = 'LINKED';
      console.log('   🔗 VÍNCULO CRIADO\n');
    } else {
      result.status = 'READY';
      console.log('   🟡 PRONTO PARA VINCULAR (dry-run)\n');
    }

    results.push(result);
  }

  // Resumo
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('RESUMO');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const linked = results.filter(r => r.status === 'LINKED').length;
  const ready = results.filter(r => r.status === 'READY').length;
  const failed = results.filter(r => r.status === 'FAILED').length;

  console.log(`Total: ${results.length}`);
  console.log(`  🔗 Vinculados: ${linked}`);
  console.log(`  🟡 Prontos: ${ready}`);
  console.log(`  ❌ Falhas: ${failed}`);

  if (failed > 0) {
    console.log('\nFalhas:');
    for (const r of results.filter(r => r.status === 'FAILED')) {
      console.log(`  • ${r.patientName}: ${r.error}`);
    }
  }

  console.log(EXECUTE ? '\n✅ EXECUÇÃO COMPLETA' : '\n🟡 DRY-RUN (use --execute para vincular)');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
