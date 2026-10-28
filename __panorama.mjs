import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config({ path: 'C:/Users/User/Documents/projetos/crm/back/.env' });
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(uri);
const client = mongoose.connection.getClient();

const cols = [
  'admins','users','doctors','patients','appointments','sessions','payments',
  'leads','medicalevents','messages','followups','evolutions','insuranceguides',
  'insurancebatches','insuranceplans','therapypackages','packages','convenios',
  'invoices','expenses','eventstore','rawwebhooklogs','chatcontexts','gmbposts',
  'whatsappwebstates','financial_ledger','financialevents','metriclogs'
];

const prod = client.db('fono_inova_prod');
const stag = client.db('fono_inova_dedup_staging');

console.log('COLEÇÃO'.padEnd(22), 'prod_hoje'.padStart(10), 'staging'.padStart(10));
console.log('-'.repeat(45));
for (const c of cols) {
  let a = '-', b = '-';
  try { a = await prod.collection(c).estimatedDocumentCount(); } catch(e) {}
  try { b = await stag.collection(c).estimatedDocumentCount(); } catch(e) {}
  console.log(c.padEnd(22), String(a).padStart(10), String(b).padStart(10));
}
await mongoose.disconnect();
process.exit(0);
