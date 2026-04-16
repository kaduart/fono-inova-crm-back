/**
 * 🧹 CLEANUP: Appointments duplicados (mesmo doctor + date + time)
 *
 * REGRA DE DECISÃO (qual manter):
 *   1. Tem package → prioridade máxima
 *   2. Tem payment → segunda prioridade
 *   3. Mais recente → desempate
 *
 * MODO:
 *   DRY_RUN=true  → só lista, não deleta (padrão)
 *   DRY_RUN=false → deleta os duplicados
 *
 * USO:
 *   node scripts/cleanup-duplicate-appointments.js
 *   DRY_RUN=false node scripts/cleanup-duplicate-appointments.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n🔍 Modo: ${DRY_RUN ? 'DRY RUN (só leitura)' : '⚠️  REAL (vai deletar)'}\n`);

  const db = mongoose.connection.db;

  // 1. Achar grupos com duplicata
  const groups = await db.collection('appointments').aggregate([
    {
      $match: {
        doctor: { $exists: true, $ne: null },
        date:   { $exists: true, $ne: null },
        time:   { $exists: true, $ne: null },
        operationalStatus: { $nin: ['canceled'] }
      }
    },
    {
      $group: {
        _id: { doctor: '$doctor', date: '$date', time: '$time' },
        count: { $sum: 1 },
        ids: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  if (groups.length === 0) {
    console.log('✅ Nenhum duplicado encontrado. Base está limpa.');
    await mongoose.disconnect();
    return;
  }

  console.log(`⚠️  ${groups.length} grupo(s) com duplicata encontrado(s):\n`);

  let totalDeleted = 0;

  for (const group of groups) {
    const docs = await db.collection('appointments')
      .find({ _id: { $in: group.ids } })
      .toArray();

    // Ordenar: package > payment > mais recente
    docs.sort((a, b) => {
      const aScore = (a.package ? 2 : 0) + (a.payment ? 1 : 0);
      const bScore = (b.package ? 2 : 0) + (b.payment ? 1 : 0);
      if (bScore !== aScore) return bScore - aScore;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    const keep   = docs[0];
    const remove = docs.slice(1);

    console.log(`📅 Slot: ${group._id.date?.toISOString?.() || group._id.date} às ${group._id.time}`);
    console.log(`   ✅ MANTER  → ${keep._id} | package: ${keep.package || 'null'} | payment: ${keep.payment || 'null'} | status: ${keep.operationalStatus}`);

    for (const doc of remove) {
      console.log(`   ❌ DELETAR → ${doc._id} | package: ${doc.package || 'null'} | payment: ${doc.payment || 'null'} | status: ${doc.operationalStatus}`);

      if (!DRY_RUN) {
        // Limpa sessions órfãs vinculadas
        const sessionResult = await db.collection('sessions').deleteMany({ appointmentId: doc._id });
        if (sessionResult.deletedCount > 0) {
          console.log(`      🧹 ${sessionResult.deletedCount} session(s) removida(s)`);
        }

        // Deleta o appointment duplicado
        await db.collection('appointments').deleteOne({ _id: doc._id });
        totalDeleted++;
        console.log(`      ✅ Deletado`);
      }
    }

    console.log('');
  }

  if (DRY_RUN) {
    console.log('──────────────────────────────────────────');
    console.log('ℹ️  DRY RUN — nada foi deletado.');
    console.log('   Para executar: DRY_RUN=false node scripts/cleanup-duplicate-appointments.js');
  } else {
    console.log(`✅ Limpeza concluída. ${totalDeleted} appointment(s) removido(s).`);
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
