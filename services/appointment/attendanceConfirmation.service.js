import Appointment from '../../models/Appointment.js';
import { normalizeE164BR } from '../../utils/phone.js';

// A confirmação do paciente é independente do status operacional do atendimento:
// "Faltou"/"Concluído" pertencem à linha; a resposta pertence à coluna Confirmação.
// Por isso nada aqui filtra operationalStatus — ver tests/unit/attendanceConfirmation.record.test.js
const PENDING_CONFIRMATION_STATUSES = ['pending', 'no_response'];

function isRealMessageId(value) {
  const v = String(value || '').trim();
  return !!v && !/^(unknown|undefined|null)$/i.test(v);
}

function responseWindow(respondedAt = new Date()) {
  const start = new Date(respondedAt);
  start.setHours(0, 0, 0, 0);
  const end = new Date(respondedAt);
  end.setDate(end.getDate() + 2);
  end.setHours(23, 59, 59, 999);
  return {
    start,
    end,
    sentSince: new Date(new Date(respondedAt).getTime() - (48 * 60 * 60 * 1000)),
  };
}

async function findPendingConfirmationByPhone(normalizedPhone, respondedAt = new Date()) {
  const { start, end, sentSince } = responseWindow(respondedAt);

  return (
    await Appointment.find({
      date: { $gte: start, $lte: end },
      'attendanceConfirmation.status': { $in: PENDING_CONFIRMATION_STATUSES },
      'attendanceConfirmation.sentAt': { $gte: sentSince },
    })
      .select('_id date time patient patientInfo attendanceConfirmation')
      .populate('patient', 'phone')
      .sort({ 'attendanceConfirmation.sentAt': -1, date: 1, time: 1 })
      .lean()
  ).find((candidate) => {
    const candidatePhone = normalizeE164BR(candidate.patient?.phone || candidate.patientInfo?.phone || '');
    return candidatePhone && candidatePhone === normalizedPhone;
  }) || null;
}

async function findPendingConfirmationById(appointmentId, normalizedPhone) {
  const candidate = await Appointment.findOne({
    _id: appointmentId,
    'attendanceConfirmation.status': { $in: PENDING_CONFIRMATION_STATUSES },
  })
    .select('_id date time patient patientInfo attendanceConfirmation')
    .populate('patient', 'phone')
    .lean();

  if (!candidate) return null;
  const candidatePhone = normalizeE164BR(candidate.patient?.phone || candidate.patientInfo?.phone || '');
  return candidatePhone === normalizedPhone ? candidate : null;
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyAttendanceConfirmationResponse(text) {
  const value = normalizeText(text);
  if (!value) return null;

  if (/^(cancelar|cancela|cancele|cancelado|remarcar|desmarcar|cancelar remarcar)$/.test(value)) {
    return 'change_requested';
  }
  if (/^(2|falar com a recepcao)$/.test(value)) {
    return 'review_required';
  }
  if (/^(1|sim|confirmo|confirmo a presenca|confirmar presenca|confirmado|confirmada|presenca confirmada)$/.test(value)) {
    return 'confirmed';
  }
  return null;
}

function parseButtonAction(buttonId) {
  const match = String(buttonId || '').match(/^attendance_(confirm|change):([a-f\d]{24})$/i);
  if (!match) return null;
  return {
    status: match[1].toLowerCase() === 'confirm' ? 'confirmed' : 'change_requested',
    appointmentId: match[2],
  };
}

export async function markAttendanceConfirmationQueued(appointmentId, { queuedAt = new Date() } = {}) {
  return Appointment.findOneAndUpdate(
    { _id: appointmentId },
    {
      $set: {
        'attendanceConfirmation.status': 'pending',
        'attendanceConfirmation.channel': 'whatsapp',
        'attendanceConfirmation.queuedAt': queuedAt,
        // Fica sem messageId até o worker gravar o ID real do envio. O ID do job
        // BullMQ nunca casa com o voto da enquete e travava o registro da resposta.
        'attendanceConfirmation.messageId': undefined,
      },
      $unset: {
        'attendanceConfirmation.sentAt': 1,
        'attendanceConfirmation.respondedAt': 1,
        'attendanceConfirmation.responseMessageId': 1,
        'attendanceConfirmation.responseText': 1,
      },
    },
    { new: true }
  ).lean();
}

export async function markAttendanceConfirmationSent(appointmentId, { messageId, sentAt = new Date() } = {}) {
  return Appointment.updateOne(
    {
      _id: appointmentId,
      'attendanceConfirmation.status': { $nin: ['confirmed', 'change_requested', 'review_required'] },
    },
    {
      $set: {
        'attendanceConfirmation.status': 'no_response',
        'attendanceConfirmation.channel': 'whatsapp',
        'attendanceConfirmation.sentAt': sentAt,
        // 'unknown' e o id do job BullMQ não servem para casar o voto da enquete;
        // gravá-los esconde o problema e mantém um ID inválido no registro.
        ...(isRealMessageId(messageId) ? { 'attendanceConfirmation.messageId': String(messageId) } : {}),
      },
    }
  );
}

export async function recordAttendanceConfirmationResponse({ phone, text, buttonId, messageId, respondedAt = new Date() } = {}) {
  const buttonAction = parseButtonAction(buttonId);
  const status = buttonAction?.status || classifyAttendanceConfirmationResponse(text);
  const normalizedPhone = normalizeE164BR(phone);
  if (!normalizedPhone) return { matched: false, reason: 'unrecognized' };

  const appointment = buttonAction?.appointmentId
    ? await findPendingConfirmationById(buttonAction.appointmentId, normalizedPhone)
    : await findPendingConfirmationByPhone(normalizedPhone, respondedAt);
  if (!appointment) return { matched: false, reason: 'appointment_not_found' };

  const resolvedStatus = status || 'review_required';

  const updated = await Appointment.updateOne(
    { _id: appointment._id, 'attendanceConfirmation.status': { $in: PENDING_CONFIRMATION_STATUSES } },
    {
      $set: {
        'attendanceConfirmation.status': resolvedStatus,
        'attendanceConfirmation.respondedAt': respondedAt,
        'attendanceConfirmation.responseMessageId': messageId ? String(messageId) : undefined,
        'attendanceConfirmation.responseText': String(text).slice(0, 300),
      },
    }
  );

  return {
    matched: updated.modifiedCount === 1,
    appointmentId: String(appointment._id),
    status: resolvedStatus,
  };
}

export async function recordAttendanceConfirmationPollVote({ phone, pollMessageId, optionName, respondedAt = new Date() } = {}) {
  const normalizedPhone = normalizeE164BR(phone);
  const normalizedOption = normalizeText(optionName);
  const status = normalizedOption.includes('confirmar presenca') || normalizedOption.includes('sim confirmo')
    ? 'confirmed'
    : normalizedOption.includes('falar com a recepcao')
      ? 'review_required'
      : null;
  if (!normalizedPhone || !status) {
    return { matched: false, reason: 'unrecognized' };
  }

  // 1) Caminho ideal: o ID da enquete gravado no envio casa com o voto recebido.
  let appointment = null;
  if (isRealMessageId(pollMessageId)) {
    const byMessageId = await Appointment.findOne({
      'attendanceConfirmation.messageId': String(pollMessageId),
      'attendanceConfirmation.status': { $in: PENDING_CONFIRMATION_STATUSES },
    })
      .select('_id patient patientInfo attendanceConfirmation')
      .populate('patient', 'phone')
      .lean();

    const byMessageIdPhone = normalizeE164BR(byMessageId?.patient?.phone || byMessageId?.patientInfo?.phone || '');
    if (byMessageId && byMessageIdPhone === normalizedPhone) {
      appointment = byMessageId;
    }
  }

  // 2) Fallback: o WhatsApp Web nem sempre devolve o ID da enquete ao enviar (já
  //    gravamos 'unknown'), e aí o clique do paciente era descartado em silêncio.
  //    Sem ID confiável, localizamos pela telefone + janela da confirmação enviada.
  if (!appointment) {
    appointment = await findPendingConfirmationByPhone(normalizedPhone, respondedAt);
  }
  if (!appointment) {
    return { matched: false, reason: 'appointment_not_found' };
  }

  const updated = await Appointment.updateOne(
    { _id: appointment._id, 'attendanceConfirmation.status': { $in: PENDING_CONFIRMATION_STATUSES } },
    {
      $set: {
        'attendanceConfirmation.status': status,
        'attendanceConfirmation.respondedAt': respondedAt,
        'attendanceConfirmation.responseMessageId': isRealMessageId(pollMessageId) ? String(pollMessageId) : undefined,
        'attendanceConfirmation.responseText': String(optionName).slice(0, 300),
      },
    }
  );

  return { matched: updated.modifiedCount === 1, appointmentId: String(appointment._id), status };
}

export default {
  classifyAttendanceConfirmationResponse,
  markAttendanceConfirmationQueued,
  markAttendanceConfirmationSent,
  recordAttendanceConfirmationResponse,
  recordAttendanceConfirmationPollVote,
};
