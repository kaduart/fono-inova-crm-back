// crons/adsConversion.cron.js
// Devolve para Meta (CAPI), Google Ads (offline por gclid) e TikTok (Events API por ttclid)
// os PRIMEIROS agendamentos confirmados, para as campanhas otimizarem por quem agenda — não por clique.
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
//   TIKTOK_EVENTS_TOKEN               Access Token da TikTok Events API (envio por ttclid)
// Nunca envia dado clínico: só telefone (hash), valor, id e origem.
// Doc: back/docs/ADS_CONVERSION_CONTRACT.md

import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import AdConversion from '../models/AdConversion.js';
import { getAttributionByPhone } from '../services/leadAttributionService.js';
import { sendPurchaseToMeta } from '../services/metaConversionsService.js';
import { uploadOfflineConversion } from '../services/googleAdsConversionsService.js';
import { sendEventToTikTok } from '../services/tiktokConversionsService.js';
import {
  BOOKED_STATUSES, resolveMainPhone, decidePlatforms,
  interpretMetaResponse, interpretTiktokResponse, buildFbc,
  resolveConversionTime, shouldAcquire, eventIdFor, buildPendingClaim,
} from './adsConversion.logic.js';

const TAG = '[AdsConversion]';
const INTERVAL_MS = 10 * 60 * 1000;
const LOOKBACK_DAYS = 30;
const MIN_AGE_MS = 15 * 60 * 1000;          // espera 15 min (evita agendamento criado e desfeito)
const MAX_ATTEMPTS = 5;

let isRunning = false;
let intervalId = null;

const isDryRun = () => process.env.ADS_CONVERSION_DRY_RUN === 'true';
const defaultValue = () => Number(process.env.ADS_CONVERSION_DEFAULT_VALUE || 220);

// #1 A aquisição NÃO depende de o agendamento original continuar elegível:
//   - já há aquisição registrada p/ o paciente            -> não
//   - algum agendamento ANTERIOR já tem conversão (legado) -> não (não duplica)
//   - algum anterior AINDA elegível (booked)               -> ele é a âncora; este defere
//   - anteriores inelegíveis (ex.: cancelado) e sem conversão -> este agendamento é a aquisição
async function isAcquisitionAppointment(appt) {
  if (!appt.patient) return true; // pré-cadastro sem paciente
  const alreadyAcquired = !!(await AdConversion.exists({ patient: appt.patient, isAcquisition: true }));
  if (alreadyAcquired) return false;
  const earlier = await Appointment.find({
    patient: appt.patient,
    _id: { $ne: appt._id },
    createdAt: { $lt: appt.createdAt },
  }).select('_id operationalStatus').lean();
  if (!earlier.length) return true;
  const earlierConverted = !!(await AdConversion.exists({ appointment: { $in: earlier.map(e => e._id) } }));
  const earlierEligibleExists = earlier.some(e => BOOKED_STATUSES.includes(e.operationalStatus));
  return shouldAcquire({ hasPatient: true, alreadyAcquired: false, earlierConverted, earlierEligibleExists });
}

async function resolvePhone(appt) {
  // #1 Contato PRINCIPAL do atendimento: patientInfo.phone (capturado no atendimento) tem
  // prioridade; Patient.phone é fallback. resolveMainPhone valida (E.164 BR) e devolve o
  // primeiro válido — nunca usa contato de emergência e não bloqueia quando diferem.
  let patientPhone = null;
  if (appt.patient) {
    const p = await Patient.findById(appt.patient).select('phone').lean();
    patientPhone = p?.phone || null;
  }
  return resolveMainPhone({ patientInfoPhone: appt.patientInfo?.phone, patientPhone });
}

// ─── Etapa 1: registra agendamentos novos na fila (AdConversion) ─────────────
async function enqueueNew() {
  const now = Date.now();
  const windowStart = new Date(now - LOOKBACK_DAYS * 864e5);
  const candidates = await Appointment.find({
    operationalStatus: { $in: BOOKED_STATUSES }, // #2 só agendamento real (exclui pre_agendado/projeção)
    createdAt: { $lte: new Date(now - MIN_AGE_MS) }, // espera 15 min mesmo em confirmação tardia
    // #5 Confirmação tardia: um pre_agendado antigo que vira scheduled DEPOIS de 30 dias tem
    // createdAt fora da janela, mas updatedAt recente. Aceitar createdAt OU updatedAt impede
    // que ele desapareça do processamento (o envio ainda respeita a janela de 7d por plataforma).
    $or: [
      { createdAt: { $gte: windowStart } },
      { updatedAt: { $gte: windowStart } },
    ],
  })
    .select('_id patient patientInfo.phone createdAt updatedAt history sessionValue isFirstAppointment patientJourneyType')
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
      const first = await isAcquisitionAppointment(appt);
      const phone = first ? await resolvePhone(appt) : null;
      const attr = phone ? await getAttributionByPhone(phone) : null;
      const value = Number(appt.sessionValue) > 0 ? Number(appt.sessionValue) : defaultValue();

      // #2 event_time = data COMPROVADA em que o agendamento virou conversão (transição no
      // histórico p/ status booked); sem evidência, cai para createdAt. Nunca updatedAt genérico.
      const eventTime = resolveConversionTime(appt);
      const d = decidePlatforms({ first, phone, attr, eventTimeMs: eventTime.getTime() });
      const doc = {
        appointment: appt._id,
        patient: appt.patient || null,   // #3 dedupe por paciente (índice parcial único no DB)
        isAcquisition: d.isAcquisition,  // #1/#3 marca a aquisição
        phone,
        source: attr?.source || 'unknown',
        attributionMethod: attr?.method || null,
        adId: attr?.adId || null,
        campaign: attr?.campaign || null,
        value,
        eventTime,
        gclid: d.gclid,
        fbc: d.fbc,
        ttclid: d.ttclid,
        meta: d.meta,
        google: d.google,
        tiktok: d.tiktok,
        done: d.done,
      };

      if (isDryRun()) {
        console.log(`${TAG} [DRY] ${appt._id} first=${first} source=${doc.source} value=${value} meta=${doc.meta.status} google=${doc.google.status} tiktok=${doc.tiktok.status}`);
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
        { $set: { source: attr.source, attributionMethod: attr.method || null, adId: attr.adId || null, campaign: attr.campaign || null, ...(attr.gclid ? { gclid: attr.gclid } : {}), ...(attr.fbclid ? { fbc: buildFbc(attr) } : {}), ...(attr.ttclid ? { ttclid: attr.ttclid } : {}) } }
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

      // ttclid chegou depois: reabre SÓ o envio ao TikTok, dentro da janela de 7 dias
      if (res.modifiedCount && attr.ttclid) {
        await AdConversion.updateOne(
          {
            _id: u._id,
            'tiktok.status': 'skipped',
            'tiktok.reason': { $in: ['sem_ttclid', 'sem_identificador'] },
            eventTime: { $gte: new Date(Date.now() - 6.5 * 864e5) },
          },
          { $set: { 'tiktok.status': 'pending', done: false, nextAttemptAt: new Date() } }
        );
      }
    } catch (err) {
      console.error(`${TAG} ❌ refresh ${u._id}:`, err.message);
    }
  }
  return updated;
}

// ─── Recupera aquisições sem telefone: o número pode aparecer DEPOIS do enqueue ──────
// #3 Atualiza o MESMO documento (nunca insere) — por isso o índice único por paciente
// jamais bloqueia a recuperação de uma aquisição pendente/falha.
async function recoverMissingPhone() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
  const stuck = await AdConversion.find({
    phone: null,
    isAcquisition: true,
    'meta.reason': 'sem_telefone',
    createdAt: { $gte: since },
  }).limit(100);

  let recovered = 0;
  for (const conv of stuck) {
    try {
      const appt = await Appointment.findById(conv.appointment)
        .select('patient patientInfo.phone createdAt').lean();
      if (!appt) continue;
      const phone = await resolvePhone(appt);
      if (!phone) continue; // ainda sem telefone válido: segue aguardando, sem bloquear nada

      const attr = await getAttributionByPhone(phone);
      const within = Date.now() - new Date(conv.eventTime).getTime() < 6.5 * 864e5;
      conv.phone = phone;
      if (attr?.source) { conv.source = attr.source; conv.attributionMethod = attr.method || null; conv.adId = attr.adId || null; conv.campaign = attr.campaign || null; }
      if (attr?.gclid) conv.gclid = attr.gclid;
      if (attr?.fbclid) conv.fbc = buildFbc(attr);
      if (attr?.ttclid) conv.ttclid = attr.ttclid;
      conv.meta = within ? { status: 'pending' } : { status: 'skipped', reason: 'fora_janela_7d_meta' };
      if (conv.tiktok?.reason === 'sem_identificador') {
        conv.tiktok = within ? { status: 'pending' } : { status: 'skipped', reason: 'fora_janela_7d_tiktok' };
      }
      conv.done = false;
      conv.nextAttemptAt = new Date();
      await conv.save();
      recovered++;
    } catch (err) {
      console.error(`${TAG} ❌ recover ${conv._id}:`, err.message);
    }
  }
  return recovered;
}

// ─── Etapa 2: envia pendentes com retry/backoff ─────────────────────────────
async function processPending() {
  // #3 Reserva ATÔMICA: cada iteração reivindica 1 pendente via findOneAndUpdate (lease que
  // empurra nextAttemptAt p/ frente). Dois workers concorrentes nunca pegam/postam o mesmo doc;
  // se um cair após reservar, o lease expira e outro reprocessa (recuperação após falha).
  let sent = 0, processed = 0;
  while (processed < 50) {
    const claim = buildPendingClaim();
    const conv = await AdConversion.findOneAndUpdate(claim.filter, claim.update, claim.options);
    if (!conv) break;
    processed++;
    let retry = false;

    if (conv.meta?.status === 'pending' || conv.meta?.status === 'failed') {
      try {
        const eventTime = conv.eventTime; // já filtrado na janela de 7 dias no enqueue
        const r = await sendPurchaseToMeta({
          phone: conv.phone,
          fbc: conv.fbc,
          value: conv.value,
          eventId: eventIdFor(conv.appointment),
          eventTime,
          actionSource: 'physical_store', // atendimento na clínica
          customData: { lead_source: conv.source },
        });
        // #4 Interpreta a resposta: events_received>=1 = aceito; 0/ausente = recusado (NÃO sucesso).
        const res = interpretMetaResponse(r, { pixel: process.env.META_PIXEL_ID || null, event: 'Purchase', actionSource: 'physical_store' });
        conv.meta = {
          status: res.status,
          sentAt: res.status === 'sent' ? new Date() : null,
          reason: res.reason || null,
          eventsReceived: res.eventsReceived ?? null,
          trace: res.trace || null,
          pixel: res.pixel || null,
          event: res.event || null,
          actionSource: res.actionSource || null,
        };
        if (res.status === 'sent') sent++;
        if (res.status === 'failed' && res.retryable) retry = true;
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

    // TikTok Events API — envio por ttclid (janela de 7 dias garantida no enqueue)
    if (conv.tiktok?.status === 'pending' || conv.tiktok?.status === 'failed') {
      try {
        const r = await sendEventToTikTok({
          phone: conv.phone,
          ttclid: conv.ttclid,
          value: conv.value,
          eventId: eventIdFor(conv.appointment),
          eventTime: conv.eventTime,
          customData: { content_name: conv.source },
        });
        // #4/#5 code:0 = aceito; null = não configurado/sem id. code!=0 lança (tratado no catch).
        const res = interpretTiktokResponse(r, { pixel: process.env.TIKTOK_PIXEL_ID || null });
        conv.tiktok = {
          status: res.status,
          sentAt: res.status === 'sent' ? new Date() : null,
          reason: res.reason || null,
          code: res.code ?? null,
          trace: res.trace || null,
          pixel: res.pixel || null,
        };
        if (res.status === 'sent') sent++;
        if (res.status === 'failed' && res.retryable) retry = true;
      } catch (err) {
        conv.tiktok = { status: 'failed', reason: String(err?.response?.data?.message || err.message).slice(0, 300) };
        retry = true;
      }
    }

    conv.attempts += 1;
    if (retry && conv.attempts < MAX_ATTEMPTS) {
      conv.nextAttemptAt = new Date(Date.now() + 2 ** conv.attempts * 10 * 60 * 1000); // 20m, 40m, 80m, 160m
    } else {
      conv.done = true;
    }
    await conv.save();
    console.log(`${TAG} ${conv.appointment} source=${conv.source} meta=${conv.meta.status} google=${conv.google.status} tiktok=${conv.tiktok?.status || '-'} tentativa=${conv.attempts}`);
  }
  return sent;
}

async function runOnce() {
  if (isRunning) return;
  isRunning = true;
  const t0 = Date.now();
  try {
    const queued = await enqueueNew();
    const recovered = isDryRun() ? 0 : await recoverMissingPhone();
    const reclassified = isDryRun() ? 0 : await refreshUnknownSources();
    const sent = isDryRun() ? 0 : await processPending();
    if (queued || sent || reclassified || recovered) console.log(`${TAG} ✅ novos=${queued} recuperados=${recovered} reclassificados=${reclassified} enviados=${sent} em ${Date.now() - t0}ms`);
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

export { runOnce as runAdsConversionOnce, enqueueNew, processPending, refreshUnknownSources, recoverMissingPhone, isAcquisitionAppointment, resolvePhone };
export default { initAdsConversionCron };
