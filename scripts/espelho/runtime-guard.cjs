'use strict';
// Carregado ANTES dos imports da aplicação; não usar no processo de cópia.
const net = require('node:net');
const tls = require('node:tls');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

function assertTarget(host, port, path) {
  // Só os dois serviços locais exclusivos. HTTP externo e proxies locais também são bloqueados.
  const allowed = new Set([Number(process.env.ESPELHO_MONGO_PORT), 6381]);
  if (path || !['127.0.0.1', 'localhost', '::1'].includes(host) || !allowed.has(Number(port))) {
    const error = new Error('ESPELHO_NETWORK_BLOCKED: destino fora dos serviços locais autorizados');
    error.code = 'ESPELHO_NETWORK_BLOCKED';
    throw error;
  }
}
function target(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // argumentos normalizados internamente pelo Node
  if (first && typeof first === 'object') return [first.host || first.hostname || 'localhost', first.port, first.path];
  if (typeof first === 'number' || /^\d+$/.test(String(first))) return [typeof args[1] === 'string' ? args[1] : 'localhost', first];
  return [null, null, first || 'invalid'];
}
function install() {
  if (process.env.ESPELHO !== 'true') throw new Error('Guard exclusivo do espelho');
  const mongo = new URL(process.env.MONGO_URI || 'invalid:');
  if (mongo.protocol !== 'mongodb:' || mongo.hostname !== '127.0.0.1' || mongo.pathname !== '/fono_espelho' ||
      mongo.username || mongo.password || mongo.port !== process.env.ESPELHO_MONGO_PORT) throw new Error('Mongo fora do espelho');
  if (process.env.REDIS_URL !== 'redis://127.0.0.1:6381/0') throw new Error('Redis fora do espelho');
  for (const key of ['ENABLE_WORKERS', 'ENABLE_CRONS', 'ENABLE_PROJECTIONS']) {
    if (process.env[key] !== 'false') throw new Error('Processamento assíncrono não isolado');
  }
  // Impede imports posteriores de recarregarem credenciais do .env real.
  const dotenv = require('dotenv');
  dotenv.config = () => ({ parsed: {} });
  dotenv.configDotenv = dotenv.config;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    assertTarget(...target(args));
    return connect.apply(this, args);
  };
  const tlsConnect = tls.connect;
  tls.connect = function (...args) {
    assertTarget(...target(args));
    return tlsConnect.apply(this, args);
  };
  // Nenhuma chamada HTTP é necessária para consultar Mongo/Redis locais.
  for (const name of ['node:http', 'node:https']) {
    const mod = require(name);
    const blocked = () => { throw Object.assign(new Error('HTTP bloqueado no espelho'), { code: 'ESPELHO_NETWORK_BLOCKED' }); };
    mod.request = blocked;
    mod.get = blocked;
  }
  globalThis.fetch = async () => { throw Object.assign(new Error('Fetch bloqueado no espelho'), { code: 'ESPELHO_NETWORK_BLOCKED' }); };
  // Não permitir subprocessos sem o guard (curl, browsers, workers externos).
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[key] = () => { throw Object.assign(new Error('Subprocesso bloqueado no espelho'), { code: 'ESPELHO_PROCESS_BLOCKED' }); };
  }
  syncBuiltinESMExports();
}
module.exports = { assertTarget, target, install };
install();
