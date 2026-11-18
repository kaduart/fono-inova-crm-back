// Quantos dispatchers do Outbox cada forma de subir o processo inicia, lido do
// código. Sem banco, sem rede. Se este teste quebrar, atualize docs/DISPATCHERS.md.
//
//   node --test tests/outbox/dispatcherCount.nodetest.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const registry = read('workers/registry.js');

// Corpo de cada grupo em GROUPS: "nome: async (workers) => { ... }," até o próximo grupo.
function groupBodies(src) {
  const re = /^\s{2}(\w+): async \(workers\) => \{/gm;
  const marks = [...src.matchAll(re)].map(m => ({ name: m[1], at: m.index }));
  return Object.fromEntries(marks.map((m, i) => [m.name, src.slice(m.at, marks[i + 1]?.at ?? src.indexOf('export const VALID_GROUPS'))]));
}
const groups = groupBodies(registry);

// dispatchers por grupo, com as flags no valor padrão (variável ausente)
function dispatchersIn(body) {
  const sites = [...body.matchAll(/isEnabled\('(\w+)'(?:,\s*(true|false))?\)\)\s*\{\s*const stopDispatcher = startOutboxDispatcher/g)];
  return sites.map(s => ({ flag: s[1], defaultOn: s[2] !== 'false' }));
}
const perGroup = Object.fromEntries(Object.entries(groups).map(([g, b]) => [g, dispatchersIn(b)]));
const countFor = (gs) => gs.reduce((n, g) => n + perGroup[g].filter(d => d.defaultOn).length, 0);

test('só dois pontos do código iniciam o dispatcher, ambos ligados por padrão', () => {
  assert.equal((registry.match(/startOutboxDispatcher\(/g) || []).length, 2);
  assert.deepEqual(perGroup.outbox, [{ flag: 'ENABLE_OUTBOX_DISPATCHER', defaultOn: true }]);
  assert.deepEqual(perGroup.reconciliation, [{ flag: 'ENABLE_RECONCILIATION_OUTBOX', defaultOn: true }]);
  for (const g of ['scheduling', 'billing', 'clinical', 'whatsapp']) assert.deepEqual(perGroup[g], [], g);
});

test('contagem por forma de subir (flags no padrão)', () => {
  const allGroups = Object.keys(groups);
  const coreOnly = read('workers/entrypoints/whatsapp-only.js').match(/const coreGroups = \[([^\]]+)\]/)[1].match(/'(\w+)'/g).map(s => s.slice(1, -1));
  const coreWorker = read('workers/entrypoints/core-worker.js').match(/const CORE_GROUPS = \[([^\]]+)\]/)[1].match(/'(\w+)'/g).map(s => s.slice(1, -1));
  const table = {
    'server.js com ENABLE_WORKERS=true e sem WORKER_GROUP (monolito)': countFor(allGroups),
    'server.js com ENABLE_WORKERS=false': 0,
    'whatsapp-only.js (Start Command do crm-worker no Render)': countFor(coreOnly),
    'core-worker.js': countFor(coreWorker),
    'reconciliation-worker.js': countFor(['reconciliation']),
    'billing/clinical/scheduling/whatsapp-worker.js': 0,
  };
  assert.deepEqual(table, {
    'server.js com ENABLE_WORKERS=true e sem WORKER_GROUP (monolito)': 2,
    'server.js com ENABLE_WORKERS=false': 0,
    'whatsapp-only.js (Start Command do crm-worker no Render)': 1,
    'core-worker.js': 1,
    'reconciliation-worker.js': 1,
    'billing/clinical/scheduling/whatsapp-worker.js': 0,
  });
});

test('server.js só sobe workers com ENABLE_WORKERS === "true"', () => {
  assert.match(read('server.js'), /if \(process\.env\.ENABLE_WORKERS === "true"\)/);
});
