// services/attribution/attributionHealth.js
// Saúde da integração de conversões, por DESTINO, lida só do AdConversion (somente leitura).
// Não chama nenhuma plataforma: os destinos são "simulados" no sentido de que aqui só se lê o
// estado que o cron (crons/adsConversion.cron.js) já gravou. Nada é enviado nem gravado.
//
// Destinos:
//   meta       → subdoc AdConversion.meta   (Meta CAPI)
//   google_api → subdoc AdConversion.google (upload offline pela API do Google Ads)
//   tiktok     → subdoc AdConversion.tiktok (TikTok Events API)
//   google_csv → feed GET /api/ads-feed/google-offline.csv (routes/adsFeed.js): lista TODA
//                AdConversion com gclid e eventTime nos últimos 60 dias. O CRM não tem prova de
//                importação do CSV pelo Google: "no feed" ≠ "importado".
//
// Reaproveita summarizeDelivery (routes/analytics/funnel.logic.js) para as contagens de
// enviado com prova / enviado sem prova (histórico) / ignorado / falha / pendente / inconsistente.

import { summarizeDelivery } from '../../routes/analytics/funnel.logic.js';

export const GOOGLE_CSV_WINDOW_DAYS = 60; // mesmo corte de routes/adsFeed.js
const SUBDOC = { meta: 'meta', google_api: 'google', tiktok: 'tiktok' };

const ts = (d) => (d ? new Date(d).getTime() : null);

/**
 * @param {Array} docs        AdConversion (lean) do período: meta google tiktok done gclid eventTime isAcquisition source unknownReason createdAt
 * @param {Array} pendingDocs AdConversion (lean) com algum destino 'pending' (qualquer data) — para a idade do pendente mais antigo
 * @param {number} now
 */
export function buildAttributionHealth({ docs = [], pendingDocs = [], now = Date.now() } = {}) {
  const delivery = summarizeDelivery(docs);
  const destinos = {};

  for (const [dest, sub] of Object.entries(SUBDOC)) {
    const d = delivery[sub];
    const skippedReasons = {};
    const failedReasons = {};
    for (const doc of docs) {
      const pf = doc?.[sub];
      if (!pf?.status) continue;
      const r = pf.reason || 'sem_motivo';
      if (pf.status === 'skipped') skippedReasons[r] = (skippedReasons[r] || 0) + 1;
      if (pf.status === 'failed') failedReasons[r] = (failedReasons[r] || 0) + 1;
    }
    let oldest = null;
    let pendentesTotal = 0;
    for (const doc of pendingDocs) {
      if (doc?.[sub]?.status !== 'pending' || doc.done) continue;
      pendentesTotal += 1;
      const t = ts(doc.createdAt) ?? ts(doc.eventTime);
      if (t != null && (oldest == null || t < oldest)) oldest = t;
    }
    destinos[dest] = {
      enviadoComProva: d.accepted,
      enviadoSemProvaHistorico: d.sentLegacy,
      ignorado: d.ignored,
      ignoradoPorMotivo: skippedReasons,
      falha: d.failed,
      falhaPorMotivo: failedReasons,
      pendente: d.pending,
      pendenteEmRegistroFinalizado: d.inconsistent,
      pendentesEmQualquerData: pendentesTotal,
      pendenteMaisAntigoHoras: oldest == null ? null : +((now - oldest) / 36e5).toFixed(1),
      ultimoEnvio: d.lastSentAt,
    };
  }

  // google_csv: o que o feed entregaria hoje, a partir dos docs do período
  const cutoff = now - GOOGLE_CSV_WINDOW_DAYS * 864e5;
  const csv = {
    noFeedSemProvaDeImportacao: 0, foraDaJanelaDoFeed: 0, naoAquisicaoComGclidNoFeed: 0,
    ignoradoPorMotivo: {}, ultimoEventoNoFeed: null,
  };
  for (const doc of docs) {
    if (doc.gclid) {
      const t = ts(doc.eventTime);
      if (t != null && t >= cutoff) {
        csv.noFeedSemProvaDeImportacao += 1;
        if (!doc.isAcquisition) csv.naoAquisicaoComGclidNoFeed += 1;
        if (!csv.ultimoEventoNoFeed || t > csv.ultimoEventoNoFeed) csv.ultimoEventoNoFeed = t;
      } else {
        csv.foraDaJanelaDoFeed += 1;
      }
    } else if (doc.isAcquisition) {
      csv.ignoradoPorMotivo.sem_gclid = (csv.ignoradoPorMotivo.sem_gclid || 0) + 1;
    } else {
      csv.ignoradoPorMotivo.nao_e_primeiro_agendamento = (csv.ignoradoPorMotivo.nao_e_primeiro_agendamento || 0) + 1;
    }
  }
  csv.ultimoEventoNoFeed = csv.ultimoEventoNoFeed ? new Date(csv.ultimoEventoNoFeed).toISOString() : null;
  destinos.google_csv = csv;

  // Origem não identificada (source=unknown), por unknownReason
  const origemNaoIdentificada = {};
  for (const doc of docs) {
    if (doc.source && doc.source !== 'unknown') continue;
    const r = doc.unknownReason || 'sem_motivo_gravado';
    origemNaoIdentificada[r] = (origemNaoIdentificada[r] || 0) + 1;
  }

  return { total: docs.length, destinos, origemNaoIdentificada };
}

const HEALTH_FIELDS = 'meta google tiktok done gclid eventTime isAcquisition source unknownReason createdAt';

/** Loader somente leitura. `since`/`until` filtram AdConversion.eventTime. */
export async function loadAttributionHealth({ since, until, now = Date.now(), models } = {}) {
  const AdConversion = models?.AdConversion || (await import('../../models/AdConversion.js')).default;
  const range = {};
  if (since) range.$gte = since;
  if (until) range.$lte = until;
  const filter = Object.keys(range).length ? { eventTime: range } : {};
  const [docs, pendingDocs] = await Promise.all([
    AdConversion.find(filter).select(HEALTH_FIELDS).lean(),
    AdConversion.find({ done: { $ne: true }, $or: [{ 'meta.status': 'pending' }, { 'google.status': 'pending' }, { 'tiktok.status': 'pending' }] })
      .select('meta.status google.status tiktok.status done createdAt eventTime').lean(),
  ]);
  return buildAttributionHealth({ docs, pendingDocs, now });
}
