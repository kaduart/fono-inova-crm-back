// scripts/isolado/crmReaper.mjs
// Reaper do Event Store do CRM (código real: config/cronManager.js +
// crons/eventReaper.cron.js) num processo próprio, contra o ambiente isolado.
// Mesmo caminho do servidor: resolveEventReaperOwner decide se sobe; com
// EVENT_REAPER_OWNER=kas o processo não reapera nada e só registra isso.
// SIGTERM: para o cron e devolve a posse compartilhada (se tiver).
import mongoose from 'mongoose';
import { requireIsolatedMongo, requireLocalUrl } from './_guard.mjs';

const { uri } = requireIsolatedMongo();
requireLocalUrl('ALERT_WEBHOOK_URL');
if (process.env.SLACK_WEBHOOK_URL) process.env.SLACK_WEBHOOK_URL = '';

const { resolveEventReaperOwner, startCron, stopAllCronsAndRelease } = await import('../../config/cronManager.js');
const owner = resolveEventReaperOwner();
await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
console.log(JSON.stringify({ msg: 'crm_reaper_boot', owner, pid: process.pid }));

let cron = null;
if (owner === 'node') {
  const { initEventReaperCron } = await import('../../crons/eventReaper.cron.js');
  cron = startCron('eventReaper', () => initEventReaperCron());
} else {
  console.log(JSON.stringify({ msg: 'crm_reaper_not_started', reason: 'EVENT_REAPER_OWNER=kas' }));
}

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ msg: 'crm_reaper_stop', signal: sig }));
  try { await stopAllCronsAndRelease(); } catch (e) { console.error('release:', e.message); }
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
