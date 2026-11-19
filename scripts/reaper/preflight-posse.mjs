// Conferência SOMENTE LEITURA antes de ligar o executor da KAS (kas-event-reaper)
// ao lado do reaper do Node. Diz se a configuração é compatível, ou seja, se
// não pode haver dois responsáveis ao mesmo tempo.
//
// Lê só o documento da posse (aggregate com $$NOW). Não escreve nada, não lê
// eventos nem dados de paciente. Use um usuário Mongo com role `read`.
//
//   PREFLIGHT_MONGO_URI=... node scripts/reaper/preflight-posse.mjs \
//       [--db <banco>] [--kas-lease-collection kas_event_reaper_lease] [--max-age-min 15]
//
// Saída 0 = COMPATÍVEL, 1 = INCOMPATÍVEL, 2 = erro de uso/conexão.
// Procedimento completo: docs/EVENTSTORE_OWNERSHIP.md, seção 11.
import { MongoClient } from 'mongodb';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const URI = process.env.PREFLIGHT_MONGO_URI;
if (!URI) { console.error('defina PREFLIGHT_MONGO_URI (usuário só leitura)'); process.exit(2); }
const DEFAULT_COLLECTION = 'kas_event_reaper_lease';
const KAS_COLLECTION = arg('kas-lease-collection', DEFAULT_COLLECTION);
const MAX_AGE_MS = Number(arg('max-age-min', '15')) * 60_000;
const problems = [];
const info = [];

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 10_000, appName: 'reaper-preflight-somente-leitura' });
try {
  await client.connect();
  const db = client.db(arg('db', undefined));
  info.push(`banco: ${db.databaseName}`);

  if (KAS_COLLECTION !== DEFAULT_COLLECTION) {
    problems.push(`KAS configurada com -lease-collection ${KAS_COLLECTION}, mas o Node usa ${DEFAULT_COLLECTION}: cada um teria a sua posse (dois donos). Use o padrão.`);
  }

  const [doc] = await db.collection(DEFAULT_COLLECTION).aggregate([
    { $match: { _id: 'crm-eventstore-reaper' } },
    { $project: {
      holder: 1,
      live: { $gt: ['$expiresAt', '$$NOW'] },
      msLeft: { $subtract: ['$expiresAt', '$$NOW'] },
      nodeAt: '$participants.crmNode.at',
      nodeAgeMs: { $subtract: ['$$NOW', '$participants.crmNode.at'] },
      nodeHolder: '$participants.crmNode.holder',
      nodeMode: '$participants.crmNode.mode'
    } }
  ]).toArray();

  if (!doc) {
    problems.push('documento da posse não existe: nenhum reaper do Node rodou com EVENT_REAPER_SHARED_LEASE=on neste banco.');
  } else {
    info.push(`posse: ${doc.live ? `VIVA com ${doc.holder} (${Math.round(doc.msLeft / 1000)} s restantes)` : 'livre'}`);
    if (!doc.nodeAt) {
      problems.push('sem marca participants.crmNode: o reaper do Node não está em "on" (ou aponta para outro banco).');
    } else {
      const ageS = Math.round(doc.nodeAgeMs / 1000);
      info.push(`marca do Node: ${doc.nodeHolder ?? '?'} há ${ageS} s, modo ${doc.nodeMode ?? '?'} (${doc.nodeMode === 'yield' ? 'Node cede à KAS: EVENT_REAPER_OWNER=kas' : 'Node disputa a posse: EVENT_REAPER_OWNER=node'})`);
      if (doc.nodeAgeMs > MAX_AGE_MS) problems.push(`marca do Node com ${ageS} s (máximo ${MAX_AGE_MS / 1000} s): o Node parou de renovar (flag desligada, processo parado ou revertido).`);
    }
    if (doc.live && doc.holder && !String(doc.holder).startsWith('crm-node:') && (!doc.nodeAt || doc.nodeAgeMs > MAX_AGE_MS)) {
      problems.push(`posse viva com ${doc.holder} sem Node participando: hoje já existe um executor fora do Node com o Node fora da posse.`);
    }
  }
} catch (e) {
  console.error(`erro: ${e.message}`);
  process.exit(2);
} finally {
  await client.close().catch(() => {});
}

for (const l of info) console.log(`info  ${l}`);
for (const p of problems) console.log(`ERRO  ${p}`);
console.log('\nConfira também nos logs de CADA processo que sobe o reaper do Node (API e cron-worker):');
console.log('  "[EventReaper] posse compartilhada: on"  (qualquer "off" ou "(ausente)" = incompatível)');
console.log('E suba a KAS com: -mode executor (a guarda -require-crm-node-lease já vem ligada; nunca passe =false fora de banco de teste local) e sem -lease-collection diferente.');
console.log(problems.length ? '\nINCOMPATÍVEL: não ligue a KAS.' : '\nCOMPATÍVEL: pode seguir para o próximo passo do procedimento.');
process.exit(problems.length ? 1 : 0);
