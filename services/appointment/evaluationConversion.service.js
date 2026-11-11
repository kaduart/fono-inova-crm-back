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
import { getAttributionByPhone } from '../leadAttributionService.js';
import { uploadOfflineConversion } from '../googleAdsConversionsService.js';

const EVALUATION_TYPES = ['evaluation', 'neuropsych_evaluation'];

/**
 * @returns {Promise<{status:'sent'|'skipped'|'failed'|'not_found'|'not_evaluation'|'not_completed'|'no_phone'|'no_gclid', reason?:string}>}
 */
export async function reportEvaluationConversion(appointmentId) {
  const appt = await Appointment.findById(appointmentId)
    .select('serviceType operationalStatus sessionValue date patient')
    .populate('patient', 'phone')
    .lean();

  if (!appt) return { status: 'not_found' };
  if (!EVALUATION_TYPES.includes(appt.serviceType)) return { status: 'not_evaluation' };
  if (appt.operationalStatus !== 'completed') return { status: 'not_completed' };

  const phone = appt.patient?.phone;
  if (!phone) return { status: 'no_phone' };

  // Só quem veio do Google Ads tem gclid; os demais são pulados (skipped) sem erro.
  const attr = await getAttributionByPhone(phone);
  const gclid = attr?.gclid;
  if (!gclid) return { status: 'no_gclid' };

  const value = Number(appt.sessionValue) || 220; // valor da avaliação (fallback R$220)

  return uploadOfflineConversion({
    gclid,
    value,
    eventTime: appt.date || new Date(),
    orderId: `aval-${appointmentId}`, // dedupe no lado do Google (1 conversão por avaliação)
  });
}

export default { reportEvaluationConversion };
