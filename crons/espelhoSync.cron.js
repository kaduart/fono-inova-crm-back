// crons/espelhoSync.cron.js
/**
 * 🪞 Cópia PRODUÇÃO → DEV na nuvem: SEGUNDA a SEXTA às 20:00 (America/Sao_Paulo).
 * Sábado e domingo não roda. Núcleo e garantias: services/espelho/espelhoSync.js · docs/ESPELHO_SYNC.md
 *
 * Onde roda: startAllCrons() (config/cronManager.js) → crm-backend no Render.
 * DESLIGADO por padrão. Liga com ESPELHO_SYNC_ENABLED=true (+ variáveis do doc).
 * Pausar sem redeploy: npm run espelho:nuvem -- pausar "motivo"  (ou ESPELHO_SYNC_PAUSED=true).
 * node-cron não recupera disparo perdido: se o serviço estiver reiniciando às 20:00, a cópia
 * daquele dia é pulada (o banco dev fica com a do dia anterior) — registrado em _espelho_execucoes.
 */
import cron from 'node-cron';
import { validarConfig, runEspelhoSync } from '../services/espelho/espelhoSync.js';

const TAG = '[EspelhoSync]';
export const HORARIO = '0 20 * * 1-5';

export function scheduleEspelhoSync() {
  try { validarConfig(); } catch (err) { console.error(`${TAG} ❌ não agendado: ${err.message}`); return null; }
  console.log(`${TAG} agendado: seg–sex 20:00 America/Sao_Paulo (${HORARIO})`);
  return cron.schedule(HORARIO, () => {
    runEspelhoSync().catch((e) => console.error(`${TAG} ❌ ${e.message}`));
  }, { timezone: 'America/Sao_Paulo' });
}
