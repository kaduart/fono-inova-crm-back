// scripts/adsConversionDoctor.mjs
// Diagnóstico READ-ONLY do envio de conversões (Meta/Google/TikTok) — rode no SERVIDOR.
// Não envia nada, não grava: só lê o AdConversion e a presença das envs.
// Uso:  node scripts/adsConversionDoctor.mjs [dias]        (default 30)
import 'dotenv/config';
import mongoose from 'mongoose';
import AdConversion from '../models/AdConversion.js';
import Appointment from '../models/Appointment.js';

const DAYS = Number(process.argv[2]) || 30;
const since = new Date(Date.now() - DAYS * 864e5);
const PLATFORMS = ['meta', 'google', 'tiktok'];
const BOOKED = ['scheduled', 'confirmed', 'paid', 'completed'];
const ENV_VARS = [
  'ENABLE_ADS_CONVERSION', 'ADS_CONVERSION_DRY_RUN',
  'META_PIXEL_ID', 'META_CONVERSIONS_TOKEN',
  'TIKTOK_EVENTS_TOKEN', 'TIKTOK_PIXEL_ID',
  'GOOGLE_ADS_CONVERSION_ACTION_ID', 'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN',
  'MONGO_URI',
];

console.log(`\n================ ADS CONVERSION DOCTOR (prod) ================`);
console.log(`Janela: últimos ${DAYS} dias  (desde ${since.toISOString().slice(0, 10)})\n`);

console.log('--- ENV (presença, sem valores) ---');
for (const v of ENV_VARS) console.log(`${process.env[v] ? '✅' : '❌'} ${v}`);
const cronOn = process.env.ENABLE_ADS_CONVERSION === 'true';
console.log(`\n>>> CRON ${cronOn ? 'LIGADO' : 'DESLIGADO (nada é enviado)'}  | DRY_RUN=${process.env.ADS_CONVERSION_DRY_RUN === 'true' ? 'on' : 'off'}`);

if (!process.env.MONGO_URI) { console.log('\n❌ MONGO_URI ausente — não dá pra ler o banco.'); process.exit(1); }
await mongoose.connect(process.env.MONGO_URI);

const total = await AdConversion.countDocuments({ eventTime: { $gte: since } });
const booked = await Appointment.countDocuments({ createdAt: { $gte: since }, operationalStatus: { $in: BOOKED } });
console.log(`\n--- Volume (${DAYS}d) ---`);
console.log(`Agendamentos (booked): ${booked}   |   Registros AdConversion: ${total}`);

for (const p of PLATFORMS) {
  const status = await AdConversion.aggregate([
    { $match: { eventTime: { $gte: since }, [`${p}.status`]: { $exists: true, $ne: null } } },
    { $group: { _id: `$${p}.status`, n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]);
  const reasons = await AdConversion.aggregate([
    { $match: { eventTime: { $gte: since }, [`${p}.status`]: { $in: ['skipped', 'failed'] } } },
    { $group: { _id: `$${p}.reason`, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 6 },
  ]);
  const last = await AdConversion.find({ [`${p}.status`]: 'sent' }).sort({ [`${p}.sentAt`]: -1 }).select(`${p}.sentAt`).limit(1).lean();
  console.log(`\n### ${p.toUpperCase()}`);
  console.log('  status:', status.length ? status.map((r) => `${r._id}=${r.n}`).join('  ') : '(sem registros)');
  if (reasons.length) console.log('  motivos ignorada/falha:', reasons.map((r) => `${r._id || 'sem_motivo'} (${r.n})`).join(', '));
  if (last[0]) console.log('  último "sent":', last[0][p]?.sentAt);
}

console.log('\nLegenda: sent=API aceitou recebimento (≠ atribuído) · skipped=ignorado (ver motivo) · failed=erro · pending=na fila');
console.log('==============================================================\n');
await mongoose.disconnect();
