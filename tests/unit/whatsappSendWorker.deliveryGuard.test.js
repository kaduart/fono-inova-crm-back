// Fiação do WhatsappSendWorker com a proteção de reenvio. Provedor e guarda
// simulados; nenhum envio real.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let processor;
vi.mock('bullmq', () => ({ Worker: class { constructor(_q, fn) { processor = fn; } on() {} } }));
vi.mock('../../config/redisConnection.js', () => ({ bullMqConnection: {} }));
vi.mock('../../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../models/Message.js', () => ({ default: { findOne: vi.fn(() => ({ lean: async () => null, sort: () => ({ lean: async () => null }) })) } }));
vi.mock('../../models/Contacts.js', () => ({ default: { findOne: vi.fn(() => ({ lean: async () => null })) } }));
vi.mock('../../config/socket.js', () => ({ emitSocketEvent: vi.fn() }));
vi.mock('../../utils/phone.js', () => ({ normalizeE164BR: (x) => x }));
const publishEvent = vi.fn(async () => ({}));
vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
  publishEvent: (...a) => publishEvent(...a),
  EventTypes: { WHATSAPP_MESSAGE_SENT: 'WHATSAPP_MESSAGE_SENT', WHATSAPP_MESSAGE_FAILED: 'WHATSAPP_MESSAGE_FAILED' }
}));
const sendTextMessage = vi.fn(async () => ({ messages: [{ id: 'wamid.FAKE' }] }));
vi.mock('../../services/whatsappService.js', () => ({ sendTextMessage: (...a) => sendTextMessage(...a) }));
const guardedSend = vi.fn();
vi.mock('../../infrastructure/delivery/deliveryGuard.js', () => ({
  guardedSend: (...a) => guardedSend(...a),
  DeliveryOutcome: { SENT: 'sent', ALREADY_SENT: 'already_sent', IN_PROGRESS: 'in_progress', UNCERTAIN: 'uncertain' }
}));

const { createWhatsappSendWorker } = await import('../../domains/whatsapp/workers/whatsappSendWorker.js');
createWhatsappSendWorker();

const job = (idempotencyKey) => ({
  id: 'job-1',
  data: { payload: { to: '5562900000000', text: 'teste fictício', leadId: 'lead-ficticio', idempotencyKey }, metadata: {} }
});

describe('WhatsappSendWorker + deliveryGuard', () => {
  beforeEach(() => { guardedSend.mockReset(); sendTextMessage.mockClear(); publishEvent.mockClear(); });

  it('usa a idempotencyKey do payload como chave de entrega e envia pelo guarda', async () => {
    guardedSend.mockImplementation(async ({ send }) => ({ outcome: 'sent', result: await send() }));
    await processor(job('send:lead:abc'));
    expect(guardedSend).toHaveBeenCalledOnce();
    expect(guardedSend.mock.calls[0][0].deliveryKey).toBe('wa:send:send:lead:abc');
    expect(sendTextMessage).toHaveBeenCalledOnce();
  });

  it('sem idempotencyKey usa o id do job (estável entre retries)', async () => {
    guardedSend.mockImplementation(async ({ send }) => ({ outcome: 'sent', result: await send() }));
    await processor(job(undefined));
    expect(guardedSend.mock.calls[0][0].deliveryKey).toBe('wa:send:job-1');
  });

  it.each(['already_sent', 'in_progress', 'uncertain'])('resultado %s não reenvia nem lança erro', async (outcome) => {
    guardedSend.mockResolvedValue({ outcome });
    const r = await processor(job('k'));
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe(`DELIVERY_${outcome.toUpperCase()}`);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('erro que prova não-envio sobe para o BullMQ retentar', async () => {
    guardedSend.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await expect(processor(job('k'))).rejects.toThrow(/ECONNREFUSED/);
    expect(publishEvent).toHaveBeenCalledWith('WHATSAPP_MESSAGE_FAILED', expect.any(Object), expect.any(Object));
  });
});
