/**
 * Collection antiga `preagendamentos` (model PreAgendamento, já removido do código).
 * Hoje /api/v2/pre-appointments lê os próprios Appointments (operationalStatus
 * 'pre_agendado'). Decisão do Kadu (31/10/2026): a collection antiga não é usada
 * e deve ser apagada.
 *
 * Uso (PowerShell, um comando por vez, na pasta back):
 *   node scripts/_legacy-preagendamentos-drop.js                 → só LÊ (padrão)
 *   node scripts/_legacy-preagendamentos-drop.js --drop --confirm=preagendamentos
 *        → grava backup JSON em backups-mongo/ (fora do git) e só então apaga a collection
 *
 * Regras:
 * - Sem --drop, NÃO escreve nada.
 * - Recusa URI do Atlas (mongodb+srv / mongodb.net) sem --prod-ok. Ensaiar no
 *   espelho (127.0.0.1:27018) antes; em produção só com o "pode aplicar" do Kadu
 *   e a URI de escrita passada só neste comando.
 * - Notifications com refModel 'PreAgendamento' ficam sem referência (populate
 *   devolve null); o script só conta, não mexe nelas.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const DROP = has('--drop');
const CONFIRMED = args.includes('--confirm=preagendamentos');
const PROD_OK = has('--prod-ok');
const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const NAME = 'preagendamentos';

if (!URI) { console.error('MONGO_URI/MONGODB_URI não definido'); process.exit(1); }
const isAtlas = /mongodb\+srv:|mongodb\.net/i.test(URI);
if (isAtlas && !PROD_OK) {
  console.error('URI do Atlas detectada. Rode primeiro no espelho; para produção, passe --prod-ok com autorização explícita.');
  process.exit(1);
}

await mongoose.connect(URI);
const db = mongoose.connection.db;
console.log(`Banco: ${db.databaseName}${isAtlas ? ' (ATLAS)' : ''}`);

const exists = (await db.listCollections({ name: NAME }).toArray()).length > 0;
if (!exists) {
  console.log(`Collection "${NAME}" não existe. Nada a fazer.`);
  await mongoose.disconnect();
  process.exit(0);
}

const col = db.collection(NAME);
const total = await col.countDocuments();
const [last] = await col.find({}, { projection: { createdAt: 1, updatedAt: 1, status: 1 } }).sort({ _id: -1 }).limit(1).toArray();
const byStatus = await col.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
const notifRefs = await db.collection('notifications').countDocuments({ refModel: 'PreAgendamento' }).catch(() => 0);

console.log(`Documentos: ${total}`);
console.log('Por status:', Object.fromEntries(byStatus.map(s => [s._id ?? 'sem status', s.n])));
console.log('Mais recente:', last ? (last.updatedAt || last.createdAt || last._id.getTimestamp()) : '—');
console.log(`Notifications apontando para PreAgendamento: ${notifRefs}`);

if (!DROP) {
  console.log('\nSó leitura. Para apagar: --drop --confirm=preagendamentos');
  await mongoose.disconnect();
  process.exit(0);
}
if (!CONFIRMED) {
  console.error('Falta --confirm=preagendamentos. Nada foi apagado.');
  await mongoose.disconnect();
  process.exit(1);
}

const dir = path.resolve('backups-mongo');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${db.databaseName}-${NAME}-${new Date().toISOString().replace(/[:.]/g, '-')}.ejson.json`);
const docs = await col.find({}).toArray();
const { EJSON } = mongoose.mongo.BSON; // preserva ObjectId/Date para restaurar
fs.writeFileSync(file, EJSON.stringify(docs));
const check = EJSON.parse(fs.readFileSync(file, 'utf8'));
if (check.length !== total) {
  console.error(`Backup incompleto (${check.length}/${total}). Nada foi apagado.`);
  await mongoose.disconnect();
  process.exit(1);
}
console.log(`Backup: ${file} (${check.length} docs)`);

await col.drop();
const still = (await db.listCollections({ name: NAME }).toArray()).length > 0;
console.log(still ? 'ERRO: collection ainda existe.' : `Collection "${NAME}" apagada.`);
await mongoose.disconnect();
