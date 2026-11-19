// scripts/isolado/crmProc.mjs
// Sobe a API REAL (server.js) ou um grupo REAL de workers do CRM no ambiente
// integrado, com ambiente limpo (nada do shell nem do .env) e a trava
// runtime-guard-isolado.cjs. Dados fictícios; nada fala com Atlas/Render/WhatsApp.
//
//   node scripts/isolado/crmProc.mjs api                  # porta CRM_ISOLADO_API_PORT (padrão 5099)
//   node scripts/isolado/crmProc.mjs worker clinical      # workers/entrypoints/clinical-worker.js
//
// Entrada: CRM_ISOLADO_MONGO_URI (loopback, banco isolado_*), REDIS_URL (loopback).
// Workers: só os ENABLE_* passados em CRM_ISOLADO_WORKERS (lista separada por vírgula)
// ficam ligados no grupo; os demais do grupo vão como false.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireIsolatedMongo, requireIsolatedRedis, die } from './_guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const [role, group] = process.argv.slice(2);
const { uri } = requireIsolatedMongo();
const redisUrl = requireIsolatedRedis('REDIS_URL');
const port = process.env.CRM_ISOLADO_API_PORT || '5099';

const GROUP_FLAGS = {
  clinical: ['ENABLE_CLINICAL_EVOLUTION', 'ENABLE_CLINICAL_PATIENT', 'ENABLE_CLINICAL_PATIENT_PROJECTION', 'ENABLE_CLINICAL_ORCHESTRATOR', 'ENABLE_CLINICAL_SESSION', 'ENABLE_CLINICAL_SYNC'],
  scheduling: ['ENABLE_SCHEDULING_CREATE_APPOINTMENT', 'ENABLE_SCHEDULING_COMPLETE', 'ENABLE_SCHEDULING_APPOINTMENT', 'ENABLE_SCHEDULING_APPOINTMENT_INTEGRATION', 'ENABLE_SCHEDULING_UPDATE', 'ENABLE_SCHEDULING_SYNC_MEDICAL'],
};

const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'development', TZ: 'America/Sao_Paulo', CRM_ISOLADO: 'true', CRM_ISOLADO_ROLE: role,
  MONGO_URI: uri, MONGODB_URI: uri, REDIS_URL: redisUrl,
  ENABLE_WORKERS: 'false', ENABLE_CRONS: 'false', ENABLE_PROJECTIONS: 'false',
  ENABLE_WHATSAPP_REALTIME: 'false', ENABLE_ADS_CONVERSION: 'false', ADS_CONVERSION_DRY_RUN: 'true',
  WHATSAPP_ENABLED: 'false',
  PORT: port, FRONTEND_URL: 'http://127.0.0.1:5173', INTERNAL_BASE_URL: `http://127.0.0.1:${port}`,
  JWT_SECRET: process.env.CRM_ISOLADO_JWT_SECRET || 'isolado-sem-validade-em-producao',
  SESSION_SECRET: 'isolado-sessao-sem-validade',
  // SDKs instanciados no import exigem uma string; nenhuma é credencial real e a rede está bloqueada.
  OPENAI_API_KEY: 'sk-isolado-invalida', ANTHROPIC_API_KEY: 'isolado-invalida', RESEND_API_KEY: 're_isolado_invalida',
  GROQ_API_KEY: 'isolado-invalida', GEMINI_API_KEY: 'isolado-invalida',
  GOOGLE_ADS_CLIENT_ID: 'isolado', GOOGLE_ADS_CLIENT_SECRET: 'isolado', GOOGLE_ADS_REFRESH_TOKEN: 'isolado',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'isolado', GOOGLE_ADS_CUSTOMER_ID: '0000000000',
};

let entry;
if (role === 'api') {
  entry = 'server.js';
} else if (role === 'worker' && GROUP_FLAGS[group]) {
  entry = `workers/entrypoints/${group}-worker.js`;
  const on = new Set(String(process.env.CRM_ISOLADO_WORKERS || '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const f of GROUP_FLAGS[group]) env[f] = on.has(f) ? 'true' : 'false';
} else {
  die('uso: crmProc.mjs api | crmProc.mjs worker <clinical|scheduling>');
}

const guard = path.join(HERE, 'runtime-guard-isolado.cjs');
const child = spawn(process.execPath, ['--dns-result-order=ipv4first', '--require', guard, entry], { cwd: ROOT, env, stdio: 'inherit' });
// PID do processo real (para kill -9 no roteiro: matar o lançador não mata o filho).
if (process.env.CRM_ISOLADO_PIDFILE) (await import('node:fs')).writeFileSync(process.env.CRM_ISOLADO_PIDFILE, String(child.pid));
const fwd = (sig) => () => child.kill(sig);
process.on('SIGTERM', fwd('SIGTERM'));
process.on('SIGINT', fwd('SIGINT'));
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
