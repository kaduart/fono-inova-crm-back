#!/usr/bin/env node
/**
 * 🪞 Copia a PRODUÇÃO inteira para o espelho local (fono_espelho @ 127.0.0.1:27018).
 *
 * - Lê produção com o usuário SOMENTE LEITURA (PROD_URI_READONLY) — não há como alterar produção.
 * - O espelho é recriado do zero a cada execução (é descartável e só existe na sua máquina).
 * - Desliga, NA CÓPIA, tudo que dispararia ação real: outbox, lembretes, follow-ups
 *   agendados, recuperação da Amanda e sessão do WhatsApp.
 *
 *   npm run espelho:copiar                 → cópia crua
 *   npm run espelho:copiar -- --anonimizar → troca nome/telefone/CPF/e-mail/endereço de pacientes e leads
 */
import { createRequire } from 'module';
import { MongoClient } from 'mongodb';
import { URI, DB_NAME, BACK_DIR, isLocalUri } from './config.mjs';
import { anonimizar } from './anonimizar.mjs';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: `${BACK_DIR}/.env` });

const TAG = '[espelho:copiar]';
const PROD = process.env.PROD_URI_READONLY;
if (!PROD) { console.error(`${TAG} ❌ PROD_URI_READONLY não definido no back/.env`); process.exit(1); }
if (!isLocalUri(URI)) { console.error(`${TAG} ❌ destino não é local — abortando`); process.exit(1); }

const SKIP = new Set(['outboxes', 'whatsappwebstates', 'baileyssessions']);
const BATCH = 1000;
const ANON = process.argv.includes('--anonimizar') || process.env.ESPELHO_ANONIMIZAR === '1';

const src = new MongoClient(PROD, { maxPoolSize: 4 });
const dst = new MongoClient(URI, { serverSelectionTimeoutMS: 10_000 });
const t0 = Date.now();
try {
  await dst.connect().catch(() => { throw new Error('MongoDB do espelho não está rodando — abra outra janela e rode: npm run espelho:mongo'); });
  await src.connect();
  const S = src.db(), T = dst.db(DB_NAME);
  console.log(`${TAG} produção (${S.databaseName}, somente leitura) → espelho local (${DB_NAME})${ANON ? ' — ANONIMIZADO' : ''}`);
  await T.dropDatabase();

  let total = 0;
  for (const { name } of await S.listCollections({ type: 'collection' }).toArray()) {
    if (name.startsWith('system.') || SKIP.has(name)) continue;
    const cursor = S.collection(name).find({});
    let buf = [], n = 0;
    for await (const doc of cursor) {
      buf.push(ANON ? anonimizar(name, doc) : doc);
      if (buf.length === BATCH) { await T.collection(name).insertMany(buf, { ordered: false }); n += buf.length; buf = []; }
    }
    if (buf.length) { await T.collection(name).insertMany(buf, { ordered: false }); n += buf.length; }
    if (!n) await T.createCollection(name).catch(() => {});
    const idx = (await S.collection(name).listIndexes().toArray()).filter((x) => x.name !== '_id_').map(({ v, ns, ...rest }) => rest);
    if (idx.length) await T.collection(name).createIndexes(idx).catch(() => {});
    total += n;
  }

  // Neutraliza disparos reais na cópia
  const neutral = {
    reminders: (await T.collection('reminders').updateMany({ status: 'pending' }, { $set: { status: 'canceled', espelho: true } })).modifiedCount,
    followups: (await T.collection('followups').updateMany({ status: 'scheduled' }, { $set: { status: 'canceled', espelho: true } })).modifiedCount,
    leadsRecovery: (await T.collection('leads').updateMany({ 'recovery.nextAttemptAt': { $ne: null } }, { $set: { 'recovery.nextAttemptAt': null } })).modifiedCount,
  };
  const c = async (k) => T.collection(k).countDocuments();
  console.log(`${TAG} ✅ ${total} documentos copiados em ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`${TAG} pacientes ${await c('patients')} | agendamentos ${await c('appointments')} | sessões ${await c('sessions')} | pagamentos ${await c('payments')} | pacotes ${await c('packages')}`);
  console.log(`${TAG} disparos neutralizados na cópia:`, neutral);
  console.log(`${TAG} Agora rode: npm run dev:espelho`);
} catch (err) {
  console.error(`${TAG} ❌ ${err.message}`);
  process.exitCode = 1;
} finally {
  await src.close(); await dst.close();
}
