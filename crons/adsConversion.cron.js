// crons/adsConversion.cron.js
// Devolve para Meta (CAPI) e Google Ads (offline por gclid) os PRIMEIROS agendamentos
// confirmados, para as campanhas otimizarem por quem agenda — não por clique.
//
// Por que cron (e não evento): APPOINTMENT_CONFIRMED não tem fila consumidora e
// agendamentos entram por vários caminhos (agenda externa, importFromAgenda, V2).
// Varredura por createdAt pega todos. Idempotência: AdConversion.unique(appointment)
// + event_id/order_id = id do agendamento nas plataformas.
//
// Env:
//   ENABLE_ADS_CONVERSION=true        liga o cron (default: desligado)
//   ADS_CONVERSION_DRY_RUN=true       só loga, não grava nem envia
//   ADS_CONVERSION_DEFAULT_VALUE=220  valor quando sessionValue = 0 (ex.: convênio)
//   GOOGLE_ADS_CONVERSION_ACTION_ID   id da ação "Avaliação agendada" (importação)
// Nunca envia dado clínico: só telefone (hash), valor, id e origem.

import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import AdConversion from '../models/AdConversion.js';
import { getAttributionByPhone } from '../services/leadAttributionService.js';
import { sendPurchaseToMeta } from '../services/metaConversionsService.js';
import { uploadOfflineConversion } from '../services/googleAdsConversionsService.js';

const TAG = '[AdsConversion]';
const INTERVAL_MS = 10 * 60 * 1000;
const LOOKBACK_DAYS = 30;
const MIN_AGE_MS = 15 * 60 * 1000;          // espera 15 min (evita agendamento criado e desfeito)
const MAX_ATTEMPTS = 5;
// pre_agendado = todo agendamento nasce assim e já é o momento em que o contato entra na base
const CONFIRMED_STATUSES = ['pre_agendado', 'scheduled', 'confirmed', 'paid', 'completed'];

let isRunning = false;
let intervalId = null;

const isDryRun = () => process.env.ADS_CONVERSION_DRY_RUN === 'true';
const defaultValue = () => Number(process.env.ADS_CONVERSION_DEFAULT_VALUE || 220);

// fbc no formato que a Meta exige: fb.1.<ms do clique>.<fbclid>
const buildFbc = (attr) => (attr?.fbclid
  ? `fb.1.${new Date(attr.firstMessageAt || Date.now()).getTime()}.${attr.fbclid}`
  : null);

async function isFirstAppointment(appt) {
  if (appt.isFirstAppointment === true || appt.patientJourneyType === 'new_patient') return true;
  if (!appt.patient) return true; // pré-cadastro sem paciente = paciente novo
  const earlier = await Appointment.exists({
    patient: appt.patient,
    _id: { $ne: appt._id },
    createdAt: { $lt: appt.createdAt },
  });
  return !earlier;
}

async function resolvePhone(appt) {
  if (appt.patient) {
    const p = await Patient.findById(appt.patient).select('phone').lean();
    if (p?.phone) return p.phone;
  }
  return appt.patientInfo?.phone || null;
}

// ─── Etapa 1: registra agendamentos novos na fila (AdConversion) ─────────────
async function enqueueNew() {
  const now = Date.now();
  const candidates = await Appointment.find({
    createdAt: { $gte: new Date(now - LOOKBACK_DAYS * 864e5), $lte: new Date(now - MIN_AGE_MS) },
    operationalStatus: { $in: CONFIRMED_STATUSES },
  })
    .select('_id patient patientInfo.phone createdAt sessionValue isFirstAppointment patientJourneyType')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  if (!candidates.length) return 0;

  const known = await AdConversion.find({ appointment: { $in: candidates.map(c => c._id) } })
    .select('appointment').lean();
  const knownSet = new Set(known.map(k => String(k.appointment)));

  let queued = 0;
  for (const appt of candidates) {
    if (knownSet.has(String(appt._id))) continue;
    try {
      const first = await isFirstAppointment(appt);
      const phone = first ? await resolvePhone(appt) : null;
      const attr = phone ? await getAttributionByPhone(phone) : null;
      const value = Number(appt.sessionValue) > 0 ? Number(appt.sessionValue) : defaultValue();

      const doc = {
        appointment: appt._id,
        phone,
        source: attr?.source || 'unknown',
        attributionMethod: attr?.method || null,
        value,
        eventTime: appt.createdAt,
      };

      if (!first) {
        Object.assign(doc, {
          done: true,
          meta: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' },
          google: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' },
        });
      } else {
        const withinMetaWindow = Date.now() - new Date(appt.createdAt).getTime() < 6.5 * 864e5; // Meta: até 7 dias
        doc.meta = !phone ? { status: 'skipped', reason: 'sem_telefone' }
          : !withinMetaWindow ? { status: 'skipped', reason: 'fora_janela_7d_meta' }
          : { status: 'pending' };
        doc.google = attr?.gclid ? { status: 'pending' } : { status: 'skipped', reason: 'sem_gclid' };
        doc.gclid = attr?.gclid || null;
        doc.fbc = buildFbc(attr);
        if (doc.meta.status !== 'pending' && doc.google.status !== 'pending') doc.done = true;
      }

      if (isDryRun()) {
        console.log(`${TAG} [DRY] ${appt._id} first=${first} source=${doc.source} value=${value} meta=${doc.meta.status} google=${doc.google.status}`);
        continue;
      }

      await AdConversion.create(doc);
      queued++;
    } catch (err) {
      if (err?.code !== 11000) console.error(`${TAG} ❌ enqueue ${appt._id}:`, err.message);
    }
  }
  return queued;
}

// ─── Reclassifica "unknown" quando a origem é capturada DEPOIS do agendamento ───
// enqueueNew grava o source uma única vez; sem isto o agendamento fica "Sem origem" para sempre.
async function refreshUnknownSources() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
  const unknown = await AdConversion.find({
    source: 'unknown',
    phone: { $ne: null },
    createdAt: { $gte: since },
  }).select('_id phone').limit(300).lean();

  let updated = 0;
  for (const u of unknown) {
    try {
      const attr = await getAttributionByPhone(u.phone);
      if (!attr?.source) continue;
      const res = await AdConversion.updateOne(
        { _id: u._id, source: 'unknown' },
        { $set: { source: attr.source, attributionMethod: attr.method || null, ...(attr.gclid ? { gclid: attr.gclid } : {}), ...(attr.fbclid ? { fbc: buildFbc(attr) } : {}) } }
      );
      updated += res.modifiedCount || 0;

      // gclid chegou depois: reabre SÓ o envio ao Google (meta intocado), dentro de 90 dias
      if (res.modifiedCount && attr.gclid) {
        await AdConversion.updateOne(
          {
            _id: u._id,
            'google.status': 'skipped',
            'google.reason': 'sem_gclid',
            eventTime: { $gte: new Date(Date.now() - 90 * 864e5) },
          },
          { $set: { 'google.status': 'pending', done: false, nextAttemptAt: new Date() } }
        );
      }
    } catch (err) {
      console.error(`${TAG} ❌ refresh ${u._id}:`, err.message);
    }
  }
  return updated;
}

// ─── Etapa 2: envia pendentes com retry/backoff ─────────────────────────────
async function processPending() {
  const pending = await AdConversion.find({ done: false, nextAttemptAt: { $lte: new Date() } })
    .sort({ createdAt: 1 }).limit(50);
  let sent = 0;

  for (const conv of pending) {
    let retry = false;

    if (conv.meta?.status === 'pending' || conv.meta?.status === 'failed') {
      try {
        const eventTime = conv.eventTime; // já filtrado na janela de 7 dias no enqueue
        const r = await sendPurchaseToMeta({
          phone: conv.phone,
          fbc: conv.fbc,
          value: conv.value,
          eventId: `appt_${conv.appointment}`,
          eventTime,
          actionSource: 'physical_store', // atendimento na clínica; 'system_generated' era aceito (events_received:1) mas não entrava nas estatísticas
          customData: { lead_source: conv.source },
        });
        conv.meta = r ? { status: 'sent', sentAt: new Date() } : { status: 'skipped', reason: 'meta_capi_nao_configurado' };
        if (r) sent++;
      } catch (err) {
        conv.meta = { status: 'failed', reason: String(err?.response?.data?.error?.message || err.message).slice(0, 300) };
        retry = true;
      }
    }

    if (conv.google?.status === 'pending' || conv.google?.status === 'failed') {
      const r = await uploadOfflineConversion({
        gclid: conv.gclid, value: conv.value, eventTime: conv.eventTime, orderId: conv.appointment,
      });
      conv.google = { status: r.status, sentAt: r.status === 'sent' ? new Date() : null, reason: r.reason || null };
      if (r.status === 'sent') sent++;
      if (r.status === 'failed' && r.retryable) retry = true;
    }

    conv.attempts += 1;
    if (retry && conv.attempts < MAX_ATTEMPTS) {
      conv.nextAttemptAt = new Date(Date.now() + 2 ** conv.attempts * 10 * 60 * 1000); // 20m, 40m, 80m, 160m
    } else {
      conv.done = true;
    }
    await conv.save();
    console.log(`${TAG} ${conv.appointment} source=${conv.source} meta=${conv.meta.status} google=${conv.google.status} tentativa=${conv.attempts}`);
  }
  return sent;
}

async function runOnce() {
  if (isRunning) return;
  isRunning = true;
  const t0 = Date.now();
  try {
    const queued = await enqueueNew();
    const reclassified = isDryRun() ? 0 : await refreshUnknownSources();
    const sent = isDryRun() ? 0 : await processPending();
    if (queued || sent || reclassified) console.log(`${TAG} ✅ novos=${queued} reclassificados=${reclassified} enviados=${sent} em ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`${TAG} ❌ Erro:`, err.message);
  } finally {
    isRunning = false;
  }
}

export function initAdsConversionCron() {
  if (intervalId) return { stop: () => clearInterval(intervalId) };
  console.log(`🔄 Inicializando Ads Conversion Cron (a cada 10 min${isDryRun() ? ', DRY RUN' : ''})...`);
  intervalId = setInterval(runOnce, INTERVAL_MS);
  setTimeout(() => runOnce().catch(() => {}), 90 * 1000);
  return { stop: () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } } };
}

export { runOnce as runAdsConversionOnce };
export default { initAdsConversionCron };
