/**
 * 🎂 Birthday Message Cron
 *
 * Todo dia às 10h (America/Sao_Paulo) manda o "feliz aniversário" pelo WhatsApp da clínica
 * para os pacientes ativos que fazem aniversário hoje.
 *
 * Idempotente: a trava de 1 envio por ano fica no Patient (ver birthdayMessageService), então
 * reexecutar o cron ou clicar no botão manual do dashboard não duplica a mensagem.
 * As mensagens saem espaçadas (~45s + jitter) para não parecer disparo em massa.
 */

import cron from 'node-cron';
import moment from 'moment-timezone';
import { createContextLogger } from '../utils/logger.js';
import {
  BIRTHDAY_TIMEZONE,
  findBirthdayPatientsToSend,
  sendBirthdayMessage,
} from '../services/birthday/birthdayMessageService.js';

const log = createContextLogger('cron', 'BirthdayMessage');

const CRON_SCHEDULE = '0 10 * * *';
const SPACING_MS = 45_000;
const JITTER_MS = 15_000;

export async function runBirthdayMessages(now = moment().tz(BIRTHDAY_TIMEZONE)) {
  const started = Date.now();
  const correlationId = `birthday_${started}`;

  try {
    const patients = await findBirthdayPatientsToSend(now);
    if (patients.length === 0) {
      log.info('run', `[${correlationId}] Nenhum aniversariante para enviar hoje`);
      return { found: 0, sent: 0, skipped: 0, failed: 0 };
    }

    log.info('run', `[${correlationId}] ${patients.length} aniversariante(s) hoje`);

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const [i, p] of patients.entries()) {
      try {
        const delayMs = i * SPACING_MS + Math.floor(Math.random() * JITTER_MS);
        const result = await sendBirthdayMessage(p._id, { delayMs, now });
        if (result.sent) {
          sent++;
        } else {
          skipped++;
          log.info('skip', `[${correlationId}] ${p._id}: ${result.reason}`);
        }
      } catch (err) {
        failed++;
        log.error('send', `[${correlationId}] ${p._id}: ${err.message}`);
      }
    }

    log.info('done', `[${correlationId}] enviados=${sent} ignorados=${skipped} falhas=${failed} (${Date.now() - started}ms)`);
    return { found: patients.length, sent, skipped, failed };
  } catch (err) {
    log.error('fatal', `[${correlationId}] ${err.message}`);
    throw err;
  }
}

export function scheduleBirthdayMessages() {
  log.info('schedule', `Agendando mensagens de aniversário: ${CRON_SCHEDULE} (${BIRTHDAY_TIMEZONE})`);

  return cron.schedule(CRON_SCHEDULE, async () => {
    try {
      await runBirthdayMessages();
    } catch {
      /* já logado em runBirthdayMessages */
    }
  }, {
    scheduled: true,
    timezone: BIRTHDAY_TIMEZONE,
  });
}
