import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIAppointmentEvent, sendOpenAIAppointmentEvent, SCHEDULED_STATUSES } from '../services/openaiAdsConversionsService.js';

const input = { appointmentId: 'internal-id', eventTime: '2026-10-08T16:00:00Z', phone: 'sensitive', name: 'sensitive', notes: 'sensitive' };

test('payload contains only the authorized fields and stable opaque ID', () => {
  const event = buildOpenAIAppointmentEvent(input);
  assert.deepEqual(Object.keys(event).sort(), ['id', 'type', 'timestamp_ms', 'source_url', 'action_source', 'data'].sort());
  assert.equal(event.type, 'appointment_scheduled');
  assert.equal(event.timestamp_ms, Date.parse(input.eventTime));
  assert.equal(event.id, buildOpenAIAppointmentEvent(input).id);
  assert.notEqual(event.id, input.appointmentId);
  assert.deepEqual(event.data, { type: 'customer_action' });
  assert.ok(!JSON.stringify(event).includes('sensitive'));
  assert.ok(!SCHEDULED_STATUSES.includes('pre_agendado'));
});

test('missing credentials never invokes the network', async () => {
  const result = await sendOpenAIAppointmentEvent(input, { apiKey: '', fetchImpl: () => assert.fail('network called') });
  assert.equal(result.status, 'skipped');
});

test('sends supplied schema to the fixed pixel with server-side authorization', async () => {
  const result = await sendOpenAIAppointmentEvent(input, { apiKey: 'test-only', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://bzr.openai.com/v1/events?pid=WXy6hTsVeJZagNccZCmLUn');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    assert.deepEqual(JSON.parse(options.body), { validate_only: false, events: [buildOpenAIAppointmentEvent(input)] });
    return { ok: true };
  } });
  assert.equal(result.status, 'sent');
});

test('HTTP failures expose only safe status codes and retry only transient errors', async () => {
  for (const status of [401, 429, 500]) {
    const result = await sendOpenAIAppointmentEvent(input, { apiKey: 'test-only', fetchImpl: async () => ({ ok: false, status }) });
    assert.deepEqual(result, { status: 'failed', reason: `http_${status}`, retryable: status !== 401 });
  }
});

test('network errors do not expose credentials or sensitive response details', async () => {
  const result = await sendOpenAIAppointmentEvent(input, { apiKey: 'test-only', fetchImpl: async () => { throw new Error('secret'); } });
  assert.deepEqual(result, { status: 'failed', reason: 'network_error', retryable: true });
});
