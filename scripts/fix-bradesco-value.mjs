/**
 * fix-bradesco-value.mjs
 * - Adiciona/atualiza bradesco-saude no Convenio com sessionValue 150
 * - Atualiza guides cujo sessionValue=0 vinculados a esses appointments
 * - Corrige direto os 6 appointments do dry run
 *
 * Rodar de dentro de back/:  DRY_RUN=false node scripts/fix-bradesco-value.mjs
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SESSION_VALUE = 150;

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

console.log(`\n=== fix-bradesco-value [${DRY_RUN ? 'DRY RUN' : 'APLICANDO'}] ===\n`);

// 1. Busca todos appointments convênio com provider bradesco e valor zerado (hoje em diante)
const today = new Date(); today.setHours(0,0,0,0);
const apts = await db.collection('appointments').find({
  billingType: 'convenio',
  insuranceProvider: 'bradesco-saude',
  date: { $gte: today },
  $or: [
    { sessionValue: { $in: [0, null] } },
    { insuranceValue: { $in: [0, null] } },
  ],
}, { projection: { _id:1, sessionValue:1, insuranceValue:1, insuranceGuide:1, date:1 } }).toArray();

console.log(`Appointments bradesco zerados (hoje em diante): ${apts.length}`);
apts.forEach(a => console.log(`  [${a._id}] ${a.date?.toISOString().slice(0,10)} sv:${a.sessionValue} iv:${a.insuranceValue} guide:${a.insuranceGuide}`));

// 2. Guides com sessionValue=0 vinculadas a esses appointments
const guideIds = [...new Set(apts.map(a => a.insuranceGuide?.toString()).filter(Boolean))].map(id => new ObjectId(id));
const guides = await db.collection('insuranceguides').find(
  { _id: { $in: guideIds }, $or: [{ sessionValue: { $in: [0, null] } }] },
  { projection: { _id:1, sessionValue:1, insurance:1 } }
).toArray();
console.log(`\nGuides com sessionValue zerado: ${guides.length}`);
guides.forEach(g => console.log(`  [${g._id}] insurance:${g.insurance} sv:${g.sessionValue}`));

if (!DRY_RUN) {
  // 3. Upsert bradesco-saude no convenio
  const brResult = await db.collection('convenios').updateOne(
    { code: 'bradesco-saude' },
    {
      $set: { sessionValue: SESSION_VALUE, name: 'Bradesco Saúde', active: true, updatedAt: new Date() },
      $setOnInsert: { code: 'bradesco-saude', billingMode: 'per_month', notes: '', createdAt: new Date() }
    },
    { upsert: true }
  );
  console.log(`\nBradesco-saude convenio: matched=${brResult.matchedCount} modified=${brResult.modifiedCount} upserted=${brResult.upsertedCount}`);

  // 4. Atualiza guides com sessionValue=0
  if (guides.length > 0) {
    const gResult = await db.collection('insuranceguides').updateMany(
      { _id: { $in: guideIds }, $or: [{ sessionValue: { $in: [0, null] } }] },
      { $set: { sessionValue: SESSION_VALUE } }
    );
    console.log(`Guides atualizadas: ${gResult.modifiedCount}`);
  }

  // 5. Corrige os appointments
  const aptIds = apts.map(a => a._id);
  const aptResult = await db.collection('appointments').updateMany(
    { _id: { $in: aptIds } },
    { $set: { sessionValue: SESSION_VALUE, insuranceValue: SESSION_VALUE } }
  );
  console.log(`Appointments corrigidos: ${aptResult.modifiedCount}`);

  // 6. Corrige payments
  const pmtResult = await db.collection('payments').updateMany(
    { appointment: { $in: aptIds }, billingType: 'convenio', status: { $ne: 'canceled' }, 'insurance.grossAmount': { $in: [0, null] } },
    { $set: { 'insurance.grossAmount': SESSION_VALUE } }
  );
  console.log(`Payments corrigidos (grossAmount): ${pmtResult.modifiedCount}`);
} else {
  console.log('\nDRY RUN — nenhuma alteração. Rode com DRY_RUN=false para aplicar.');
}

await client.close();
