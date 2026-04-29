/**
 * CORREÇÃO SEGURA DE totalPaid INCONSISTENTE
 *
 * REGRAS:
 *   Tipo A (sessionValue > 0): recalcula totalPaid = paidSessions * sessionValue
 *   Tipo B (sessionValue = 0): busca referência do mesmo paciente/especialidade
 *   Tipo C (0 pagas, totalPaid > 0): NÃO corrige, só loga
 *
 * MODO DRY-RUN por padrão. Para executar: --execute
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/fono_inova_prod';
const EXECUTE = process.argv.includes('--execute');

async function run() {
  console.log(EXECUTE ? '🔴 MODO EXECUÇÃO' : '🟡 MODO DRY-RUN (só loga, não salva)');
  console.log('Para executar de verdade: node scripts/fix-package-totalpaid.js --execute\n');

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const packages = db.collection('packages');
  const sessions = db.collection('sessions');

  // Buscar todos os pacotes inconsistentes
  const inconsistent = await packages.aggregate([
    {
      $lookup: {
        from: 'sessions',
        localField: '_id',
        foreignField: 'package',
        as: 'sessions'
      }
    },
    {
      $addFields: {
        paidSessions: {
          $size: {
            $filter: {
              input: '$sessions',
              as: 's',
              cond: { $eq: ['$$s.isPaid', true] }
            }
          }
        }
      }
    },
    {
      $addFields: {
        expectedTotalPaid: { $multiply: ['$paidSessions', '$sessionValue'] }
      }
    },
    {
      $match: {
        $expr: { $ne: ['$totalPaid', '$expectedTotalPaid'] }
      }
    },
    { $sort: { _id: 1 } }
  ]).toArray();

  console.log(`📊 Pacotes inconsistentes encontrados: ${inconsistent.length}\n`);

  let fixedA = 0, fixedB = 0, skippedC = 0, skippedB = 0;

  for (const pkg of inconsistent) {
    const pkgId = pkg._id.toString();
    const patientId = pkg.patient?.toString();
    const specialty = pkg.sessionType;
    const sessionValue = pkg.sessionValue || 0;
    const paidSessions = pkg.paidSessions || 0;
    const totalPaid = pkg.totalPaid || 0;
    const sessionsDone = pkg.sessionsDone || 0;

    // ========== TIPO C: 0 pagas, mas totalPaid > 0 ==========
    if (paidSessions === 0 && totalPaid > 0) {
      console.log(`🔥 TIPO C (MANUAL): ${pkgId}`);
      console.log(`   Paciente: ${patientId} | Especialidade: ${specialty}`);
      console.log(`   0 sessões pagas, mas totalPaid = ${totalPaid}`);
      console.log(`   → NÃO corrigido. Investigação manual necessária.\n`);
      skippedC++;
      continue;
    }

    // ========== TIPO A: sessionValue > 0 ==========
    if (sessionValue > 0) {
      const expected = paidSessions * sessionValue;
      console.log(`✅ TIPO A: ${pkgId}`);
      console.log(`   Paciente: ${patientId} | ${specialty}`);
      console.log(`   ${paidSessions} pagas × R$ ${sessionValue} = R$ ${expected}`);
      console.log(`   totalPaid: R$ ${totalPaid} → R$ ${expected}`);

      if (EXECUTE) {
        await packages.updateOne(
          { _id: pkg._id },
          { $set: { totalPaid: expected, updatedAt: new Date() } }
        );
        console.log('   → SALVO\n');
      } else {
        console.log('   → (dry-run, não salvo)\n');
      }
      fixedA++;
      continue;
    }

    // ========== TIPO B: sessionValue = 0 ==========
    console.log(`⚠️  TIPO B: ${pkgId}`);
    console.log(`   Paciente: ${patientId} | ${specialty}`);
    console.log(`   sessionValue = 0, ${paidSessions} pagas, totalPaid = ${totalPaid}`);

    // Buscar referência: outro pacote do mesmo paciente + especialidade
    const ref = await packages.findOne({
      patient: pkg.patient,
      sessionType: specialty,
      sessionValue: { $gt: 0 },
      _id: { $ne: pkg._id }
    }, { projection: { sessionValue: 1, createdAt: 1 }, sort: { createdAt: -1 } });

    let newValue = ref?.sessionValue || 0;

    // Fallback por especialidade (valores típicos)
    if (!newValue) {
      const fallback = {
        fonoaudiologia: 160,
        psicologia: 130,
        terapia_ocupacional: 80,
        fisioterapia: 140,
        psicopedagogia: 125,
        psicomotricidade: 80
      };
      newValue = fallback[specialty] || 0;
    }

    if (!newValue) {
      console.log(`   ❌ Sem referência segura. NÃO corrigido.\n`);
      skippedB++;
      continue;
    }

    const expected = paidSessions * newValue;
    console.log(`   Referência: R$ ${newValue} (${ref ? 'mesmo paciente' : 'fallback especialidade'})`);
    console.log(`   sessionValue: 0 → ${newValue}`);
    console.log(`   totalPaid: ${totalPaid} → ${expected}`);

    if (EXECUTE) {
      await packages.updateOne(
        { _id: pkg._id },
        {
          $set: {
            sessionValue: newValue,
            totalPaid: expected,
            updatedAt: new Date()
          }
        }
      );
      console.log('   → SALVO\n');
    } else {
      console.log('   → (dry-run, não salvo)\n');
    }
    fixedB++;
  }

  console.log('========================================');
  console.log('  RESUMO');
  console.log('========================================');
  console.log(`Tipo A corrigidos: ${fixedA}`);
  console.log(`Tipo B corrigidos: ${fixedB}`);
  console.log(`Tipo B pulados (sem ref): ${skippedB}`);
  console.log(`Tipo C pulados (manual): ${skippedC}`);
  console.log(`Total: ${fixedA + fixedB + skippedB + skippedC}/${inconsistent.length}`);
  console.log(EXECUTE ? '\n✅ EXECUÇÃO COMPLETA' : '\n🟡 DRY-RUN (use --execute para salvar)');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
