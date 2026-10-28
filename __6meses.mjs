import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config({ path: 'C:/Users/User/Documents/projetos/crm/back/.env' });
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
await mongoose.connect(uri);
const client = mongoose.connection.getClient();

const info = await client.db().admin().command({ listDatabases: 1, nameOnly: true });
const bancos = info.databases.map(d => d.name).filter(n => !['admin','local','config'].includes(n));

// Ultimos 6 meses: abril a outubro/2026
const CORTE = new Date('2026-04-01T00:00:00Z');
const oidCorte = mongoose.Types.ObjectId.createFromTime(Math.floor(CORTE.getTime()/1000));

const principais = ['admins','users','doctors','patients','appointments','sessions','payments',
                    'leads','medicalevents','messages','followups','evolutions','insuranceguides',
                    'therapypackages','packages','convenios','invoices','expenses','eventstore',
                    'rawwebhooklogs','chatcontexts','gmbposts','whatsappwebstates'];

console.log('=== DOCUMENTOS DOS ULTIMOS 6 MESES (desde 01/04/2026) POR BANCO ===\n');
for (const nome of bancos) {
  const db = client.db(nome);
  const linhas = [];
  for (const c of principais) {
    try {
      const col = db.collection(c);
      const n = await col.countDocuments({ _id: { $gte: oidCorte } });
      const tot = await col.estimatedDocumentCount();
      if (tot > 0) linhas.push('    ' + c.padEnd(18) + ' recentes=' + String(n).padStart(6) + ' / total=' + tot);
    } catch(e) {}
  }
  if (linhas.length) {
    console.log('[' + nome + ']');
    console.log(linhas.join('\n'));
    console.log('');
  }
}
await mongoose.disconnect();
process.exit(0);
