/**
 * Pedido de AVALIAÇÃO no Google (WhatsApp) após sessão concluída.
 *
 * Espelha o padrão de cancellationNotification.service.js:
 *  - Enfileira em `whatsapp-send` (mesma fila/worker já usados), com DELAY (padrão 3h) para a
 *    mensagem chegar quando a família já saiu — experiência fresca, sem parecer robótico.
 *  - Só dispara em sessão REALMENTE concluída (operationalStatus === 'completed'). Falta/cancelado nunca.
 *  - Anti-spam por PACIENTE: não pede de novo se já pediu nos últimos N dias (padrão 90).
 *    Reutiliza o campo `reviewRequestSentAt` que já existe no Appointment — sem mexer no schema.
 *  - Sem link configurado (GOOGLE_REVIEW_URL) → não envia nada (evita mensagem quebrada).
 *  - Claim atômico + jobId determinístico → nunca duplica o pedido para o mesmo atendimento.
 *  - Fire-and-forget no chamador: qualquer falha aqui NÃO afeta a conclusão da sessão.
 *
 * Env:
 *   GOOGLE_REVIEW_URL          (obrigatório p/ enviar) — shortlink/▸writereview do Perfil da Empresa
 *   REVIEW_REQUEST_DELAY_MS    (opcional, default 10800000 = 3h)
 *   REVIEW_REQUEST_DEDUPE_DAYS (opcional, default 90)
 */

import Appointment from '../../models/Appointment.js';
import { whatsappSendQueue } from '../../config/bullConfig.js';
import { sanitizePhoneBeforeSend } from '../../utils/phone.js';

export function buildReviewRequestMessage({ patientName, reviewUrl } = {}) {
  const first = String(patientName || '').trim().split(/\s+/)[0];
  const lines = [
    first
      ? `Oi! Foi um prazer cuidar do(a) *${first}* hoje na Clínica Fono Inova 😊`
      : 'Oi! Foi um prazer receber vocês hoje na Clínica Fono Inova 😊',
    '',
    `Se puder, deixe uma avaliação rápida do atendimento aqui 👉 ${reviewUrl}`,
    'Leva 1 minutinho e ajuda muito outras famílias de Anápolis a encontrarem a gente. 💚',
  ];
  return lines.join('\n');
}

/**
 * @returns {Promise<{status:'queued'|'already_requested'|'deduped'|'no_phone'|'no_link'|'not_completed'|'opted_out'|'not_found'|'failed', jobId?:string, error?:string}>}
 */
export async function requestReviewNotification(appointmentId, { queue = whatsappSendQueue, delayMs } = {}) {
  const reviewUrl = (process.env.GOOGLE_REVIEW_URL || '').trim();
  if (!reviewUrl) {
    console.warn('[review] GOOGLE_REVIEW_URL não definido — pulando pedido de avaliação.');
    return { status: 'no_link' };
  }

  const appt = await Appointment.findById(appointmentId)
    .select('operationalStatus patient reviewRequestSentAt')
    .populate('patient', 'fullName phone reviewOptOut')
    .lean();

  if (!appt) return { status: 'not_found' };
  if (appt.operationalStatus !== 'completed') return { status: 'not_completed' };
  if (appt.reviewRequestSentAt) return { status: 'already_requested' };
  // Familia ja avaliou no Google (secretaria marcou) -> nao pede de novo.
  if (appt.patient?.reviewOptOut) return { status: 'opted_out' };

  // Anti-spam por paciente: já pediu avaliação nos últimos N dias? Então não pede de novo.
  const patientId = appt.patient?._id;
  const janelaDias = Number(process.env.REVIEW_REQUEST_DEDUPE_DAYS) || 90;
  const corte = new Date(Date.now() - janelaDias * 24 * 60 * 60 * 1000);
  if (patientId && (await Appointment.exists({ patient: patientId, reviewRequestSentAt: { $gte: corte } }))) {
    return { status: 'deduped' };
  }

  const phone = sanitizePhoneBeforeSend(appt.patient?.phone);
  if (!phone.success) return { status: 'no_phone' };

  const jobId = `review-notify-${appointmentId}`;

  // Claim atômico: marca reviewRequestSentAt só se ainda não marcado (evita corrida/duplicata).
  const claimed = await Appointment.updateOne(
    { _id: appointmentId, operationalStatus: 'completed', reviewRequestSentAt: null },
    { $set: { reviewRequestSentAt: new Date() } }
  );
  if (!claimed.modifiedCount) return { status: 'already_requested' };

  const delay = Number.isFinite(delayMs)
    ? delayMs
    : (Number(process.env.REVIEW_REQUEST_DELAY_MS) || 3 * 60 * 60 * 1000);

  try {
    await queue.add(
      'send-message',
      {
        phone: phone.phone,
        message: buildReviewRequestMessage({ patientName: appt.patient?.fullName, reviewUrl }),
      },
      { jobId, delay }
    );
    return { status: 'queued', jobId };
  } catch (err) {
    // Não enfileirou: devolve a vez (desmarca) para permitir nova tentativa.
    await Appointment.updateOne({ _id: appointmentId }, { $unset: { reviewRequestSentAt: 1 } });
    return { status: 'failed', error: String(err?.message || err) };
  }
}

export default { requestReviewNotification, buildReviewRequestMessage };
