// Processo real do conector (src/index.js) subindo como em produção: recusa configuração insegura,
// recusa sessão em uso ou transferida, e sobe com o WhatsApp falso para ensaio (WA_CONNECTOR_ENGINE=simulator).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { signRequest, SIGNATURE_HEADER } from '../src/contract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 's'.repeat(40);
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

function run(env, { untilLog = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env: { PATH: process.env.PATH, ...env } });
    let out = '';
    const done = (r) => { clearTimeout(t); resolve({ ...r, out, child }); };
    const t = setTimeout(() => { child.kill('SIGKILL'); done({ timeout: true }); }, timeoutMs);
    const onData = (d) => { out += d; if (untilLog && out.includes(untilLog)) done({ up: true }); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => done({ code }));
  });
}

const baseEnv = (dir, port) => ({
  WA_CONNECTOR_SECRET: SECRET, CRM_EVENTS_URL: 'https://crm.exemplo/api/whatsapp-connector/events',
  WA_CONNECTOR_DATA_DIR: dir, PORT: String(port),
});

test('segredo curto ou CRM_EVENTS_URL sem https: não sobe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conn-'));
  const port = await freePort();
  const a = await run({ ...baseEnv(dir, port), WA_CONNECTOR_SECRET: 'curto' });
  assert.equal(a.code, 1);
  assert.match(a.out, /32 caracteres/);
  const b = await run({ ...baseEnv(dir, port), CRM_EVENTS_URL: 'http://crm/x' });
  assert.equal(b.code, 1);
  assert.match(b.out, /https/);
});

test('sessão em uso por outro processo vivo neste host: não sobe (nem carrega o whatsapp-web.js)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conn-'));
  const auth = path.join(dir, 'wwebjs_auth');
  fs.mkdirSync(auth, { mode: 0o700 });
  fs.writeFileSync(path.join(auth, '.connector-lock.json'), JSON.stringify({ hostname: os.hostname(), pid: process.pid, startedAt: 'agora' }));
  const r = await run(baseEnv(dir, await freePort()));
  assert.equal(r.code, 1);
  assert.match(r.out, /sessão em uso pelo processo/);
});

test('sessão marcada como transferida: não sobe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conn-'));
  const auth = path.join(dir, 'wwebjs_auth');
  fs.mkdirSync(auth, { mode: 0o700 });
  fs.writeFileSync(path.join(auth, '.session-transferred.json'), JSON.stringify({ to: 'outro-host' }));
  const r = await run(baseEnv(dir, await freePort()));
  assert.equal(r.code, 1);
  assert.match(r.out, /transferida/);
});

test('simulador: sobe, health aberto, status só assinado, encerra limpo no SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conn-'));
  const port = await freePort();
  const r = await run({ ...baseEnv(dir, port), WA_CONNECTOR_ENGINE: 'simulator' }, { untilLog: '🟢 porta' });
  assert.equal(r.up, true, r.out);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/status`)).status, 401);
    const headers = { [SIGNATURE_HEADER]: signRequest(SECRET, { method: 'GET', path: '/v1/status', body: '' }) };
    const st = await (await fetch(`http://127.0.0.1:${port}/v1/status`, { headers })).json();
    assert.equal(st.ready, true);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally {
    const exited = new Promise((res) => r.child.on('exit', res));
    r.child.kill('SIGTERM');
    assert.equal(await exited, 0);
  }
});
