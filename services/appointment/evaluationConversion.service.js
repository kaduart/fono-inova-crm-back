/**
 * Conversão OFFLINE no Google Ads quando uma AVALIAÇÃO é concluída.
 *
 * Liga as peças que já existiam soltas no CRM:
 *  - Sinal: Appointment serviceType 'evaluation'/'neuropsych_evaluation' + operationalStatus 'completed'.
 *  - Atribuição: getAttributionByPhone(phone) -> gclid (do Lead.metaTracking.gclid).
 *  - Envio: uploadOfflineConversion({ gclid, value, eventTime, orderId }).
 *
 * É por isso que a conversão "Avaliação agendada/realizada" ficava em 0: ninguém chamava o upload.
 *
 * Fire-and-forget no chamador: qualquer falha aqui NUNCA afeta a conclusão do atendimento.
 * Inerte até os env GOOGLE_ADS_* + GOOGLE_ADS_CONVERSION_ACTION_ID estarem definidos
 * (sem config, uploadOfflineConversion retorna { skipped } sem quebrar nada).
 */

import Appointment from '../../models/Appointment.js';
import AdConversion from '../../models/AdConversion.js';
import { getAttributionByPhone } from '../leadAttributionService.js';
import { uploadOfflineConversion } from '../googleAdsConversionsService.js';

// Correção 5 (20/11): mesmo telefone principal e mesmo fallback de gclid do cron de conversões.
// Import tardio: o cron puxa os serviços de Meta/TikTok, que este caminho não precisa carregar antes.
async function cronHelpers() {
  const m = await import('../../crons/adsConversion.cron.js');
  return { resolvePhone: m.resolvePhone, withGclidFallback: m.withGclidFallback };
}

// Grava o resultado no documento de conversão do MESMO agendamento, se existir (não cria:
// criar aqui tiraria o agendamento da fila do cron). Nunca lança.
async function recordEvalDone(appointmentId, result, gclid) {
  if (!['sent', 'skipped', 'failed'].includes(result?.status)) return;
  try {
    await AdConversion.updateOne({ appointment: appointmentId }, { $set: { evalDone: {
      status: result.status, reason: result.reason || null, sentAt: result.status === 'sent' ? new Date() : null,
      at: new Date(), gclid: gclid || null,
    } } });
  } catch (err) {
    console.warn('[EvalConversion] não gravou evalDone:', err.message);
  }
}

const EVALUATION_TYPES = ['evaluation', 'neuropsych_evaluation'];

/**
 * @returns {Promise<{status:'sent'|'skipped'|'failed'|'not_found'|'not_evaluation'|'not_completed'|'no_phone'|'no_gclid', reason?:string}>}
 */
export async function reportEvaluationConversion(appointmentId, deps = {}) {
  const appt = await Appointment.findById(appointmentId)
    .select('serviceType operationalStatus sessionValue date patient lead patientInfo.phone')
    .lean();

  if (!appt) return { status: 'not_found' };
  if (!EVALUATION_TYPES.includes(appt.serviceType)) return { status: 'not_evaluation' };
  if (appt.operationalStatus !== 'completed') return { status: 'not_completed' };

  const { resolvePhone, withGclidFallback } = deps.resolvePhone ? deps : await cronHelpers();
  const phone = await resolvePhone(appt);
  if (!phone) {
    await recordEvalDone(appointmentId, { status: 'skipped', reason: 'sem_telefone' });
    return { status: 'no_phone' };
  }

  // Só quem veio do Google Ads tem gclid; os demais são pulados (skipped) sem erro.
  const byPhone = await (deps.getAttributionByPhone || getAttributionByPhone)(phone);
  const attr = await withGclidFallback({ leadId: appt.lead || null, phone, attr: byPhone });
  const gclid = attr?.gclid;
  if (!gclid) {
    await recordEvalDone(appointmentId, { status: 'skipped', reason: 'sem_gclid' });
    return { status: 'no_gclid' };
  }

  const value = Number(appt.sessionValue) || 220; // valor da avaliação (fallback R$220)

  const result = await (deps.uploadOfflineConversion || uploadOfflineConversion)({
    gclid,
    value,
    eventTime: appt.date || new Date(),
    // Contrato ADS_CONVERSION (PR #54): o prefixo 'aval-' faz o resolveConversionAction rotear
    // para a ação SEPARADA "Avaliação realizada" (GOOGLE_ADS_EVAL_DONE_ACTION_ID), nunca para a
    // "Avaliação agendada". Sem esse env => skipped. Não trocar o prefixo. (orderId dedupe no Google.)
    orderId: `aval-${appointmentId}`,
  });
  await recordEvalDone(appointmentId, result, gclid);
  return result;
}

export default { reportEvaluationConversion };
