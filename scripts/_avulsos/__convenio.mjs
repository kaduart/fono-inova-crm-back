import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config({ path: 'C:/Users/User/Documents/projetos/crm/back/.env' });
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
await mongoose.connect(uri);
const client = mongoose.connection.getClient();
const info = await client.db().admin().command({ listDatabases: 1, nameOnly: true });
const bancos = info.databases.map(d => d.name).filter(n => !['admin','local','config'].includes(n));

const meses = ['2026-06','2026-07','2026-08','2026-09','2026-10'];
const alvos = ['insuranceguides','insurancebatches','insurance_batches_view','insurance_guides_view',
               'convenios','insuranceplans','insurancecommunications','convenio_waitlist',
               'payments','sessions','appointments','medicalevents','financial_ledger','financialevents','invoices'];

console.log('=== CONVENIO / FINANCEIRO POR MES (jun-out) EM TODOS OS BANCOS ===\n');
for (const nome of bancos) {
  const db = client.db(nome);
  const linhas = [];
  for (const c of alvos) {
    try {
      const col = db.collection(c);
      const tot = await col.estimatedDocumentCount();
      if (tot === 0) continue;
      const porMes = [];
      for (const m of meses) {
        const ini = new Date(m + '-01T00:00:00Z');
        const fim = new Date(new Date(ini).setUTCMonth(ini.getUTCMonth() + 1));
        const oi = mongoose.Types.ObjectId.createFromTime(Math.floor(ini.getTime()/1000));
        const of = mongoose.Types.ObjectId.createFromTime(Math.floor(fim.getTime()/1000));
        const n = await col.countDocuments({ _id: { $gte: oi, $lt: of } });
        porMes.push(m.slice(5) + ':' + String(n).padStart(5));
      }
      linhas.push('    ' + c.padEnd(28) + 'tot=' + String(tot).padStart(6) + ' | ' + porMes.join('  '));
    } catch(e) {}
  }
  if (linhas.length) { console.log('[' + nome + ']'); console.log(linhas.join('\n')); console.log(''); }
}
await mongoose.disconnect();
process.exit(0);
