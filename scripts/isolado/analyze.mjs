// scripts/isolado/analyze.mjs
// Lê o JSONL do observer.mjs e verifica, para as recuperações do reaper:
//  - toda escrita de recuperação foi cercada (mesma transação que a
//    confirmação da posse no documento kas_event_reaper_lease);
//  - a quem pertencia a posse (holder do último token) no momento da escrita;
//  - nenhum evento recuperado duas vezes na mesma ocorrência.
// Uso: node analyze.mjs observer.jsonl [desde_t]
import fs from 'node:fs';
const [file, since] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const cmpT = (a, b) => { const [ah, al] = a.split('.').map(Number); const [bh, bl] = b.split('.').map(Number); return ah - bh || al - bl; };
const recs = lines.sort((a, b) => cmpT(a.t, b.t));
const after = (r) => !since || cmpT(r.t, since) > 0;

const txnLease = new Map(); // txn -> holder at fence time
let holder = null;
const holders = [];
for (const r of recs) {
  if (r.coll !== 'kas_event_reaper_lease') continue;
  if (r.token && (holders.length === 0 || holders[holders.length - 1].token !== r.token)) {
    // token novo = tomada de posse (holder vem junto se mudou)
    if (r.holder) holder = r.holder;
    holders.push({ t: r.t, holder, token: r.token });
  }
  if (r.txn && r.set?.includes('fencedWriteAt')) txnLease.set(r.txn, holder);
}

const isRecovery = (r) => r.coll === 'eventstore' && r.op === 'update' && r.set?.includes('recoveryCount') && ['pending', 'failed', 'dead_letter'].includes(r.status);
const recoveries = recs.filter((r) => isRecovery(r) && after(r));
const byHolder = {};
let unfenced = 0;
const perEventCount = new Map();
for (const r of recoveries) {
  const fencedTxn = r.txn && txnLease.has(r.txn);
  const h = fencedTxn ? (txnLease.get(r.txn) || '(dono não identificado)') : undefined;
  if (!fencedTxn) unfenced++;
  const key = h || '(sem cerca)';
  byHolder[key] = (byHolder[key] || 0) + 1;
  const k = `${r.eventId}#${r.recoveryCount}`;
  perEventCount.set(k, (perEventCount.get(k) || 0) + 1);
}
const dupSameOccurrence = [...perEventCount.values()].filter((n) => n > 1).length;
const result = {
  recoveries: recoveries.length,
  fenced: recoveries.length - unfenced,
  unfenced,
  byHolder,
  dupSameOccurrence,
  leaseHandovers: holders.filter(after).map((h) => `${h.holder ?? '-'}@${h.token ?? '-'}`)
};
console.log(JSON.stringify(result));
