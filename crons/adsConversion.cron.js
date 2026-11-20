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
//   GOOGLE_ADS_CONVERSION_ACTION_ID   id da ação "Avaliação agendada" (a mesma do feed google-offline.csv)
//   GOOGLE_ADS_EVAL_DONE_ACTION_ID    id da ação SEPARADA "Avaliação realizada" (sem ele: desligado)
//   TIKTOK_EVENTS_TOKEN               Access Token da TikTok Events API (envio por ttclid)
//   ADS_CONVERSION_PRE_AGENDADO=false desliga a conversão do pré-agendamento real (default: ligado, 19/11)
// Nunca envia dado clínico: só telefone (hash), valor, id e origem.
// Doc: back/docs/ADS_CONVERSION_CONTRACT.md

import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import AdConversion from '../models/AdConversion.js';
import { getAttributionByPhone, getAttributionsByPhones, findGclidForConversion } from '../services/leadAttributionService.js';
import { sendPurchaseToMeta } from '../services/metaConversionsService.js';
import { uploadOfflineConversion } from '../services/googleAdsConversionsService.js';
import { sendEventToTikTok } from '../services/tiktokConversionsService.js';
import { phoneFormatsOf } from '../services/attribution/revenueAttribution.js';
import {
  resolveMainPhone, decidePlatforms,
  isConversionCandidate, conversionStatusFilter, isPreAgendamentoEnabled,
  interpretMetaResponse, interpretTiktokResponse, buildFbc,
  resolveConversionTime, shouldAcquire, eventIdFor, buildPendingClaim,
  unknownReasonFor, metaSendOptions, shouldReopenMetaForClid,
  sharedPhoneGuardEnabled, attributionEvidenceOf, withoutClickIds,
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
  }).select('_id operationalStatus insurancePlan liminarContract therapeuticPlan package billingType serviceType metadata.origin.source').lean();
  if (!earlier.length) return true;
  const earlierConverted = !!(await AdConversion.exists({ appointment: { $in: earlier.map(e => e._id) } }));
  // 19/11: um pré-agendamento real anterior também é âncora (ele é a aquisição, não este).
  const includePreAgendamento = isPreAgendamentoEnabled();
  const earlierEligibleExists = earlier.some(e => isConversionCandidate(e, { includePreAgendamento }));
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

// Correção 3: o telefone já é de OUTRO paciente com aquisição? Consultas com índice:
// Patient.phone (todas as grafias) e AdConversion (índice parcial 1 aquisição por paciente).
async function phoneHasOtherAcquisition(phone, patientId) {
  if (!phone) return false;
  const others = await Patient.find({ phone: { $in: phoneFormatsOf(phone) }, ...(patientId ? { _id: { $ne: patientId } } : {}) })
    .select('_id').limit(20).lean();
  if (!others.length) return false;
  return Boolean(await AdConversion.exists({ patient: { $in: others.map((o) => o._id), $type: 'objectId' }, isAcquisition: true }));
}

// 18/11: a atribuição por telefone devolve a 1ª origem (first-touch), que muitas vezes não tem
// gclid. Sem gclid a conversão nunca entrava no google-offline.csv e ficava "unknown".
// Busca o gclid no Lead do agendamento/telefone e, se vazio, na LeadAttribution mais recente.
async function withGclidFallback({ leadId, phone, attr }) {
  if (attr?.gclid || (!leadId && !phone)) return attr;
  const found = await findGclidForConversion({ leadId, phone });
  if (!found) return attr;
  const base = attr || {};
  const unknown = !base.source || base.source === 'unknown';
  return {
    ...base,
    gclid: found.gclid,
    source: unknown ? 'google_ads' : base.source,
    method: unknown ? found.method : base.method,
    campaign: base.campaign || found.campaign || null,
  };
}

// ─── Etapa 1: registra agendamentos novos na fila (AdConversion) ─────────────
async function enqueueNew() {
  const now = Date.now();
  const windowStart = new Date(now - LOOKBACK_DAYS * 864e5);
  const includePreAgendamento = isPreAgendamentoEnabled();
  const candidates = await Appointment.find({
    $and: [
      // #2 agendamento real (booked) + pré-agendamento REAL (19/11); projeção do sistema fica fora
      conversionStatusFilter({ includePreAgendamento }),
      // #5 Confirmação tardia: um pre_agendado antigo que vira scheduled DEPOIS de 30 dias tem
      // createdAt fora da janela, mas updatedAt recente. Aceitar createdAt OU updatedAt impede
      // que ele desapareça do processamento (o envio ainda respeita a janela de 7d por plataforma).
      { $or: [{ createdAt: { $gte: windowStart } }, { updatedAt: { $gte: windowStart } }] },
    ],
    createdAt: { $lte: new Date(now - MIN_AGE_MS) }, // espera 15 min mesmo em confirmação tardia
  })
    .select('_id patient lead patientInfo.phone createdAt updatedAt history sessionValue isFirstAppointment patientJourneyType operationalStatus insurancePlan liminarContract therapeuticPlan package billingType serviceType metadata.origin.source')
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
      // 18/11: telefone e origem também para quem NÃO é 1º agendamento. Antes ficavam null e a conversão
      // nascia "Não identificado" para sempre (o refresh só olha quem tem telefone). Os envios continuam
      // pulados (decidePlatforms com first=false não devolve gclid/fbc/ttclid/clid).
      const phone = await resolvePhone(appt);
      const attrByPhone = phone ? await getAttributionByPhone(phone) : null;
      const attr = first ? await withGclidFallback({ leadId: appt.lead || null, phone, attr: attrByPhone }) : attrByPhone;
      const value = Number(appt.sessionValue) > 0 ? Number(appt.sessionValue) : defaultValue();

      // #2 event_time = data COMPROVADA em que o agendamento virou conversão (transição no
      // histórico p/ status booked); sem evidência, cai para createdAt. Nunca updatedAt genérico.
      // 19/11: pré-agendamento real converte na criação (createdAt), não na confirmação.
      const eventTime = resolveConversionTime(appt, { includePreAgendamento });
      let d = decidePlatforms({ first, phone, attr, eventTimeMs: eventTime.getTime() });
      const shared = d.isAcquisition ? await phoneHasOtherAcquisition(phone, appt.patient) : false;
      if (shared && sharedPhoneGuardEnabled()) {
        d = withoutClickIds({ first, phone, attr, eventTimeMs: eventTime.getTime() });
      }
      const doc = {
        appointment: appt._id,
        patient: appt.patient || null,   // #3 dedupe por paciente (índice parcial único no DB)
        isAcquisition: d.isAcquisition,  // #1/#3 marca a aquisição
        phone,
        source: attr?.source || 'unknown',
        unknownReason: unknownReasonFor({ phone, attr }),
        attributionMethod: attr?.method || null,
        adId: attr?.adId || null,
        campaign: attr?.campaign || null,
        value,
        eventTime,
        gclid: d.gclid,
        fbc: d.fbc,
        ttclid: d.ttclid,
        ctwaClid: d.ctwaClid || null,
        attributionEvidence: d.isAcquisition
          ? attributionEvidenceOf({ source: attr?.source, method: attr?.method, gclid: d.gclid, fbc: d.fbc, ttclid: d.ttclid, ctwaClid: d.ctwaClid, shared })
          : null,
        meta: d.meta,
        google: d.google,
        tiktok: d.tiktok,
        done: d.done,
      };

      if (isDryRun()) {
        console.log(`${TAG} [DRY] ${appt._id} first=${first} source=${doc.source} value=${value} meta=${doc.meta.status} google=${doc.google.status} tiktok=${doc.tiktok.status}`);
        continue;
      }

      try {
        await AdConversion.create(doc);
      } catch (err) {
        // 11/11: colisão no índice "1 aquisição por paciente" era engolida em silêncio e o
        // agendamento voltava a ser processado (com telefone + origem) a cada 10 min, para sempre.
        // Já existe a aquisição do paciente → grava este como não-aquisição (idempotente por appointment).
        if (err?.code !== 11000 || !err?.keyPattern?.patient) throw err;
        const skip = decidePlatforms({ first: false });
        await AdConversion.create({ ...doc, ...skip, gclid: null, fbc: null, ttclid: null, ctwaClid: null });
      }
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
  }).select('_id phone patient isAcquisition meta eventTime unknownReason').limit(300).lean();

  if (!unknown.length) return 0;

  // 11/11: antes era 1 getAttributionByPhone (2 consultas) por doc, em série, a cada 10 min —
  // até 300 docs, o mesmo telefone repetido várias vezes, ~1 min de banco ocupado e o log
  // inundado de "📞 [PHONE]". Agora: 2 consultas no total; só desce para o laço quem ganhou origem.
  const attrByPhone = await getAttributionsByPhones(unknown.map((u) => u.phone));

  let updated = 0;
  for (const u of unknown) {
    try {
      const attr = attrByPhone.get(u.phone);
      if (!attr?.source) {
        if (!u.unknownReason) await AdConversion.updateOne({ _id: u._id, unknownReason: null }, { $set: { unknownReason: 'sem_origem_capturada' } });
        continue;
      }
      // 18/11: identificadores de clique só na AQUISIÇÃO. O google-offline.csv lista toda AdConversion
      // com gclid, então gravar gclid em retorno de paciente antigo criaria conversão falsa no Google.
      const shared = u.isAcquisition ? await phoneHasOtherAcquisition(u.phone, u.patient) : false;
      const guard = shared && sharedPhoneGuardEnabled();
      const ids = u.isAcquisition && !guard ? {
        ...(attr.gclid ? { gclid: attr.gclid } : {}),
        ...(attr.fbclid ? { fbc: buildFbc(attr) } : {}),
        ...(attr.ttclid ? { ttclid: attr.ttclid } : {}),
        ...(attr.ctwaClid ? { ctwaClid: attr.ctwaClid } : {}),
      } : {};
      const res = await AdConversion.updateOne(
        { _id: u._id, source: 'unknown' },
        { $set: { source: attr.source, unknownReason: null, attributionMethod: attr.method || null, adId: attr.adId || null, campaign: attr.campaign || null, ...ids,
          attributionEvidence: u.isAcquisition ? attributionEvidenceOf({ source: attr.source, method: attr.method, ...ids, shared }) : null } }
      );
      updated += res.modifiedCount || 0;

      // ctwa_clid chegou depois: reabre SÓ a Meta, se ela foi pulada por falta de identificador (7 dias)
      if (res.modifiedCount && ids.ctwaClid && shouldReopenMetaForClid(u)) {
        await AdConversion.updateOne(
          { _id: u._id, 'meta.status': 'skipped', 'meta.reason': 'sem_telefone' },
          { $set: { meta: { status: 'pending' }, done: false, nextAttemptAt: new Date() } }
        );
        console.log(`${TAG} 🔁 ${u._id} ganhou ctwa_clid: Meta reaberta`);
      }

      // gclid chegou depois: reabre SÓ o envio ao Google (meta intocado), dentro de 90 dias
      if (res.modifiedCount && ids.gclid) {
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
      if (res.modifiedCount && ids.ttclid) {
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

// ─── 18/11: conversão com origem Meta mas sem ctwa_clid: o clid pode ser capturado DEPOIS ───
// (a captura antiga nunca salvava o clid). Completa o clid e reabre a Meta só se ela foi pulada por
// falta de identificador. O que já foi aceito (sent) não é reenviado.
async function fillMissingCtwaClid() {
  const conv = await AdConversion.find({
    isAcquisition: true,
    ctwaClid: null,
    phone: { $ne: null },
    source: { $in: ['meta_ads', 'instagram_ads'] },
    eventTime: { $gte: new Date(Date.now() - 6.5 * 864e5) },
  }).select('_id phone isAcquisition meta eventTime').limit(100).lean();
  if (!conv.length) return 0;
  const attrByPhone = await getAttributionsByPhones(conv.map((c) => c.phone));
  let filled = 0;
  for (const c of conv) {
    try {
      const clid = attrByPhone.get(c.phone)?.ctwaClid;
      if (!clid) continue;
      const res = await AdConversion.updateOne({ _id: c._id, ctwaClid: null }, { $set: { ctwaClid: clid } });
      if (!res.modifiedCount) continue;
      filled++;
      if (shouldReopenMetaForClid(c)) {
        await AdConversion.updateOne(
          { _id: c._id, 'meta.status': 'skipped', 'meta.reason': 'sem_telefone' },
          { $set: { meta: { status: 'pending' }, done: false, nextAttemptAt: new Date() } }
        );
      }
    } catch (err) {
      console.error(`${TAG} ❌ ctwa_clid ${c._id}:`, err.message);
    }
  }
  if (filled) console.log(`${TAG} 🔗 ctwa_clid completado em ${filled} conversões`);
  return filled;
}

// ─── 18/11: conversões sem telefone que NÃO são aquisição (retorno de paciente) ─────────────
// O enqueue antigo nem buscava telefone para elas, então ficavam "Não identificado" para sempre.
// Só preenche telefone/origem para relatório; os envios continuam pulados (nao_e_primeiro_agendamento).
async function fillPhoneForNonAcquisition() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
  const docs = await AdConversion.find({
    phone: null, isAcquisition: false, source: 'unknown', unknownReason: null, createdAt: { $gte: since },
  }).select('_id appointment').limit(100).lean();
  let filled = 0;
  for (const d of docs) {
    try {
      const appt = await Appointment.findById(d.appointment).select('patient patientInfo.phone').lean();
      const phone = appt ? await resolvePhone(appt) : null;
      if (!phone) {
        await AdConversion.updateOne({ _id: d._id, unknownReason: null }, { $set: { unknownReason: 'sem_telefone' } });
        continue;
      }
      const res = await AdConversion.updateOne({ _id: d._id, phone: null }, { $set: { phone } });
      filled += res.modifiedCount || 0;
    } catch (err) {
      console.error(`${TAG} ❌ telefone ${d._id}:`, err.message);
    }
  }
  return filled;
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
        .select('patient lead patientInfo.phone createdAt').lean();
      if (!appt) continue;
      const phone = await resolvePhone(appt);
      if (!phone) continue; // ainda sem telefone válido: segue aguardando, sem bloquear nada

      const attr = await withGclidFallback({ leadId: appt.lead || null, phone, attr: await getAttributionByPhone(phone) });
      const within = Date.now() - new Date(conv.eventTime).getTime() < 6.5 * 864e5;
      conv.phone = phone;
      if (attr?.source) { conv.source = attr.source; conv.attributionMethod = attr.method || null; conv.adId = attr.adId || null; conv.campaign = attr.campaign || null; }
      if (attr?.gclid) {
        conv.gclid = attr.gclid;
        if (conv.google?.status === 'skipped' && conv.google?.reason === 'sem_gclid') conv.google = { status: 'pending' };
      }
      if (attr?.fbclid) conv.fbc = buildFbc(attr);
      if (attr?.ttclid) conv.ttclid = attr.ttclid;
      if (attr?.ctwaClid) conv.ctwaClid = attr.ctwaClid;
      if (attr?.source) conv.unknownReason = null;
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
        // 18/11: com ctwa_clid vai como business_messaging/whatsapp (liga ao anúncio); sem, website (clínica).
        const opt = metaSendOptions(conv);
        const r = await sendPurchaseToMeta({
          phone: conv.phone,
          fbc: conv.fbc,
          value: conv.value,
          eventId: eventIdFor(conv.appointment),
          eventTime,
          actionSource: opt.actionSource,
          messagingChannel: opt.messagingChannel,
          ctwaClid: opt.ctwaClid,
          customData: { lead_source: conv.source },
        });
        // #4 Interpreta a resposta: events_received>=1 = aceito; 0/ausente = recusado (NÃO sucesso).
        const pixel = (opt.ctwaClid && process.env.META_BM_DATASET_ID) || process.env.META_PIXEL_ID || null;
        const res = interpretMetaResponse(r, { pixel, event: 'Purchase', actionSource: opt.actionSource });
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
        gclid: conv.gclid, value: conv.value, eventTime: conv.eventTime,
        // Mesmo id do feed CSV (transaction_id = appt_<id>): se API e CSV estiverem ligados, o Google deduplica.
        orderId: `appt_${conv.appointment}`, kind: 'scheduled',
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
    const phonesFilled = isDryRun() ? 0 : await fillPhoneForNonAcquisition();
    const reclassified = isDryRun() ? 0 : await refreshUnknownSources();
    const clidFilled = isDryRun() ? 0 : await fillMissingCtwaClid();
    const sent = isDryRun() ? 0 : await processPending();
    if (queued || sent || reclassified || recovered || phonesFilled || clidFilled) console.log(`${TAG} ✅ novos=${queued} recuperados=${recovered} telefones=${phonesFilled} reclassificados=${reclassified} clid=${clidFilled} enviados=${sent} em ${Date.now() - t0}ms`);
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

export { runOnce as runAdsConversionOnce, phoneHasOtherAcquisition, withGclidFallback, enqueueNew, processPending, refreshUnknownSources, recoverMissingPhone, fillMissingCtwaClid, fillPhoneForNonAcquisition, isAcquisitionAppointment, resolvePhone };
export default { initAdsConversionCron };
