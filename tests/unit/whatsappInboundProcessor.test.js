/**
 * Regras de negócio sobre eventos normalizados (iguais no modo local e no conector externo) e o envio
 * da ponte com deliveryGuard: resultado incerto não marca enviado e não reenvia.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({ capture: [], confirm: [], interest: [], activity: [], vote: [] }));
vi.mock('../../services/leadAttributionService.js', () => ({ captureInboundAttribution: async (a) => { calls.capture.push(a); return { ok: true }; } }));
vi.mock('../../services/appointment/attendanceConfirmation.service.js', () => ({
  recordAttendanceConfirmationResponse: async (a) => { calls.confirm.push(a); return { matched: false }; },
  recordAttendanceConfirmationPollVote: async (a) => { calls.vote.push(a); return { matched: true }; },
}));
vi.mock('../../services/convenioWaitlistWhatsapp.js', () => ({
  recordWhatsappInterest: async (a) => { calls.interest.push(a); return { result: 'created' }; },
  recordChatActivity: async (rows) => { calls.activity.push(...rows); return { matched: rows.length }; },
}));

vi.mock('bullmq', () => ({ Worker: class {} }));
vi.mock('../../config/redisConnection.js', () => ({ bullMqConnection: {} }));

const { processConnectorEvent } = await import('../../services/whatsappInboundProcessor.js');
const { makeConnectorSender } = await import('../../workers/whatsappConnectorBridge.js');

const base = { waMessageId: 'false_5562999990000@c.us_A', chatId: '5562999990000@c.us', phone: '5562999990000', timestamp: 1_763_500_000, notifyName: 'Ana', source: 'live' };

beforeEach(() => { for (const k of Object.keys(calls)) calls[k].length = 0; vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('message.inbound', () => {
  it('anúncio (ctwa) grava origem; confirmação também é avaliada', async () => {
    const ctwa = { sourceId: '120251066022110554', sourceUrl: 'https://fb.me/x', conversionData: Buffer.from('AR' + 'x'.repeat(60)).toString('base64') };
    await processConnectorEvent({ type: 'message.inbound', data: { ...base, body: 'Tenho GEAP e quero agendar', ctwa } });
    expect(calls.capture).toHaveLength(1);
    expect(calls.capture[0]).toMatchObject({ phone: base.phone, capturedBy: 'whatsapp_web' });
    expect(calls.capture[0].ctwa.ctwaClid).toMatch(/^AR/);
    expect(calls.confirm).toHaveLength(1);
    expect(calls.interest.map((i) => i.convenio)).toContain('geap');
  });

  it('sem telefone resolvido (@lid): não grava origem', async () => {
    await processConnectorEvent({ type: 'message.inbound', data: { ...base, phone: null, body: 'Vim pelo anúncio', ctwa: { sourceId: '1' } } });
    expect(calls.capture).toHaveLength(0);
    expect(calls.confirm).toHaveLength(0);
  });

  it('catch-up só refaz a origem (como antes)', async () => {
    await processConnectorEvent({ type: 'message.inbound', data: { ...base, source: 'catchup', body: 'tenho geap', ctwa: { sourceId: '1' } } });
    expect(calls.capture[0].capturedBy).toBe('whatsapp_web_catchup');
    expect(calls.confirm).toHaveLength(0);
    expect(calls.interest).toHaveLength(0);
  });
});

describe('outros eventos', () => {
  it('message.outbound grava a data da conversa da clínica', async () => {
    await processConnectorEvent({ type: 'message.outbound', data: { waMessageId: 'x', phone: base.phone, timestamp: 1_763_500_000 } });
    expect(calls.activity[0].clinicAt).toEqual(new Date(1_763_500_000 * 1000));
  });
  it('poll.vote registra o voto; sem telefone, ignora', async () => {
    await processConnectorEvent({ type: 'poll.vote', data: { voterPhone: base.phone, pollMessageId: 'p1', optionName: 'Confirmar presença ✅', respondedAtMs: 1 } });
    await processConnectorEvent({ type: 'poll.vote', data: { voterPhone: null, pollMessageId: 'p1', optionName: 'x' } });
    expect(calls.vote).toHaveLength(1);
  });
  it('tipo desconhecido é ignorado (versões diferentes convivem)', async () => {
    expect(await processConnectorEvent({ type: 'algo.novo', data: {} })).toEqual({ ignored: true });
  });
});

describe('envio da ponte com deliveryGuard', () => {
  const DeliveryOutcome = { SENT: 'sent', ALREADY_SENT: 'already_sent', IN_PROGRESS: 'in_progress', UNCERTAIN: 'uncertain' };
  // guardedSend simplificado com o mesmo contrato do real (infrastructure/delivery/deliveryGuard.js).
  const fakeGuard = () => {
    const rec = new Map();
    return async ({ deliveryKey, send, providerMessageIdOf }) => {
      const r = rec.get(deliveryKey);
      if (r === 'sent') return { outcome: DeliveryOutcome.ALREADY_SENT };
      if (r === 'unknown') return { outcome: DeliveryOutcome.UNCERTAIN };
      try {
        const out = await send();
        rec.set(deliveryKey, 'sent');
        return { outcome: DeliveryOutcome.SENT, result: out, providerMessageId: providerMessageIdOf(out) };
      } catch (err) {
        if (err.deliveryNotSent) { rec.set(deliveryKey, 'failed'); throw err; }
        rec.set(deliveryKey, 'unknown');
        return { outcome: DeliveryOutcome.UNCERTAIN, error: err };
      }
    };
  };

  it('usa a mesma chave do modo local (wweb:send:<job>) como requestId, manda a enquete do CRM e devolve o messageId', async () => {
    const seen = [];
    const sender = makeConnectorSender({ client: { sendMessage: async (p) => { seen.push(p); return { success: true, messageId: 'M1' }; } }, guardedSend: fakeGuard(), DeliveryOutcome });
    const r = await sender({ id: '42' }, '5562999990000', 'oi', { attendanceConfirmation: true, appointmentId: 'a1' });
    expect(r).toEqual({ success: true, messageId: 'M1' });
    expect(seen[0]).toMatchObject({ requestId: 'wweb:send:42', kind: 'attendance_confirmation', appointmentId: 'a1' });
    expect(seen[0].poll).toMatchObject({ question: expect.stringContaining('presença'), options: expect.any(Array) });
  });

  it('incerto: devolve { uncertain } e a retentativa NÃO chama o conector de novo', async () => {
    let n = 0;
    const guard = fakeGuard();
    const client = { sendMessage: async () => { n++; throw Object.assign(new Error('resultado incerto'), { uncertain: true }); } };
    const sender = makeConnectorSender({ client, guardedSend: guard, DeliveryOutcome });
    expect(await sender({ id: '7' }, '5562999990000', 'oi')).toMatchObject({ uncertain: true });
    expect(await sender({ id: '7' }, '5562999990000', 'oi')).toMatchObject({ uncertain: true });
    expect(n).toBe(1);
  });

  it('já enviado (mesma chave): devolve alreadySent sem chamar o conector', async () => {
    let n = 0;
    const guard = fakeGuard();
    const client = { sendMessage: async () => { n++; return { success: true, messageId: 'M9' }; } };
    const sender = makeConnectorSender({ client, guardedSend: guard, DeliveryOutcome });
    await sender({ id: '11' }, '5562999990000', 'oi');
    expect(await sender({ id: '11' }, '5562999990000', 'oi')).toMatchObject({ alreadySent: true });
    expect(n).toBe(1);
  });

  it('não saiu (desconectado): lança para o BullMQ tentar de novo depois', async () => {
    const client = { sendMessage: async () => { throw Object.assign(new Error('desconectado'), { deliveryNotSent: true }); } };
    const sender = makeConnectorSender({ client, guardedSend: fakeGuard(), DeliveryOutcome });
    await expect(sender({ id: '9' }, '5562999990000', 'oi')).rejects.toThrow('desconectado');
  });
});
