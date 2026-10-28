import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config({ path: 'C:/Users/User/Documents/projetos/crm/back/.env' });
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
await mongoose.connect(uri);
const client = mongoose.connection.getClient();

const bancos = ['fono_inova_dedup_staging','test','crm_development','crm_test_e2e'];
const meses = ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10'];
const cols = ['appointments','sessions','payments','medicalevents','patients','leads','messages','rawwebhooklogs','eventstore'];

for (const nome of bancos) {
  const db = client.db(nome);
  console.log('\n############ ' + nome + ' ############');
  for (const c of cols) {
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
      console.log('  ' + c.padEnd(16), 'tot=' + String(tot).padStart(6), '|', porMes.join('  '));
    } catch(e) {}
  }
}
await mongoose.disconnect();
process.exit(0);
