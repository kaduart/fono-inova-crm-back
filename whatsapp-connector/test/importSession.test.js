// Import da sessão exportada do crm-worker (opção A): hash, caminhos perigosos, trava e permissões.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function makeArchive({ evil = false } = {}) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-src-'));
  fs.mkdirSync(path.join(src, 'session', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(src, 'session', 'Default', 'Cookies'), 'segredo');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-arc-')), 'sessao.tgz');
  if (evil) execFileSync('tar', ['-czf', out, '-C', src, '--transform', 's,^session,../fora,', 'session']);
  else execFileSync('tar', ['-czf', out, '-C', src, 'session']);
  return out;
}

const run = (args, dataDir) => spawnSync(process.execPath, ['scripts/import-session.js', ...args], {
  cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, WA_CONNECTOR_DATA_DIR: dataDir },
});

test('hash errado: recusa', () => {
  const arc = makeArchive();
  const r = run(['--archive', arc, '--sha256', '0'.repeat(64)], fs.mkdtempSync(path.join(os.tmpdir(), 'wa-d-')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hash não confere/);
});

test('caminho perigoso (..) no arquivo: recusa', () => {
  const arc = makeArchive({ evil: true });
  const r = run(['--archive', arc, '--sha256', sha(arc)], fs.mkdtempSync(path.join(os.tmpdir(), 'wa-d-')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /perigosos|session\//);
});

test('conector rodando (trava viva): recusa', () => {
  const arc = makeArchive();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-d-'));
  const auth = path.join(dataDir, 'wwebjs_auth');
  fs.mkdirSync(auth, { mode: 0o700 });
  fs.writeFileSync(path.join(auth, '.connector-lock.json'), JSON.stringify({ hostname: os.hostname(), pid: process.pid }));
  const r = run(['--archive', arc, '--sha256', sha(arc)], dataDir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /em uso/);
});

test('import ok: sessão só do dono, trava liberada, sessão existente só com --replace', () => {
  const arc = makeArchive();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-d-'));
  const r = run(['--archive', arc, '--sha256', sha(arc)], dataDir);
  assert.equal(r.status, 0, r.stderr);
  const auth = path.join(dataDir, 'wwebjs_auth');
  assert.equal(fs.readFileSync(path.join(auth, 'session', 'Default', 'Cookies'), 'utf8'), 'segredo');
  assert.equal(fs.statSync(path.join(auth, 'session')).mode & 0o077, 0);
  assert.equal(fs.existsSync(path.join(auth, '.connector-lock.json')), false);
  assert.match(r.stdout, /Apague o arquivo/);
  const again = run(['--archive', arc, '--sha256', sha(arc)], dataDir);
  assert.equal(again.status, 1);
  assert.equal(fs.existsSync(path.join(auth, '.connector-lock.json')), false, 'falha não pode deixar trava presa');
  const repl = run(['--archive', arc, '--sha256', sha(arc), '--replace'], dataDir);
  assert.equal(repl.status, 0, repl.stderr);
  assert.ok(fs.readdirSync(auth).some((d) => d.startsWith('session.bak-')));
});
