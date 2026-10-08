import { createHash } from 'node:crypto';

export const OPENAI_ADS_PIXEL_ID = 'WXy6hTsVeJZagNccZCmLUn';
export const SCHEDULED_STATUSES = ['scheduled', 'confirmed', 'paid', 'completed'];

export function buildOpenAIAppointmentEvent({ appointmentId, eventTime }) {
  const timestamp = new Date(eventTime).getTime();
  if (!appointmentId || !Number.isFinite(timestamp)) throw new Error('invalid_event');
  return {
    id: createHash('sha256').update(`openai:appointment:${appointmentId}`).digest('hex'),
    type: 'appointment_scheduled',
    timestamp_ms: timestamp,
    source_url: 'https://clinicafonoinova.com.br',
    action_source: 'web',
    data: { type: 'customer_action' },
  };
}

export async function sendOpenAIAppointmentEvent(input, {
  apiKey = process.env.OPENAI_ADS_CONVERSIONS_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey?.trim()) return { status: 'skipped', reason: 'not_configured' };
  const event = buildOpenAIAppointmentEvent(input);
  try {
    const response = await fetchImpl(`https://bzr.openai.com/v1/events?pid=${OPENAI_ADS_PIXEL_ID}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ validate_only: false, events: [event] }),
      signal: AbortSignal.timeout(10000),
    });
    // Never log response bodies or request headers: they may contain secrets.
    if (!response.ok) return {
      status: 'failed', reason: `http_${response.status}`,
      retryable: response.status === 429 || response.status >= 500,
    };
    return { status: 'sent' };
  } catch {
    return { status: 'failed', reason: 'network_error', retryable: true };
  }
}
