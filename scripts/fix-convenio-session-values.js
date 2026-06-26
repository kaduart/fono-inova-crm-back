/**
 * fix-convenio-session-values.js
 *
 * Corrige appointments de convênio com sessionValue=0 / insuranceValue=0.
 * Usa MongoDB nativo para evitar dependência de schemas.
 *
 * Uso (rodar de dentro de back/):
 *   DRY RUN (padrão):  node scripts/fix-convenio-session-values.js
 *   APLICAR:           DRY_RUN=false node scripts/fix-convenio-session-values.js
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();
  console.log(`\n=== fix-convenio-session-values [${DRY_RUN ? 'DRY RUN' : 'APLICANDO'}] ===\n`);

  // Somente appointments de hoje em diante
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1. Appointments convênio com insuranceValue=0 OU sessionValue=0
  const apts = await db.collection('appointments').find({
    billingType: 'convenio',
    date: { $gte: today },
    $or: [
      { sessionValue: { $in: [0, null] } },
      { insuranceValue: { $in: [0, null] } },
    ],
  }, {
    projection: { _id:1, sessionValue:1, insuranceValue:1, insuranceGuide:1, insuranceProvider:1, patient:1, date:1 }
  }).toArray();

  console.log(`(filtro: date >= ${today.toISOString().slice(0,10)})`)

  console.log(`Appointments convênio com valor zerado: ${apts.length}`);
  if (apts.length === 0) {
    console.log('Nada a corrigir.');
    await client.close();
    return;
  }

  // 2. Pré-carrega guides
  const guideIds = [...new Set(apts.map(a => a.insuranceGuide?.toString()).filter(Boolean))].map(id => new ObjectId(id));
  const guides = await db.collection('insuranceguides').find(
    { _id: { $in: guideIds } },
    { projection: { _id:1, sessionValue:1, insurance:1 } }
  ).toArray();
  const guideMap = Object.fromEntries(guides.map(g => [g._id.toString(), g]));

  // 3. Pré-carrega convênios pelo provider code
  const providerCodes = [...new Set(apts.map(a => a.insuranceProvider).filter(Boolean))];
  const convenios = await db.collection('convenios').find(
    { code: { $in: providerCodes } },
    { projection: { code:1, sessionValue:1 } }
  ).toArray();
  const convenioMap = Object.fromEntries(convenios.map(c => [c.code, c]));

  // 4. Monta lista de correções
  const fixes = [];
  for (const apt of apts) {
    const guide = apt.insuranceGuide ? guideMap[apt.insuranceGuide.toString()] : null;
    const convenio = apt.insuranceProvider ? convenioMap[apt.insuranceProvider] : null;
    const guideValue = guide?.sessionValue || convenio?.sessionValue || 0;

    if (guideValue <= 0) {
      console.log(`  ⚠ ${apt._id}: sem valor na guide/convênio — pulando`);
      continue;
    }

    // Guide é fonte de verdade — sobrescreve sempre.
    fixes.push({
      aptId: apt._id,
      oldSV: apt.sessionValue, oldIV: apt.insuranceValue,
      newSV: guideValue, newIV: guideValue,
      source: guide ? `guide:${apt.insuranceGuide}` : `convenio:${apt.insuranceProvider}`
    });
  }

  console.log(`Appointments a corrigir: ${fixes.length}\n`);
  fixes.forEach(f =>
    console.log(`  [${f.aptId}] sv: ${f.oldSV}→${f.newSV}  iv: ${f.oldIV}→${f.newIV}  (${f.source})`)
  );

  if (DRY_RUN) {
    console.log('\nDRY RUN — nenhuma alteração feita. Rode com DRY_RUN=false para aplicar.');
    await client.close();
    return;
  }

  // 5. Aplica correções
  let aptFixed = 0;
  let pmtFixed = 0;
  for (const fix of fixes) {
    await db.collection('appointments').updateOne(
      { _id: fix.aptId },
      { $set: { sessionValue: fix.newSV, insuranceValue: fix.newIV } }
    );
    aptFixed++;

    const pmtResult = await db.collection('payments').updateMany(
      { appointment: fix.aptId, billingType: 'convenio', status: { $ne: 'canceled' }, 'insurance.grossAmount': { $in: [0, null] } },
      { $set: { 'insurance.grossAmount': fix.newIV } }
    );
    pmtFixed += pmtResult.modifiedCount;
  }

  console.log(`\n=== Concluído ===`);
  console.log(`Appointments corrigidos: ${aptFixed}`);
  console.log(`Payments corrigidos (grossAmount): ${pmtFixed}`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
