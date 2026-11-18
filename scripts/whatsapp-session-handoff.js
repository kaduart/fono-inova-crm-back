#!/usr/bin/env node
// Transferência da sessão do WhatsApp entre o crm-worker (modo local) e o conector externo.
// Roda no SHELL DO crm-worker (é lá que está /var/data/wwebjs_auth). Não toca no banco nem no WhatsApp.
//
//   node scripts/whatsapp-session-handoff.js status
//   node scripts/whatsapp-session-handoff.js release --to <id do conector> [--export /tmp/sessao.tgz]
//   node scripts/whatsapp-session-handoff.js reclaim --confirm-connector-stopped
//
// release: grava o marcador .session-transferred.json. Com ele o modo local NUNCA abre o Chrome nesta
//   sessão (whatsappWebJsService recusa e mostra 'session_transferred' no ERP), mesmo que alguém tire a
//   variável WHATSAPP_CONNECTOR_MODE por engano. Exige o worker já em modo externo e nenhum Chrome usando a
//   pasta. Com --export, empacota a sessão (opção A) e imprime o sha256 para o import no conector.
// reclaim: apaga o marcador (reversão). Exige confirmar que o conector parou; se WA_CONNECTOR_URL estiver
//   configurada e o conector responder, recusa.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

export const TRANSFERRED_MARKER = '.session-transferred.json';
const AUTH_PATH = process.env.WHATSAPP_AUTH_PATH || '/var/data/wwebjs_auth';
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const die = (m) => { console.error(`❌ ${m}`); process.exit(1); };
const marker = path.join(AUTH_PATH, TRANSFERRED_MARKER);

/** Processos Chrome usando esta pasta de sessão (lê /proc; não depende de pgrep). */
function chromeUsingSession() {
  const out = [];
  if (!fs.existsSync('/proc')) return out;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ');
      if (/chrom/i.test(cmdline) && cmdline.includes(AUTH_PATH)) out.push(Number(d));
    } catch { /* processo sumiu */ }
  }
  return out;
}

async function connectorAnswers() {
  const url = process.env.WA_CONNECTOR_URL;
  if (!url) return null;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/v1/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

if (cmd === 'status') {
  const has = fs.existsSync(marker);
  console.log(JSON.stringify({
    authPath: AUTH_PATH,
    transferred: has ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null,
    sessionDirs: ['session', 'session-default'].filter((d) => fs.existsSync(path.join(AUTH_PATH, d))),
    chromeUsingSession: chromeUsingSession(),
    WHATSAPP_CONNECTOR_MODE: process.env.WHATSAPP_CONNECTOR_MODE || '(local)',
  }, null, 2));
} else if (cmd === 'release') {
  const to = opt('--to');
  if (!to) die('--to <id do conector> obrigatório');
  if (process.env.WHATSAPP_CONNECTOR_MODE !== 'external') die('o crm-worker ainda está em modo local: defina WHATSAPP_CONNECTOR_MODE=external e reinicie antes');
  const pids = chromeUsingSession();
  if (pids.length) die(`há Chrome usando a sessão (pids ${pids.join(', ')}); reinicie o crm-worker em modo externo e tente de novo`);
  let sha256 = null;
  const exportTo = opt('--export');
  if (exportTo) {
    const dirs = ['session', 'session-default'].filter((d) => fs.existsSync(path.join(AUTH_PATH, d)));
    if (!dirs.length) die(`nenhuma sessão em ${AUTH_PATH}`);
    const old = process.umask(0o077);
    execFileSync('tar', ['-czf', exportTo, '-C', AUTH_PATH,
      '--exclude=*/Default/Cache', '--exclude=*/Default/Code Cache', '--exclude=*/Default/GPUCache',
      '--exclude=Singleton*', ...dirs]);
    process.umask(old);
    fs.chmodSync(exportTo, 0o600);
    sha256 = crypto.createHash('sha256').update(fs.readFileSync(exportTo)).digest('hex');
    console.log(`📦 ${exportTo} (${Math.round(fs.statSync(exportTo).size / 1048576)} MB)`);
    console.log(`🔑 sha256 ${sha256}`);
    console.log('⚠️  Leve o arquivo direto ao host do conector (scp/sftp), nunca por e-mail, chat ou repositório; apague nos dois lados depois do import.');
  }
  fs.writeFileSync(marker, JSON.stringify({ to, at: new Date().toISOString(), exported: Boolean(exportTo), sha256 }), { mode: 0o600 });
  console.log(`✅ sessão marcada como transferida para ${to}. O modo local não abre mais o Chrome nesta pasta.`);
} else if (cmd === 'reclaim') {
  if (!args.includes('--confirm-connector-stopped')) die('confirme com --confirm-connector-stopped (o conector precisa estar parado antes)');
  const ans = await connectorAnswers();
  if (ans === true) die('o conector ainda responde em WA_CONNECTOR_URL; pare o serviço do conector primeiro');
  if (!fs.existsSync(marker)) { console.log('nada a fazer: sessão não estava marcada'); process.exit(0); }
  fs.unlinkSync(marker);
  console.log('✅ marcador removido. Tire WHATSAPP_CONNECTOR_MODE e reinicie o crm-worker para voltar ao modo local.');
} else {
  console.log('uso: status | release --to <id> [--export arquivo.tgz] | reclaim --confirm-connector-stopped');
  process.exit(cmd ? 1 : 0);
}
