#!/usr/bin/env node
/**
 * 🪞 Sobe o back local apontando para o ESPELHO (cópia da produção), com
 * workers, crons e integrações externas DESLIGADOS — os dados têm telefones e
 * e-mails reais, então nada pode sair desta máquina.
 *
 *   npm run dev:espelho
 */
import { spawn } from 'child_process';
import { URI, BACK_DIR } from './config.mjs';

const OFF = 'espelho-desligado';
const DEAD_URL = 'http://127.0.0.1:9/espelho-desligado';
const env = {
  ...process.env,
  MONGO_URI: URI,
  NODE_ENV: 'development',
  ESPELHO: 'true', // marca de "cópia local": código com efeito externo deve checar e não agir
  ENABLE_WORKERS: 'false',
  ENABLE_CRONS: 'false',
  ENABLE_WHATSAPP_REALTIME: 'false',
  ENABLE_ADS_CONVERSION: 'false',
  // Envios reais: credenciais trocadas por valores inválidos e URLs apontando para lugar nenhum
  META_WABA_TOKEN: OFF, META_ACCESS_TOKEN: OFF, META_PAGE_ACCESS_TOKEN: OFF,
  VPS_WHATSAPP_URL: DEAD_URL, VPS_WHATSAPP_TOKEN: OFF, WHATSAPP_VERIFY_TOKEN: OFF,
  RESEND_API_KEY: OFF, SENDGRID_API_KEY: OFF, SMTP_HOST: '127.0.0.1', SMTP_PORT: '9', SMTP_USER: OFF, SMTP_PASS: OFF,
  MAKE_WEBHOOK_URL: DEAD_URL, SICOOB_CLIENT_ID: OFF, SICOOB_CLIENT_SECRET: OFF, SICOOB_PFX_PATH: '',
  GMB_REFRESH_TOKEN: OFF, OPENAI_ADS_CONVERSIONS_API_KEY: '',
  // Conversões de anúncio: o cron liga sozinho quando há credencial — no espelho, nunca
  TIKTOK_EVENTS_TOKEN: '', TIKTOK_PIXEL_ID: '', META_CONVERSIONS_TOKEN: '', META_PIXEL_ID: '',
  GOOGLE_ADS_CONVERSION_ACTION_ID: '', ADS_CONVERSION_DRY_RUN: 'true',
};

console.log('[dev:espelho] back local → espelho', URI.replace(/\?.*/, ''), '| workers/crons/WhatsApp/e-mail/cobrança DESLIGADOS');
const child = spawn(process.execPath, ['--dns-result-order=ipv4first', '--max-old-space-size=2048', '-r', 'dotenv/config', 'server.js'], { cwd: BACK_DIR, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
