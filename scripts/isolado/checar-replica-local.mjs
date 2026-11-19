// Conferência SOMENTE LEITURA dos PRs #89/#63/#14 contra a réplica local de dev
// (espelho: fono_espelho @ 127.0.0.1:27018, ver scripts/espelho/config.mjs).
//
// Garantias:
//   - Recusa qualquer host que não seja loopback e qualquer banco com "prod" no nome.
//   - Só usa operações de leitura: listCollections, countDocuments, aggregate sem $out/$merge,
//     findOne, listIndexes, hello. Nenhum insert/update/delete/createIndex.
//   - Imprime só contagens e nomes de campo. Nenhum documento, nome, telefone ou id de paciente.
//
//   node scripts/isolado/checar-replica-local.mjs
//   REPLICA_URI='mongodb://127.0.0.1:27018/fono_espelho?replicaSet=rsespelho&directConnection=true' \
//     node scripts/isolado/checar-replica-local.mjs
import { MongoClient } from 'mongodb';

const DEFAULT_URI = `mongodb://127.0.0.1:${process.env.ESPELHO_PORT || 27018}/fono_espelho?replicaSet=rsespelho&directConnection=true`;
const URI = process.env.REPLICA_URI || DEFAULT_URI;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const u = new URL(URI.replace(/^mongodb:\/\//, 'http://'));
if (!/^mongodb:\/\//.test(URI) || !LOOPBACK.has(u.hostname)) {
  console.error('RECUSADO: a réplica precisa ser mongodb:// em loopback (127.0.0.1/localhost).');
  process.exit(2);
}
const DB = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'fono_espelho';
if (/prod/i.test(DB)) { console.error(`RECUSADO: banco "${DB}" parece produção.`); process.exit(2); }

// Mesmo critério do crons/eventReaper.cron.js (sem a cerca legada, que é decisão de ativação).
const NEW_KINDS = ['multi_payment', 'standalone', 'balance_credit', 'financial_receive', 'create_sync', 'balance_credit_direct'];
const FORBIDDEN_STAGES = ['$out', '$merge'];

const out = [];
let warn = 0;
const line = (item, label, value, ok = true) => { if (!ok) warn++; out.push(`${ok ? 'OK  ' : 'ATENÇÃO'} [${item}] ${label}: ${value}`); };

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000, readPreference: 'primaryPreferred', appName: 'checar-replica-somente-leitura' });
await client.connect();
const db = client.db(DB);
const has = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
const count = (c, q = {}) => (has.has(c) ? db.collection(c).countDocuments(q) : Promise.resolve(0));
const agg = (c, p) => {
  if (p.some((s) => FORBIDDEN_STAGES.some((k) => k in s))) throw new Error('estágio de escrita proibido');
  return has.has(c) ? db.collection(c).aggregate(p, { allowDiskUse: false }).toArray() : Promise.resolve([]);
};
const byStatus = async (c, field = 'status') =>
  (await agg(c, [{ $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }]))
    .map((r) => `${r._id ?? '(vazio)'}=${r.n}`).join(', ') || '(coleção vazia ou ausente)';

try {
  // ── Ambiente ──
  const hello = await db.admin().command({ hello: 1 });
  const build = await db.admin().command({ buildInfo: 1 });
  line('amb', 'banco', `${DB} @ ${u.hostname}:${u.port || 27017}, mongod ${build.version}`);
  line('amb', 'replica set (transações, exigido pela cerca do reaper)', hello.setName || 'NÃO', !!hello.setName);
  line('amb', 'coleções', has.size, has.size > 0);
  const ctl = has.has('_espelho_controle') ? await db.collection('_espelho_controle').findOne({ _id: 'controle' }, { projection: { ultimaOk: 1, estado: 1 } }) : null;
  if (ctl) line('amb', 'última cópia do espelho', `${ctl.ultimaOk ? new Date(ctl.ultimaOk).toISOString() : '?'} estado=${ctl.estado ?? '?'}`);

  // ── Item 9: reaper / posse compartilhada ──
  const now = new Date();
  line('9', 'eventstore por status', await byStatus('eventstore'));
  const stuck = await count('eventstore', { status: 'processing', leaseExpiresAt: { $lte: now } });
  line('9', 'presos com posse vencida (o reaper recuperaria no 1º ciclo)', stuck);
  const legacy = await count('eventstore', { status: 'processing', processingToken: null, leaseExpiresAt: null });
  line('9', 'processing sem posse (aguardam EVENT_LEGACY_FENCE_AT, não são tocados)', legacy);
  const nearLimit = await count('eventstore', { recoveryCount: { $gte: 2 } });
  line('9', 'eventos já recuperados 2+ vezes (perto de dead_letter)', nearLimit);
  const lease = has.has('kas_event_reaper_lease') ? await db.collection('kas_event_reaper_lease').findOne({ _id: 'crm-eventstore-reaper' }, { projection: { holder: 1, expiresAt: 1 } }) : null;
  line('9', 'documento de posse kas_event_reaper_lease', lease ? `holder=${lease.holder ?? 'nenhum'} ${lease.expiresAt > now ? 'VIVA' : 'vencida'}` : 'não existe (nasce no 1º ciclo; com a flag off o Node só lê)');

  // ── Item 2: rotas financeiras / idempotência ──
  line('2', 'payment_operations por kind', await byStatus('payment_operations', 'kind'));
  const kinds = (await agg('payment_operations', [{ $group: { _id: '$kind' } }])).map((r) => r._id);
  const unknownKinds = kinds.filter((k) => !NEW_KINDS.includes(k));
  line('2', 'kinds fora do enum novo', unknownKinds.length ? unknownKinds.join(', ') : 'nenhum', unknownKinds.length === 0);
  const pendingSide = await count('payment_operations', { appliedAt: { $ne: null }, sideEffectsAt: null });
  line('2', 'operações aplicadas com efeitos colaterais pendentes', pendingSide, pendingSide === 0);
  const piIdx = has.has('payment_operations') ? (await db.collection('payment_operations').listIndexes().toArray()).map((i) => i.name) : [];
  line('2', 'índices de payment_operations', piIdx.join(', ') || '(sem coleção)');

  // ── Item 4: anti-reenvio ──
  line('4', 'outbound_deliveries por status', await byStatus('outbound_deliveries'));
  const unknown = await count('outbound_deliveries', { status: 'unknown' });
  line('4', 'envios em "unknown" (sem tela para resolver ainda)', unknown, unknown === 0);
  const dupJobs = await agg('communicationemaillogs', [
    { $match: { jobId: { $type: 'string' } } },
    { $group: { _id: '$jobId', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: 'jobs' }
  ]);
  line('4', 'jobIds de e-mail de convênio com mais de 1 registro (histórico, antes do PR)', dupJobs[0]?.jobs ?? 0);
  const noJob = await count('communicationemaillogs', { $or: [{ jobId: { $exists: false } }, { jobId: null }] });
  line('4', 'registros de e-mail sem jobId (envio antigo, não protegido pela chave nova)', noJob);
  const stalePending = await count('communicationemaillogs', { status: { $in: ['pending', 'PENDING'] }, createdAt: { $lt: new Date(Date.now() - 3600e3) } });
  line('4', 'registros de e-mail pendentes há mais de 1 h', stalePending, stalePending === 0);

  // ── Outbox (fix nextFreeOutboxEventId) ──
  line('2', 'outboxes por status', await byStatus('outboxes'));
  const retried = await count('outboxes', { eventId: { $regex: '_r\\d+$' } });
  line('2', 'outbox com eventId de reenvio (_rN)', retried);
} finally {
  await client.close();
}

console.log(out.join('\n'));
console.log(`\n${warn ? `${warn} ponto(s) de ATENÇÃO (leitura, nada foi alterado)` : 'TUDO OK (leitura, nada foi alterado)'}`);
