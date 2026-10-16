/**
 * Aviso de cancelamento ao paciente/responsável (WhatsApp).
 *
 * Regras:
 *  - Só acontece quando o front pede explicitamente (`notifyPatient === true`) E depois que o
 *    cancelamento já foi salvo. Nenhum evento/worker de cancelamento envia mensagem por conta própria.
 *  - "queued" = ENFILEIRADO na fila `whatsapp-send` (WhatsApp Web da clínica). Nunca significa entregue.
 *  - Falha ao enfileirar NÃO desfaz o cancelamento: fica `failed` no agendamento e pode ser
 *    reenviada (mesma função) sem cancelar de novo.
 *  - Sem duplicidade: reivindicação atômica no próprio Appointment + jobId determinístico por
 *    cancelamento (id + canceledAt). Repetir a chamada com o aviso já enfileirado não faz nada.
 *  - O texto NÃO inclui `cancelReason`: o campo é livre e pode ser anotação interna.
 *  - Telefone: apenas `Patient.phone`. Sem telefone válido → `no_phone` (nada é enviado).
 */

import Appointment from '../../models/Appointment.js';
import { whatsappSendQueue } from '../../config/bullConfig.js';
import { sanitizePhoneBeforeSend } from '../../utils/phone.js';

export function buildCancellationMessage({ patientName, date, time, doctorName } = {}) {
  const first = String(patientName || '').trim().split(/\s+/)[0];
  const day = date
    ? new Date(date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    : null;
  const when = day ? `${day}${time ? ` às ${time}` : ''}` : null;

  const lines = [
    first ? `Olá! Informamos sobre o atendimento de *${first}*.` : 'Olá! Informamos sobre um atendimento agendado.',
    '',
    when
      ? `O atendimento de *${when}*${doctorName ? ` com *${doctorName}*` : ''} foi *cancelado*.`
      : 'O atendimento foi *cancelado*.',
    '',
    'Se quiser reagendar, é só responder esta mensagem. 💚',
    '*Clínica Fono Inova*',
  ];
  return lines.join('\n');
}

/**
 * @returns {Promise<{status: 'queued'|'already_queued'|'failed'|'no_phone'|'not_canceled'|'not_found', error?: string, jobId?: string}>}
 */
export async function requestCancellationNotification(appointmentId, { queue = whatsappSendQueue } = {}) {
  const appt = await Appointment.findById(appointmentId)
    .select('operationalStatus canceledAt date time patient doctor cancellationNotification')
    .populate('patient', 'fullName phone')
    .populate('doctor', 'fullName')
    .lean();

  if (!appt) return { status: 'not_found' };
  if (appt.operationalStatus !== 'canceled') return { status: 'not_canceled' };

  const phone = sanitizePhoneBeforeSend(appt.patient?.phone);
  if (!phone.success) {
    await Appointment.updateOne({ _id: appointmentId }, { $set: { 'cancellationNotification.status': 'no_phone' } });
    return { status: 'no_phone' };
  }

  const jobId = `cancel-notify-${appointmentId}-${new Date(appt.canceledAt || 0).getTime()}`;

  // Reivindicação atômica: só avança quem ainda não enfileirou ESTE cancelamento (ou quem está
  // reenviando uma falha). Duas chamadas simultâneas → só uma passa.
  const claimed = await Appointment.updateOne(
    {
      _id: appointmentId,
      operationalStatus: 'canceled',
      $or: [
        { 'cancellationNotification.jobId': { $ne: jobId } },
        { 'cancellationNotification.status': { $in: ['failed', 'no_phone'] } },
      ],
    },
    {
      $set: { 'cancellationNotification.status': 'queued', 'cancellationNotification.jobId': jobId, 'cancellationNotification.requestedAt': new Date(), 'cancellationNotification.error': null },
      $inc: { 'cancellationNotification.attempts': 1 },
    }
  );
  if (!claimed.modifiedCount) return { status: 'already_queued', jobId };

  try {
    await queue.add(
      'send-message',
      {
        phone: phone.phone,
        message: buildCancellationMessage({
          patientName: appt.patient?.fullName,
          date: appt.date,
          time: appt.time,
          doctorName: appt.doctor?.fullName,
        }),
      },
      { jobId }
    );
    return { status: 'queued', jobId };
  } catch (err) {
    // Não enfileirou: devolve a vez (permite nova tentativa) e informa o resultado real.
    await Appointment.updateOne(
      { _id: appointmentId },
      { $set: { 'cancellationNotification.status': 'failed', 'cancellationNotification.error': String(err?.message || err).slice(0, 300) } }
    );
    return { status: 'failed', error: String(err?.message || err) };
  }
}

export default { requestCancellationNotification, buildCancellationMessage };
