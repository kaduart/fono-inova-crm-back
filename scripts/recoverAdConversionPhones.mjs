// scripts/recoverAdConversionPhones.mjs
// Recupera conversões que ficaram SEM TELEFONE (done:true, ignoradas por sem_telefone),
// preenchendo o telefone do paciente e reabrindo pro cron reenviar à Meta/TikTok.
// SEGURO: DRY_RUN por padrão. Limitado à janela de atribuição (fora dela a Meta rejeita).
// Rodar no SERVIDOR de prod:
//   node scripts/recoverAdConversionPhones.mjs            # simula (não grava)
//   APPLY=true node scripts/recoverAdConversionPhones.mjs # aplica
// Depois: garanta ENABLE_ADS_CONVERSION=true pro cron enviar na próxima rodada.
import 'dotenv/config';
import mongoose from 'mongoose';
import AdConversion from '../models/AdConversion.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import { resolveMainPhone } from '../crons/adsConversion.logic.js';

const DRY_RUN = process.env.APPLY !== 'true';
const WINDOW_DAYS = 6.5;                       // mesma janela do cron (Meta/TikTok ~7d)
const sinceWindow = new Date(Date.now() - WINDOW_DAYS * 864e5);

if (!process.env.MONGO_URI) { console.error('❌ MONGO_URI ausente'); process.exit(1); }
await mongoose.connect(process.env.MONGO_URI);
console.log(`\n=== Recuperação de telefones (AdConversion) ===`);
console.log(`Modo: ${DRY_RUN ? 'DRY_RUN (não grava)' : 'APPLY (grava)'} | janela: ${WINDOW_DAYS} dias\n`);

const targets = await AdConversion.find({ done: true, $or: [{ phone: null }, { phone: '' }] })
  .select('_id appointment eventTime').lean();

let recuperaveis = 0, foraJanela = 0, semTelefone = 0, semAppt = 0;
const ops = [];
for (const d of targets) {
  if (!d.appointment) { semAppt++; continue; }
  const appt = await Appointment.findById(d.appointment).select('patient patientInfo.phone').lean();
  if (!appt) { semAppt++; continue; }
  let patientPhone = null;
  if (appt.patient) { const p = await Patient.findById(appt.patient).select('phone').lean(); patientPhone = p?.phone || null; }
  const phone = resolveMainPhone({ patientInfoPhone: appt.patientInfo?.phone, patientPhone });
  if (!phone) { semTelefone++; continue; }
  if (!(d.eventTime && new Date(d.eventTime) >= sinceWindow)) { foraJanela++; continue; }
  recuperaveis++;
  ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: {
    phone,
    'meta.status': 'pending', 'meta.reason': null, 'meta.sentAt': null,
    'tiktok.status': 'pending', 'tiktok.reason': null, 'tiktok.sentAt': null,
    done: false, attempts: 0, nextAttemptAt: new Date(), recoveredAt: new Date(),
  } } } });
}

console.log(`Alvos sem telefone (done:true): ${targets.length}`);
console.log(`✅ recuperáveis (telefone + dentro da janela): ${recuperaveis}`);
console.log(`⏱️  fora da janela (${WINDOW_DAYS}d — Meta/TikTok rejeitam): ${foraJanela}`);
console.log(`📵 sem telefone no cadastro do paciente: ${semTelefone}`);
console.log(`🔗 sem agendamento/paciente vinculado: ${semAppt}`);

if (DRY_RUN) {
  console.log(`\n[DRY_RUN] nada gravado. Para aplicar: APPLY=true node scripts/recoverAdConversionPhones.mjs`);
} else if (ops.length) {
  const r = await AdConversion.bulkWrite(ops, { ordered: false });
  console.log(`\n[APPLY] registros reabertos: ${r.modifiedCount}. O cron (ENABLE_ADS_CONVERSION=true) reenvia na próxima rodada.`);
} else {
  console.log(`\n[APPLY] nada a reabrir.`);
}
await mongoose.disconnect();
