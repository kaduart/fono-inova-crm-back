/**
 * 🧪 Ensaio de MESCLAR pacientes duplicados — SÓ no espelho local (127.0.0.1:27018/fono_espelho).
 *
 *   npm run espelho:mesclar                          → lista os primeiros grupos de duplicados
 *   npm run espelho:mesclar -- <principal> <dup>     → prévia + mescla + confere que nada sobrou no duplicado
 *
 * Recusa qualquer URI que não seja a local. Nunca toca produção.
 * Ver domains/patient/commands/mergePatientsCommand.js.
 */
import mongoose from 'mongoose';
import { URI, isLocalUri } from './config.mjs';

if (!isLocalUri(URI) || /prod/i.test(URI)) {
  console.error('❌ Ensaio só roda no espelho local. URI recusada.');
  process.exit(1);
}

process.env.PATIENT_MERGE_ENABLED = 'true'; // só neste processo, só no espelho

const [primaryId, duplicateId] = process.argv.slice(2);

await mongoose.connect(URI, { serverSelectionTimeoutMS: 10_000 });
console.log(`🪞 conectado em ${URI}`);

const { default: Patient } = await import('../../models/Patient.js');
const { normalizeName } = await import('../../utils/patientDuplicateCheck.js');
const merge = await import('../../domains/patient/commands/mergePatientsCommand.js');

try {
  if (!primaryId || !duplicateId) {
    const all = await Patient.find({}).select('fullName dateOfBirth phone').lean();
    const groups = new Map();
    for (const p of all) {
      const k = normalizeName(p.fullName);
      groups.set(k, [...(groups.get(k) || []), p]);
    }
    const dups = [...groups.values()].filter((g) => g.length > 1).slice(0, 15);
    console.log(`\n${dups.length} grupos (mostrando até 15). Use: npm run espelho:mesclar -- <principal> <duplicado>\n`);
    for (const g of dups) {
      for (const p of g) console.log(`  ${p._id}  ${p.fullName}  nasc=${p.dateOfBirth?.toISOString?.().slice(0, 10) || '-'}  tel=${p.phone || '-'}`);
      console.log('');
    }
  } else {
    const preview = await merge.execute({ primaryId, duplicateId, dryRun: true });
    console.log('\n📋 PRÉVIA\n', JSON.stringify(preview, null, 2));

    const result = await merge.execute({ primaryId, duplicateId, dryRun: false, user: { id: 'ensaio-espelho', role: 'admin' } });
    console.log('\n✅ MESCLADO\n', JSON.stringify(result.movidos, null, 2));

    // conferência: nada mais aponta para o duplicado (exceto lançamentos contábeis imutáveis)
    const after = await merge.execute({ primaryId, duplicateId: primaryId === duplicateId ? primaryId : duplicateId, dryRun: true }).catch((e) => e);
    const sobrou = after instanceof Error ? 'duplicado apagado (ok)' : JSON.stringify(after.mover);
    console.log('\n🔎 depois:', sobrou);
    const arch = await mongoose.connection.db.collection('deletedpatientarchives')
      .findOne({ patientId: new mongoose.Types.ObjectId(duplicateId) }, { projection: { reason: 1, counts: 1 } });
    console.log('🗄️ arquivo do duplicado:', arch ? `${arch.reason}` : 'NÃO ENCONTRADO');
  }
} finally {
  await mongoose.disconnect();
}
