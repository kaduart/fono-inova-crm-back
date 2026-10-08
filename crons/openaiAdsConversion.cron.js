import Appointment from '../models/Appointment.js';
import OpenAIAdConversion from '../models/OpenAIAdConversion.js';
import { SCHEDULED_STATUSES, sendOpenAIAppointmentEvent } from '../services/openaiAdsConversionsService.js';

let running = false;
const INTERVAL_MS = 10 * 60 * 1000;

export async function runOpenAIAdsConversionOnce() {
  if (running || !process.env.OPENAI_ADS_CONVERSIONS_API_KEY?.trim()) return;
  if (process.env.ADS_CONVERSION_DRY_RUN === 'true') return;
  running = true;
  try {
    // Persist activation once; do not backfill historical patient appointments.
    await OpenAIAdConversion.updateOne({ _id: 'activation' }, {
      $setOnInsert: { status: 'activation', eventTime: new Date() },
    }, { upsert: true });
    const activation = await OpenAIAdConversion.findById('activation').lean();
    const knownIds = await OpenAIAdConversion.distinct('_id', {
      status: { $ne: 'activation' }, eventTime: { $gte: activation.eventTime },
    });
    const candidates = await Appointment.find({
      _id: { $nin: knownIds },
      createdAt: { $gte: activation.eventTime, $lte: new Date(Date.now() - 15 * 60 * 1000) },
      operationalStatus: { $in: SCHEDULED_STATUSES },
      patient: { $ne: null },
    }).select('_id patient createdAt').sort({ createdAt: 1 }).limit(300).lean();

    for (const appt of candidates) {
      if (await OpenAIAdConversion.exists({ _id: String(appt._id) })) continue;
      const earlier = await Appointment.exists({
        patient: appt.patient,
        $or: [
          { createdAt: { $lt: appt.createdAt } },
          { createdAt: appt.createdAt, _id: { $lt: appt._id } },
        ],
      });
      await OpenAIAdConversion.updateOne({ _id: String(appt._id) }, {
        $setOnInsert: {
          eventTime: appt.createdAt, status: earlier ? 'skipped' : 'pending',
          reason: earlier ? 'not_first_appointment' : null,
        },
      }, { upsert: true });
    }

    for (let i = 0; i < 50; i++) {
      const conv = await OpenAIAdConversion.findOneAndUpdate({
        status: { $in: ['pending', 'failed'] }, attempts: { $lt: 5 },
        nextAttemptAt: { $lte: new Date() }, lockedUntil: { $lte: new Date() },
      }, { $set: { lockedUntil: new Date(Date.now() + 120000) } }, { new: true, sort: { createdAt: 1 } });
      if (!conv) break;
      const appt = await Appointment.findById(conv._id).select('operationalStatus').lean();
      const result = !appt || !SCHEDULED_STATUSES.includes(appt.operationalStatus)
        ? { status: 'skipped', reason: 'appointment_not_scheduled' }
        : await sendOpenAIAppointmentEvent({ appointmentId: conv._id, eventTime: conv.eventTime });
      conv.attempts += 1;
      conv.status = result.status;
      conv.reason = result.reason || null;
      if (result.status === 'sent') conv.sentAt = new Date();
      if (result.status === 'failed' && !result.retryable) conv.attempts = 5;
      conv.nextAttemptAt = new Date(Date.now() + 2 ** conv.attempts * INTERVAL_MS);
      conv.lockedUntil = new Date(0);
      await conv.save();
    }
  } catch {
    console.error('[OpenAIAds] Falha na rotina de conversões; detalhes omitidos para proteger dados.');
  } finally {
    running = false;
  }
}

export function initOpenAIAdsConversionCron() {
  const interval = setInterval(runOpenAIAdsConversionOnce, INTERVAL_MS);
  const startup = setTimeout(runOpenAIAdsConversionOnce, 90000);
  return { stop: () => { clearInterval(interval); clearTimeout(startup); } };
}
