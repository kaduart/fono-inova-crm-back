// scripts/cancelar-sessao-antonella-10h-quinta.mjs
//
// Cancela a sessão órfã de Antonella Souza Eneas no slot 23/07/2026 10:00
// com a Dra. Tatiana Celuta Peres, liberando o horário para novos agendamentos.
//
// Uso:
//   node scripts/cancelar-sessao-antonella-10h-quinta.mjs --dry-run
//   node scripts/cancelar-sessao-antonella-10h-quinta.mjs

import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_SESSION_ID = '6a3c0c33c3dd2574dca65011';

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

async function main() {
  console.log(`🔌 Conectando ao MongoDB... ${DRY_RUN ? '[DRY-RUN]' : ''}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000 });
  const db = mongoose.connection.db;
  console.log('✅ Conectado');

  const sessionsColl = db.collection('sessions');
  const sessionId = new mongoose.Types.ObjectId(TARGET_SESSION_ID);

  const session = await sessionsColl.findOne({ _id: sessionId });
  if (!session) {
    console.error(`❌ Sessão ${TARGET_SESSION_ID} não encontrada`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('\n📋 Sessão a ser cancelada:');
  console.log(JSON.stringify({
    _id: session._id,
    patient: session.patient,
    doctor: session.doctor,
    date: session.date,
    time: session.time,
    status: session.status,
    paymentStatus: session.paymentStatus,
    appointmentId: session.appointmentId,
  }, null, 2));

  // Backup
  const backupDir = path.resolve(
    'backups-mongo',
    `cancel-sessao-antonella-${TARGET_SESSION_ID}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'session-before.json'), JSON.stringify(session, null, 2));
  console.log(`\n💾 Backup salvo em: ${backupDir}`);

  const update = {
    $set: {
      status: 'canceled',
      paymentStatus: 'canceled',
      visualFlag: 'blocked',
      updatedAt: new Date(),
    },
  };

  console.log('\n📝 Update a ser aplicado:');
  console.log(JSON.stringify(update, (key, value) => value instanceof Date ? value.toISOString() : value, 2));

  if (!DRY_RUN) {
    const result = await sessionsColl.updateOne({ _id: sessionId }, update);
    console.log('\n✅ Sessão cancelada:', result.modifiedCount, 'modificado(s)');

    const updated = await sessionsColl.findOne({ _id: sessionId });
    console.log('\n📋 Novo estado:');
    console.log(JSON.stringify({
      _id: updated._id,
      status: updated.status,
      paymentStatus: updated.paymentStatus,
      visualFlag: updated.visualFlag,
      updatedAt: updated.updatedAt,
    }, null, 2));
  } else {
    console.log('\n🛑 DRY-RUN: nenhuma alteração foi aplicada.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
