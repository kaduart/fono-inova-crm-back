// Trava do ambiente integrado (scripts/isolado/runtime-guard-isolado.cjs): só aceita
// Mongo/Redis em loopback, banco isolado_* e, na API, processamento assíncrono desligado.
//   node --test tests/isolado/runtimeGuardIsolado.nodetest.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { config } = require('../../scripts/isolado/runtime-guard-isolado.cjs');

const ok = { CRM_ISOLADO: 'true', MONGO_URI: 'mongodb://127.0.0.1:27317/isolado_crm?directConnection=true', REDIS_URL: 'redis://127.0.0.1:6579', CRM_ISOLADO_ROLE: 'worker' };

test('aceita loopback + isolado_* e libera só as duas portas', () => {
  assert.deepEqual([...config(ok).ports].sort((a, b) => a - b), [6579, 27317]);
});

test('recusa Atlas, host remoto, banco de produção, credencial e falta da marca', () => {
  const bad = [
    { ...ok, MONGO_URI: 'mongodb+srv://x.mongodb.net/isolado_crm' },
    { ...ok, MONGO_URI: 'mongodb://10.0.0.5:27017/isolado_crm' },
    { ...ok, MONGO_URI: 'mongodb://127.0.0.1:27017/test' },
    { ...ok, MONGO_URI: 'mongodb://u:p@127.0.0.1:27017/isolado_crm' },
    { ...ok, REDIS_URL: 'redis://redis.render.com:6379' },
    { ...ok, REDIS_URL: 'redis://:senha@127.0.0.1:6379' },
    { ...ok, CRM_ISOLADO: undefined },
  ];
  for (const env of bad) assert.throws(() => config(env), /ISOLADO_GUARD/, JSON.stringify(env));
});

test('API exige workers, crons e projeções desligados', () => {
  assert.throws(() => config({ ...ok, CRM_ISOLADO_ROLE: 'api', ENABLE_WORKERS: 'true', ENABLE_CRONS: 'false', ENABLE_PROJECTIONS: 'false' }), /ENABLE_WORKERS/);
  assert.ok(config({ ...ok, CRM_ISOLADO_ROLE: 'api', ENABLE_WORKERS: 'false', ENABLE_CRONS: 'false', ENABLE_PROJECTIONS: 'false' }));
});
