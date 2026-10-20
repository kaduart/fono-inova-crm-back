import Appointment from '../../models/Appointment.js';
import { normalizeE164BR } from '../../utils/phone.js';

const ACTIVE_STATUSES = ['pre_agendado', 'scheduled', 'confirmed', 'pending'];

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

  if (/^(2|cancelar|cancela|cancele|cancelado|remarcar|desmarcar|cancelar remarcar)$/.test(value)) {
    return 'change_requested';
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

export async function markAttendanceConfirmationQueued(appointmentId, { jobId, queuedAt = new Date() } = {}) {
  return Appointment.findOneAndUpdate(
    { _id: appointmentId, operationalStatus: { $in: ACTIVE_STATUSES } },
    {
      $set: {
        'attendanceConfirmation.status': 'pending',
        'attendanceConfirmation.channel': 'whatsapp',
        'attendanceConfirmation.queuedAt': queuedAt,
        'attendanceConfirmation.messageId': jobId ? String(jobId) : undefined,
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
      operationalStatus: { $in: ACTIVE_STATUSES },
      'attendanceConfirmation.status': { $nin: ['confirmed', 'change_requested', 'review_required'] },
    },
    {
      $set: {
        'attendanceConfirmation.status': 'no_response',
        'attendanceConfirmation.channel': 'whatsapp',
        'attendanceConfirmation.sentAt': sentAt,
        ...(messageId ? { 'attendanceConfirmation.messageId': String(messageId) } : {}),
      },
    }
  );
}

export async function recordAttendanceConfirmationResponse({ phone, text, buttonId, messageId, respondedAt = new Date() } = {}) {
  const buttonAction = parseButtonAction(buttonId);
  const status = buttonAction?.status || classifyAttendanceConfirmationResponse(text);
  const normalizedPhone = normalizeE164BR(phone);
  if (!normalizedPhone) return { matched: false, reason: 'unrecognized' };

  const start = new Date(respondedAt);
  start.setHours(0, 0, 0, 0);
  const end = new Date(respondedAt);
  end.setDate(end.getDate() + 2);
  end.setHours(23, 59, 59, 999);
  const sentSince = new Date(new Date(respondedAt).getTime() - (48 * 60 * 60 * 1000));

  const candidates = await Appointment.find({
    ...(buttonAction?.appointmentId ? { _id: buttonAction.appointmentId } : {}),
    date: { $gte: start, $lte: end },
    operationalStatus: { $in: ACTIVE_STATUSES },
    'attendanceConfirmation.status': { $in: ['pending', 'no_response'] },
    'attendanceConfirmation.sentAt': { $gte: sentSince },
  })
    .select('_id date time patient patientInfo attendanceConfirmation')
    .populate('patient', 'phone')
    .sort({ 'attendanceConfirmation.sentAt': -1, date: 1, time: 1 })
    .lean();

  const appointment = candidates.find((candidate) => {
    const candidatePhone = normalizeE164BR(candidate.patient?.phone || candidate.patientInfo?.phone || '');
    return candidatePhone && candidatePhone === normalizedPhone;
  });
  if (!appointment) return { matched: false, reason: 'appointment_not_found' };

  const resolvedStatus = status || 'review_required';

  const updated = await Appointment.updateOne(
    { _id: appointment._id, 'attendanceConfirmation.status': { $in: ['pending', 'no_response'] } },
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
  const status = normalizedOption.includes('confirmar presenca')
    ? 'confirmed'
    : normalizedOption.includes('cancelar remarcar')
      ? 'change_requested'
      : null;
  if (!normalizedPhone || !pollMessageId || !status) {
    return { matched: false, reason: 'unrecognized' };
  }

  const appointment = await Appointment.findOne({
    operationalStatus: { $in: ACTIVE_STATUSES },
    'attendanceConfirmation.messageId': String(pollMessageId),
    'attendanceConfirmation.status': { $in: ['pending', 'no_response'] },
  })
    .select('_id patient patientInfo attendanceConfirmation')
    .populate('patient', 'phone')
    .lean();

  const appointmentPhone = normalizeE164BR(appointment?.patient?.phone || appointment?.patientInfo?.phone || '');
  if (!appointment || appointmentPhone !== normalizedPhone) {
    return { matched: false, reason: 'appointment_not_found' };
  }

  const updated = await Appointment.updateOne(
    { _id: appointment._id, 'attendanceConfirmation.status': { $in: ['pending', 'no_response'] } },
    {
      $set: {
        'attendanceConfirmation.status': status,
        'attendanceConfirmation.respondedAt': respondedAt,
        'attendanceConfirmation.responseMessageId': String(pollMessageId),
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
