/**
 * audit-convenio-values.mjs
 * Rodar de dentro de back/:  node scripts/audit-convenio-values.mjs
 */

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

// 1. Todos os appointments de convênio
const apts = await db.collection('appointments').find(
  { billingType: 'convenio' },
  { projection: { _id:1, patient:1, sessionValue:1, insuranceValue:1, insuranceGuide:1, insurancePlan:1, insuranceProvider:1, operationalStatus:1 } }
).toArray();

console.log(`\nTotal appointments convênio: ${apts.length}`);

// 2. Agrupa por paciente
const byPatient = {};
for (const a of apts) {
  const pid = a.patient?.toString();
  if (!pid) continue;
  if (!byPatient[pid]) byPatient[pid] = { total: 0, zeroed: 0, withGuide: 0, withoutGuide: 0, providers: new Set() };
  const p = byPatient[pid];
  p.total++;
  if (!a.sessionValue || a.sessionValue === 0 || !a.insuranceValue || a.insuranceValue === 0) p.zeroed++;
  if (a.insuranceGuide) p.withGuide++; else p.withoutGuide++;
  if (a.insuranceProvider) p.providers.add(a.insuranceProvider);
}

// 3. Busca nomes
const patientObjIds = Object.keys(byPatient).map(id => { try { return new ObjectId(id); } catch { return null; } }).filter(Boolean);
const patients = await db.collection('patients').find(
  { _id: { $in: patientObjIds } },
  { projection: { fullName:1 } }
).toArray();
const nameMap = Object.fromEntries(patients.map(p => [p._id.toString(), p.fullName]));

// 4. Relatório
const problemas = [];
const ok = [];

for (const [pid, data] of Object.entries(byPatient)) {
  const entry = {
    name: nameMap[pid] || `[ID: ${pid}]`,
    pid,
    total: data.total,
    zeroed: data.zeroed,
    withGuide: data.withGuide,
    withoutGuide: data.withoutGuide,
    providers: [...data.providers].join(', ')
  };
  if (data.zeroed > 0 || data.withoutGuide > 0) problemas.push(entry);
  else ok.push(entry);
}

console.log('\n--- COM PROBLEMA (insuranceValue=0 ou sem guia) ---');
for (const e of problemas) {
  console.log(`  ${e.name}`);
  console.log(`    apts:${e.total} | zerados:${e.zeroed} | com-guia:${e.withGuide} | sem-guia:${e.withoutGuide} | ${e.providers}`);
}

console.log(`\n--- OK (${ok.length} pacientes) ---`);
for (const e of ok) {
  console.log(`  ${e.name} | apts:${e.total} | ${e.providers}`);
}

const totalZerados = apts.filter(a => !a.sessionValue || a.sessionValue === 0 || !a.insuranceValue || a.insuranceValue === 0).length;
console.log(`\nResumo: ${problemas.length} com problema | ${ok.length} ok | ${totalZerados} appointments zerados`);

await client.close();
