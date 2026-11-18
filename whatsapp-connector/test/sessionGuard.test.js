// Proteção da sessão: pasta privada, trava exclusiva (um processo por sessão) e marcador de transferência.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensurePrivateDir, acquireSessionLock, LOCK_FILE, TRANSFERRED_MARKER } from '../src/sessionGuard.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-guard-'));

test('pasta da sessão: cria 0700 e fecha permissão aberta', () => {
  const dir = path.join(tmp(), 'auth');
  ensurePrivateDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.chmodSync(dir, 0o755);
  const r = ensurePrivateDir(dir);
  assert.equal(r.fixed, true);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('pasta de outro usuário: recusa', () => {
  const dir = tmp();
  assert.throws(() => ensurePrivateDir(dir, { uid: 123456 }), { code: 'WRONG_OWNER' });
});

test('trava: segundo processo vivo no mesmo host é recusado; liberar permite de novo', () => {
  const authPath = tmp();
  const a = acquireSessionLock({ authPath, hostname: 'h1', pid: 1001, isAlive: () => true });
  assert.equal(fs.statSync(path.join(authPath, LOCK_FILE)).mode & 0o777, 0o600);
  assert.throws(() => acquireSessionLock({ authPath, hostname: 'h1', pid: 1002, isAlive: () => true }), { code: 'LOCKED' });
  a.release();
  const b = acquireSessionLock({ authPath, hostname: 'h1', pid: 1002, isAlive: () => true });
  assert.equal(b.recovered, null);
});

test('trava de processo morto no mesmo host (crash): retomada e registrada', () => {
  const authPath = tmp();
  acquireSessionLock({ authPath, hostname: 'h1', pid: 2001, isAlive: () => true });
  const b = acquireSessionLock({ authPath, hostname: 'h1', pid: 2002, isAlive: (pid) => pid !== 2001 });
  assert.equal(b.recovered.pid, 2001);
});

test('trava de OUTRO host: nunca retomada sozinha; só com WA_SESSION_TAKEOVER=<host>', () => {
  const authPath = tmp();
  acquireSessionLock({ authPath, hostname: 'render-worker', pid: 7, isAlive: () => true });
  assert.throws(() => acquireSessionLock({ authPath, hostname: 'vps', pid: 8, isAlive: () => false }), { code: 'LOCKED_OTHER_HOST' });
  assert.throws(() => acquireSessionLock({ authPath, hostname: 'vps', pid: 8, takeoverHost: 'outro' }), { code: 'LOCKED_OTHER_HOST' });
  const ok = acquireSessionLock({ authPath, hostname: 'vps', pid: 8, takeoverHost: 'render-worker' });
  assert.equal(ok.recovered.hostname, 'render-worker');
});

test('sessão marcada como transferida: recusa subir', () => {
  const authPath = tmp();
  fs.writeFileSync(path.join(authPath, TRANSFERRED_MARKER), JSON.stringify({ to: 'outro', at: 'x' }));
  assert.throws(() => acquireSessionLock({ authPath, hostname: 'h', pid: 1 }), { code: 'TRANSFERRED' });
});

test('release não apaga a trava de outro processo', () => {
  const authPath = tmp();
  const a = acquireSessionLock({ authPath, hostname: 'h1', pid: 3001, isAlive: () => false });
  acquireSessionLock({ authPath, hostname: 'h1', pid: 3002, isAlive: () => false }); // retomou (3001 "morto")
  a.release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(authPath, LOCK_FILE), 'utf8')).pid, 3002);
});
