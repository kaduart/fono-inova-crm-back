// scripts/alterar-payment-date-6a58d974ce43485b2af4850a.mjs
//
// Altera paymentDate e financialDate do payment 6a58d974ce43485b2af4850a
// para 15/07/2026, preservando o horário original.
//
// Uso:
//   node scripts/alterar-payment-date-6a58d974ce43485b2af4850a.mjs --dry-run
//   node scripts/alterar-payment-date-6a58d974ce43485b2af4850a.mjs

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_PAYMENT_ID = '6a58d974ce43485b2af4850a';

const possibleEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'back', '.env'),
  path.resolve(process.cwd(), '..', 'back', '.env'),
];

let loadedEnv = false;
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    loadedEnv = true;
    break;
  }
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não encontrado. Execute a partir de /back ou da raiz do projeto.');
  process.exit(1);
}

function changeDateKeepTime(originalDate, newDateStr) {
  const original = new Date(originalDate);
  const [day, month, year] = newDateStr.split('/').map(Number);
  const fullYear = year < 100 ? 2000 + year : year;
  return new Date(Date.UTC(fullYear, month - 1, day, original.getUTCHours(), original.getUTCMinutes(), original.getUTCSeconds(), original.getUTCMilliseconds()));
}

async function main() {
  console.log(`🔌 Conectando ao MongoDB... ${DRY_RUN ? '[DRY-RUN]' : ''}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;
  console.log('✅ Conectado');

  const paymentsColl = db.collection('payments');
  const paymentId = new mongoose.Types.ObjectId(TARGET_PAYMENT_ID);

  const payment = await paymentsColl.findOne({ _id: paymentId });
  if (!payment) {
    console.error(`❌ Payment ${TARGET_PAYMENT_ID} não encontrado`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('\n📋 Estado atual:');
  console.log(`  _id           : ${payment._id}`);
  console.log(`  amount        : ${payment.amount}`);
  console.log(`  paymentDate   : ${payment.paymentDate}`);
  console.log(`  financialDate : ${payment.financialDate}`);
  console.log(`  updatedAt     : ${payment.updatedAt}`);

  // Backup
  const backupDir = path.resolve(
    'backups-mongo',
    `payment-date-${TARGET_PAYMENT_ID}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'payment-before.json'), JSON.stringify(payment, null, 2));
  console.log(`\n💾 Backup salvo em: ${backupDir}`);

  const newDateStr = '15/07/26';
  const newPaymentDate = changeDateKeepTime(payment.paymentDate, newDateStr);
  const newFinancialDate = changeDateKeepTime(payment.financialDate || payment.paymentDate, newDateStr);

  const update = {
    $set: {
      paymentDate: newPaymentDate,
      financialDate: newFinancialDate,
      updatedAt: new Date(),
    },
  };

  console.log('\n📝 Update a ser aplicado:');
  console.log(JSON.stringify(update, (key, value) => value instanceof Date ? value.toISOString() : value, 2));

  if (!DRY_RUN) {
    const result = await paymentsColl.updateOne({ _id: paymentId }, update);
    console.log('\n✅ Payment atualizado:', result.modifiedCount, 'modificado(s)');

    const updated = await paymentsColl.findOne({ _id: paymentId });
    console.log('\n📋 Novo estado:');
    console.log(`  paymentDate   : ${updated.paymentDate}`);
    console.log(`  financialDate : ${updated.financialDate}`);
    console.log(`  updatedAt     : ${updated.updatedAt}`);
  } else {
    console.log('\n🛑 DRY-RUN: nenhuma alteração foi aplicada.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
