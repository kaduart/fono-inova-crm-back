#!/usr/bin/env node
/**
 * 🪞☁️ Controle manual da cópia produção → DEV na nuvem (mesmo código do cron).
 *
 *   npm run espelho:nuvem -- medir             → mede produção e espaço no destino (não escreve nada)
 *   npm run espelho:nuvem -- executar          → roda uma cópia agora (respeita pausa e trava)
 *   npm run espelho:nuvem -- pausar "motivo"   → pausa as cópias (preserva testes em andamento)
 *   npm run espelho:nuvem -- retomar
 *   npm run espelho:nuvem -- status            → última execução ok, falhas, pausa
 *
 * Lê as variáveis do back/.env (ou de --env-file=<caminho>). Relatório salvo em .local/espelho-nuvem-<cmd>.json
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { BACK_DIR } from './config.mjs';

const require = createRequire(import.meta.url);
const envFile = process.argv.find((a) => a.startsWith('--env-file='))?.split('=')[1] || path.join(BACK_DIR, '.env');
require('dotenv').config({ path: envFile });
const [cmd = 'status', ...resto] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const { runEspelhoSync, definirPausa, status } = await import('../../services/espelho/espelhoSync.js');
const acoes = {
  medir: () => runEspelhoSync({ medirSomente: true }),
  executar: () => runEspelhoSync(),
  pausar: () => definirPausa(true, resto.join(' ') || 'pausado manualmente'),
  retomar: () => definirPausa(false, ''),
  status: () => status(),
};
if (!acoes[cmd]) { console.error(`comando inválido: ${cmd} (use: ${Object.keys(acoes).join(', ')})`); process.exit(2); }
try {
  const r = await acoes[cmd]();
  const out = JSON.stringify(r, null, 2);
  fs.mkdirSync(path.join(BACK_DIR, '.local'), { recursive: true });
  fs.writeFileSync(path.join(BACK_DIR, '.local', `espelho-nuvem-${cmd}.json`), out);
  console.log(out);
  process.exit(['falhou'].includes(r?.status) ? 1 : 0);
} catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
