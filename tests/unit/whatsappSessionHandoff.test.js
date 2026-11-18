/**
 * scripts/whatsapp-session-handoff.js: liberar a sessão para o conector só com o worker já em modo externo,
 * exportar com hash, e voltar (reclaim) só com confirmação explícita de que o conector parou.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const ROOT = path.resolve(__dirname, '../..');
const run = (args, env) => spawnSync(process.execPath, ['scripts/whatsapp-session-handoff.js', ...args], {
  cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
});

function authDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-crm-auth-'));
  fs.mkdirSync(path.join(d, 'session', 'Default', 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(d, 'session', 'Default', 'Cookies'), 'x');
  fs.writeFileSync(path.join(d, 'session', 'Default', 'Cache', 'lixo'), 'y');
  return d;
}

describe('whatsapp-session-handoff', () => {
  it('release recusa com o worker ainda em modo local', () => {
    const r = run(['release', '--to', 'conector-1'], { WHATSAPP_AUTH_PATH: authDir() });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/modo local/);
  });

  it('release em modo externo: grava o marcador (0600) e exporta com sha256, sem o cache', () => {
    const d = authDir();
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-exp-')), 's.tgz');
    const r = run(['release', '--to', 'conector-1', '--export', out], { WHATSAPP_AUTH_PATH: d, WHATSAPP_CONNECTOR_MODE: 'external' });
    expect(r.status, r.stderr).toBe(0);
    const marker = path.join(d, '.session-transferred.json');
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({ to: 'conector-1', exported: true });
    expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
    expect(r.stdout).toContain(hash);
    const entries = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' });
    expect(entries).toContain('session/Default/Cookies');
    expect(entries).not.toContain('Cache/lixo');
  });

  it('reclaim exige confirmação; com ela, remove o marcador', () => {
    const d = authDir();
    fs.writeFileSync(path.join(d, '.session-transferred.json'), '{"to":"c"}');
    expect(run(['reclaim'], { WHATSAPP_AUTH_PATH: d }).status).toBe(1);
    const ok = run(['reclaim', '--confirm-connector-stopped'], { WHATSAPP_AUTH_PATH: d });
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.existsSync(path.join(d, '.session-transferred.json'))).toBe(false);
  });
});
