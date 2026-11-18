#!/usr/bin/env node
// Importa no conector uma sessão exportada do crm-worker (opção A da transferência; a opção B, QR novo,
// não precisa disto). Uso, com o conector PARADO:
//
//   node scripts/import-session.js --archive /caminho/sessao.tgz --sha256 <hash impresso na exportação> [--replace]
//
// Confere o hash, recusa caminhos perigosos no arquivo, pega a trava da sessão (falha se o conector estiver
// rodando), extrai em WHATSAPP_AUTH_PATH com permissão só do dono e lembra de apagar o arquivo.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { ensurePrivateDir, acquireSessionLock } from '../src/sessionGuard.js';

process.umask(0o077);
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const archive = opt('--archive');
const expected = (opt('--sha256') || '').toLowerCase();
const replace = args.includes('--replace');
const DATA_DIR = process.env.WA_CONNECTOR_DATA_DIR || '/var/data/wa-connector';
const AUTH_PATH = process.env.WHATSAPP_AUTH_PATH || path.join(DATA_DIR, 'wwebjs_auth');
const die = (m) => { console.error(`❌ ${m}`); process.exit(1); };

if (!archive || !fs.existsSync(archive)) die('--archive obrigatório e existente');
if (!/^[a-f0-9]{64}$/.test(expected)) die('--sha256 obrigatório (o hash que a exportação imprimiu)');
const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (actual !== expected) die(`hash não confere (arquivo ${actual}); não importe um arquivo alterado ou incompleto`);

const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = entries.filter((e) => e.startsWith('/') || e.split('/').includes('..'));
if (bad.length) die(`arquivo com caminhos perigosos: ${bad.slice(0, 3).join(', ')}`);
if (!entries.some((e) => /^(\.\/)?session(-default)?\//.test(e))) die('o arquivo não tem a pasta session/ do LocalAuth');

ensurePrivateDir(AUTH_PATH);
const lock = acquireSessionLock({ authPath: AUTH_PATH, connectorId: 'import-session' }); // falha se o conector estiver rodando
try {
  for (const d of ['session', 'session-default']) {
    const p = path.join(AUTH_PATH, d);
    if (!fs.existsSync(p)) continue;
    if (!replace) throw new Error(`já existe ${p}; use --replace para guardar a atual como cópia e importar`);
    const bak = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(p, bak);
    console.log(`↪️  sessão anterior guardada em ${bak}`);
  }
  execFileSync('tar', ['-xzf', archive, '-C', AUTH_PATH, '--no-same-owner', '--no-same-permissions'], { stdio: 'inherit' });
  execFileSync('chmod', ['-R', 'go-rwx', AUTH_PATH]);
  fs.writeFileSync(path.join(AUTH_PATH, '.imported.json'), JSON.stringify({ at: new Date().toISOString(), sha256: actual }));
  console.log(`✅ sessão importada em ${AUTH_PATH}`);
  console.log(`⚠️  Apague o arquivo agora (ele dá acesso ao WhatsApp da clínica): shred -u ${archive}`);
} catch (err) {
  lock.release();
  die(err.message);
} finally {
  lock.release();
}
