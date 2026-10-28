import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMirrorEnvironment } from './environment.mjs';

const uri = 'mongodb://127.0.0.1:27018/fono_espelho?replicaSet=rsespelho&directConnection=true';
const guard = fileURLToPath(new URL('./runtime-guard.cjs', import.meta.url));
const env = () => buildMirrorEnvironment(process.env, uri);
function child(code, overrides = {}) {
  const r = spawnSync(process.execPath, ['--require', guard, '-e', code], {
    env: { ...env(), ...overrides }, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  if (r.error) throw r.error;
  return r;
}
function passes(code) {
  const r = child(code);
  assert.equal(r.status, 0, r.stderr);
}
test('não herda credenciais, destinos, NODE_OPTIONS ou flags perigosas', () => {
  const e = buildMirrorEnvironment({ ...process.env, REDIS_URL: 'rediss://production.invalid', PROD_URI_READONLY: 'secret', NODE_OPTIONS: '--require malicious.cjs', ENABLE_PROJECTIONS: 'true', META_ACCESS_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret' }, uri);
  for (const k of ['PROD_URI_READONLY', 'NODE_OPTIONS', 'META_ACCESS_TOKEN', 'AWS_SECRET_ACCESS_KEY']) assert.equal(e[k], undefined);
  assert.equal(e.ENABLE_PROJECTIONS, 'false');
  assert.equal(e.REDIS_URL, 'redis://127.0.0.1:6381/0');
});
test('recusa Mongo remoto ou banco incorreto antes de iniciar o ERP', () => {
  for (const bad of ['mongodb://remote.invalid:27018/fono_espelho', 'mongodb://127.0.0.1:27018/fono_inova_prod']) {
    assert.throws(() => buildMirrorEnvironment({}, bad));
  }
});
test('guard recusa Redis remoto, Mongo incorreto e projeções ligadas', () => {
  for (const bad of [{ REDIS_URL: 'redis://production.invalid:6379' }, { MONGO_URI: 'mongodb://127.0.0.1:27018/fono_inova_prod' }, { ENABLE_PROJECTIONS: 'true' }]) {
    const result = child('console.log("GUARD_BYPASSED")', bad);
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes('GUARD_BYPASSED'));
  }
});
test('dotenv não relê o arquivo real; nenhum import da aplicação é necessário', () => {
  passes('const a=require("node:assert/strict");a.deepEqual(require("dotenv").config({path:".env",override:true}),{parsed:{}});a.equal(process.env.PROD_URI_READONLY,undefined)');
});
test('TCP, TLS e pipes recusam destinos antes de conectar', () => {
  passes('const a=require("node:assert/strict");for(const f of [()=>require("node:net").connect(27017,"production.invalid"),()=>require("node:net").connect(6379,"127.0.0.1"),()=>require("node:net").connect("pipe-name"),()=>require("node:tls").connect({host:"production.invalid",port:443})])a.throws(f,{code:"ESPELHO_NETWORK_BLOCKED"})');
});
test('HTTP, HTTPS, fetch e subprocessos são bloqueados', () => {
  passes('(async()=>{const a=require("node:assert/strict");for(const n of ["node:http","node:https"])a.throws(()=>require(n).get("https://production.invalid"),{code:"ESPELHO_NETWORK_BLOCKED"});await a.rejects(fetch("https://production.invalid"),{code:"ESPELHO_NETWORK_BLOCKED"});a.throws(()=>require("node:child_process").spawn("curl",[]),{code:"ESPELHO_PROCESS_BLOCKED"})})().catch(()=>process.exit(1))');
});
test('imports ESM também recebem os bloqueios', () => {
  passes('(async()=>{const a=require("node:assert/strict"),http=await import("node:http"),cp=await import("node:child_process");a.throws(()=>http.get("http://production.invalid"),{code:"ESPELHO_NETWORK_BLOCKED"});a.throws(()=>cp.spawn("curl",[]),{code:"ESPELHO_PROCESS_BLOCKED"})})().catch(()=>process.exit(1))');
});
test('validador permite apenas Mongo e Redis locais exclusivos, sem abrir sockets', () => {
  passes('const a=require("node:assert/strict"),g=require(process.execArgv[1]);g.assertTarget("127.0.0.1",27018);g.assertTarget("127.0.0.1",6381);a.throws(()=>g.assertTarget("127.0.0.1",443),{code:"ESPELHO_NETWORK_BLOCKED"});a.throws(()=>g.assertTarget("127.0.0.1",27017),{code:"ESPELHO_NETWORK_BLOCKED"})');
});
