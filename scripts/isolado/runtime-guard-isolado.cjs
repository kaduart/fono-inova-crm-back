'use strict';
// Trava de rede/processo do ambiente integrado (item 7): API e workers REAIS do CRM
// contra o MongoDB e o Redis descartáveis. Carregada com `node --require` ANTES dos
// imports da aplicação (mesma ideia de scripts/espelho/runtime-guard.cjs, com as
// regras do isolado: loopback + banco "isolado_*").
//
// Só conecta em 127.0.0.1 nas portas do Mongo e do Redis do ambiente; HTTP/fetch de
// saída, TLS para fora e subprocessos ficam bloqueados. O servidor HTTP da própria
// API (escuta) continua funcionando.
const net = require('node:net');
const tls = require('node:tls');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

function fail(msg) { throw Object.assign(new Error(`ISOLADO_GUARD: ${msg}`), { code: 'ISOLADO_GUARD' }); }
const LOOP = new Set(['127.0.0.1', 'localhost', '::1']);

function config(env = process.env) {
  if (env.CRM_ISOLADO !== 'true') fail('CRM_ISOLADO=true ausente');
  let mongo, redis;
  try { mongo = new URL(env.MONGO_URI || ''); } catch { fail('MONGO_URI inválida'); }
  try { redis = new URL(env.REDIS_URL || ''); } catch { fail('REDIS_URL inválida'); }
  if (mongo.protocol !== 'mongodb:' || !LOOP.has(mongo.hostname) || mongo.username || mongo.password) fail('Mongo fora de loopback ou com credencial');
  if (!/^\/isolado_[A-Za-z0-9_]+$/.test(mongo.pathname)) fail('banco precisa ser isolado_*');
  if (redis.protocol !== 'redis:' || !LOOP.has(redis.hostname) || redis.password) fail('Redis fora de loopback ou com senha');
  if (env.CRM_ISOLADO_ROLE === 'api') {
    for (const k of ['ENABLE_WORKERS', 'ENABLE_CRONS', 'ENABLE_PROJECTIONS']) if (env[k] !== 'false') fail(`${k} precisa ser false na API`);
  }
  return { ports: new Set([Number(mongo.port || 27017), Number(redis.port || 6379)]) };
}

function target(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') return [first.host || first.hostname || 'localhost', first.port, first.path];
  if (typeof first === 'number' || /^\d+$/.test(String(first))) return [typeof args[1] === 'string' ? args[1] : 'localhost', first];
  return [null, null, first || 'invalid'];
}

function install() {
  const { ports } = config();
  const assertTarget = (host, port, path) => {
    if (path || !LOOP.has(host) || !ports.has(Number(port))) {
      throw Object.assign(new Error('ISOLADO_NETWORK_BLOCKED: destino fora do Mongo/Redis do ambiente'), { code: 'ISOLADO_NETWORK_BLOCKED' });
    }
  };
  const dotenv = require('dotenv');
  dotenv.config = () => ({ parsed: {} });
  dotenv.configDotenv = dotenv.config;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) { assertTarget(...target(a)); return connect.apply(this, a); };
  const tlsConnect = tls.connect;
  tls.connect = function (...a) { assertTarget(...target(a)); return tlsConnect.apply(this, a); };
  for (const name of ['node:http', 'node:https']) {
    const mod = require(name);
    const blocked = () => { throw Object.assign(new Error('HTTP de saída bloqueado no isolado'), { code: 'ISOLADO_NETWORK_BLOCKED' }); };
    mod.request = blocked; mod.get = blocked;
  }
  globalThis.fetch = async () => { throw Object.assign(new Error('fetch bloqueado no isolado'), { code: 'ISOLADO_NETWORK_BLOCKED' }); };
  for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[k] = () => { throw Object.assign(new Error('subprocesso bloqueado no isolado'), { code: 'ISOLADO_PROCESS_BLOCKED' }); };
  }
  syncBuiltinESMExports();
}
module.exports = { config, target, install };
// Instala só quando carregada por `node --require .../runtime-guard-isolado.cjs` (crmProc.mjs);
// importada por teste, expõe config() sem instalar nada.
if (process.execArgv.some((a) => a.includes('runtime-guard-isolado'))) install();
