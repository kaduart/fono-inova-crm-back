// scripts/isolado/crmWorkerSim.mjs
// Simula um worker do CRM que toma posse de eventos (código real:
// infrastructure/events/eventOwnership.js claimEvent/renewLease/completeOwned)
// e morre no meio (kill -9), deixando posses abandonadas para o reaper.
//   node crmWorkerSim.mjs claim <prefixo> <n> <leaseMs>   toma posse e fica renovando até morrer
//   node crmWorkerSim.mjs late-complete <prefixo> <n>      tenta concluir com tokens antigos (deve falhar)
import fs from 'node:fs';
import mongoose from 'mongoose';
import { requireIsolatedMongo } from './_guard.mjs';

const { uri } = requireIsolatedMongo();
const [cmd, prefix, nRaw, leaseRaw] = process.argv.slice(2);
const n = Number(nRaw || 0);
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
const own = await import('../../infrastructure/events/eventOwnership.js');
const tokensFile = process.env.WORKER_SIM_TOKENS || '/tmp/crm-worker-sim-tokens.json';

if (cmd === 'claim') {
  const leaseMs = Number(leaseRaw || 5000);
  const tokens = {};
  let claimed = 0;
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${i}`;
    const r = await own.claimEvent(id, `worker-sim:${process.pid}`, { leaseMs, alert: () => {} });
    if (r.status === 'claimed') { tokens[id] = r.token; claimed++; }
  }
  fs.writeFileSync(tokensFile, JSON.stringify(tokens));
  console.log(JSON.stringify({ msg: 'worker_sim_claimed', claimed, leaseMs }));
  // Renova enquanto vive; kill -9 interrompe sem concluir nem devolver.
  setInterval(async () => {
    for (const [id, tok] of Object.entries(tokens)) await own.renewLease(id, tok, { leaseMs }).catch(() => {});
  }, Math.max(500, Math.floor(leaseMs / 3)));
} else if (cmd === 'late-complete') {
  const tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
  let ok = 0, refused = 0;
  for (const [id, tok] of Object.entries(tokens)) {
    const r = await own.completeOwned(id, tok, 'worker-sim-late');
    if (r === true || r?.ok) ok++; else refused++;
  }
  console.log(JSON.stringify({ msg: 'worker_sim_late_complete', ok, refused }));
  await mongoose.disconnect();
  process.exit(0); // módulos do CRM deixam timers/conexões abertos
} else {
  console.error('uso: claim <prefixo> <n> <leaseMs> | late-complete');
  process.exit(2);
}
