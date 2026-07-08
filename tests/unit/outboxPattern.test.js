/**
 * Testes unitários do Outbox Pattern
 *
 * Foco:
 * - saveToOutbox deve ser idempotente quando eventId já existe (E11000).
 * - publishPendingEvents deve falhar eventos desconhecidos e publicar os mapeados para [].
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { saveToOutbox, publishPendingEvents } from '../../infrastructure/outbox/outboxPattern.js';
import Outbox from '../../infrastructure/outbox/OutboxModel.js';

// Mock do queueConfig para evitar conexão real com Redis/BullMQ
vi.mock('../../infrastructure/queue/queueConfig.js', () => ({
  getQueue: () => ({
    add: vi.fn(async () => ({ id: 'mock-job' }))
  })
}));

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  await Outbox.deleteMany({});
});

describe('saveToOutbox', () => {
  it('deve salvar evento e retornar a entrada', async () => {
    const event = {
      eventId: 'evt-001',
      eventType: 'APPOINTMENT_CREATED',
      payload: { foo: 'bar' },
      aggregateType: 'appointment',
      aggregateId: 'apt-001'
    };

    const saved = await saveToOutbox(event);

    expect(saved.eventId).toBe('evt-001');
    expect(saved.status).toBe('pending');

    const count = await Outbox.countDocuments({ eventId: 'evt-001' });
    expect(count).toBe(1);
  });

  it('deve tratar eventId duplicado como idempotente e retornar o registro existente', async () => {
    const event = {
      eventId: 'evt-duplicated',
      eventType: 'PAYMENT_STATUS_CHANGED',
      payload: { paymentId: 'p-001' },
      aggregateType: 'payment',
      aggregateId: 'p-001'
    };

    const first = await saveToOutbox(event);
    const second = await saveToOutbox(event);

    expect(second._id.toString()).toBe(first._id.toString());

    const count = await Outbox.countDocuments({ eventId: 'evt-duplicated' });
    expect(count).toBe(1);
  });
});

describe('publishPendingEvents', () => {
  it('deve marcar evento desconhecido como failed', async () => {
    await Outbox.create({
      eventId: 'evt-unknown',
      eventType: 'EVENTO_INEXISTENTE_XYZ',
      payload: {},
      aggregateType: 'test',
      aggregateId: 't-001',
      correlationId: 'corr-001',
      status: 'pending'
    });

    const result = await publishPendingEvents(10);

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.published).toBe(0);

    const evt = await Outbox.findOne({ eventId: 'evt-unknown' }).lean();
    expect(evt.status).toBe('failed');
    expect(evt.lastError).toContain('EVENTO_INEXISTENTE_XYZ');
  });

  it('deve marcar evento intencionalmente sem fila como published', async () => {
    // TOTALS_RECALCULATED está mapeado para [] em eventToQueueMap
    await Outbox.create({
      eventId: 'evt-no-queue',
      eventType: 'TOTALS_RECALCULATED',
      payload: {},
      aggregateType: 'report',
      aggregateId: 'r-001',
      correlationId: 'corr-002',
      status: 'pending'
    });

    const result = await publishPendingEvents(10);

    expect(result.processed).toBe(1);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);

    const evt = await Outbox.findOne({ eventId: 'evt-no-queue' }).lean();
    expect(evt.status).toBe('published');
    expect(evt.publishedAt).toBeInstanceOf(Date);
  });
});
