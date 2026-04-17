/**
 * 🔔 Testes de Regressão: WhatsApp Real-Time Notifications
 *
 * Reproduz bug onde mensagens inbound não emitiam `message:new`
 * porque `messagePersistenceWorker` não enviava `direction: 'inbound'`
 * no payload de `MESSAGE_PERSISTED`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessagePersistedSchema } from '../../domains/whatsapp/events/messageEventSchema.js';

// Simula o realtimeWorker processando um job da fila whatsapp-realtime
function processRealtimeJob(jobData, ioMock) {
  const { payload, metadata } = jobData;
  const correlationId = metadata?.correlationId || jobData.eventId;

  // 🛡️ VALIDAÇÃO DE CONTRATO (igual ao código de produção)
  const validation = MessagePersistedSchema.validate(payload);
  if (!validation.valid) {
    return {
      status: 'completed_with_errors',
      error: `Schema violation: ${validation.errors.join('; ')}`,
    };
  }

  const direction = payload.direction;

  if (direction === 'inbound') {
    const { messageId, leadId, from, to, type, content, timestamp } = payload;
    const socketPayload = {
      id: messageId,
      from,
      to,
      type,
      content,
      text: content,
      timestamp,
      direction: 'inbound',
    };

    ioMock?.emit('message:new', socketPayload);
    ioMock?.emit('whatsapp:new_message', socketPayload);

    if (leadId) {
      ioMock?.to(`lead:${leadId}`).emit('message_received', socketPayload);
    }
  } else {
    // outbound
    const { phone, leadId, messageId, sentAt } = payload;
    ioMock?.to(`lead:${leadId}`).emit('message_sent', {
      phone, messageId, sentAt, correlationId,
    });
  }

  return { status: 'completed', direction };
}

describe('🔔 WhatsApp Realtime Worker', () => {
  let ioMock;

  beforeEach(() => {
    ioMock = {
      emit: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
    };
  });

  it('deve emitir message:new quando direction for inbound', () => {
    const jobData = {
      eventId: 'evt-123',
      payload: {
        messageId: 'msg-456',
        leadId: 'lead-789',
        from: '5511999999999',
        to: '5511888888888',
        type: 'text',
        content: 'Oi, tudo bem?',
        timestamp: '2026-04-16T20:00:00.000Z',
        direction: 'inbound',
      },
      metadata: { correlationId: 'corr-abc' },
    };

    const result = processRealtimeJob(jobData, ioMock);

    expect(result.status).toBe('completed');
    expect(result.direction).toBe('inbound');
    expect(ioMock.emit).toHaveBeenCalledWith('message:new', expect.objectContaining({
      id: 'msg-456',
      from: '5511999999999',
      direction: 'inbound',
      content: 'Oi, tudo bem?',
      text: 'Oi, tudo bem?',
    }));
    expect(ioMock.emit).toHaveBeenCalledWith('whatsapp:new_message', expect.any(Object));
  });

  it('deve retornar erro de schema e NAO processar quando direction estiver ausente', () => {
    const jobData = {
      eventId: 'evt-123',
      payload: {
        messageId: 'msg-456',
        leadId: 'lead-789',
        from: '5511999999999',
        to: '5511888888888',
        type: 'text',
        content: 'Oi, tudo bem?',
        timestamp: '2026-04-16T20:00:00.000Z',
        // direction está ausente!
      },
      metadata: { correlationId: 'corr-abc' },
    };

    const result = processRealtimeJob(jobData, ioMock);

    expect(result.status).toBe('completed_with_errors');
    expect(result.error).toContain('Missing required field: direction');
    expect(ioMock.emit).not.toHaveBeenCalledWith('message:new', expect.any(Object));
    expect(ioMock.emit).not.toHaveBeenCalledWith('whatsapp:new_message', expect.any(Object));
  });

  it('deve retornar erro de schema quando direction for invalida', () => {
    const jobData = {
      eventId: 'evt-123',
      payload: {
        messageId: 'msg-456',
        leadId: 'lead-789',
        from: '5511999999999',
        to: '5511888888888',
        type: 'text',
        content: 'Oi, tudo bem?',
        timestamp: '2026-04-16T20:00:00.000Z',
        direction: 'unknown_value',
      },
      metadata: { correlationId: 'corr-abc' },
    };

    const result = processRealtimeJob(jobData, ioMock);

    expect(result.status).toBe('completed_with_errors');
    expect(result.error).toContain('Invalid direction');
    expect(ioMock.emit).not.toHaveBeenCalled();
  });

  it('deve processar outbound sem emitir message:new global', () => {
    const jobData = {
      eventId: 'evt-789',
      payload: {
        messageId: 'msg-999',
        leadId: 'lead-789',
        from: '5511888888888',
        to: '5511999999999',
        type: 'text',
        content: 'Resposta da clínica',
        timestamp: '2026-04-16T20:01:00.000Z',
        direction: 'outbound',
      },
      metadata: { correlationId: 'corr-def' },
    };

    const result = processRealtimeJob(jobData, ioMock);

    expect(result.status).toBe('completed');
    expect(result.direction).toBe('outbound');
    expect(ioMock.emit).not.toHaveBeenCalledWith('message:new', expect.any(Object));
  });
});

describe('💾 MessagePersistedSchema', () => {
  it('deve validar payload completo inbound', () => {
    const payload = {
      messageId: 'msg-456',
      leadId: 'lead-789',
      from: '5511999999999',
      to: '5511888888888',
      type: 'text',
      content: 'Oi, tudo bem?',
      timestamp: '2026-04-16T20:00:00.000Z',
      wamid: 'wamid.abc123',
      direction: 'inbound',
    };

    const result = MessagePersistedSchema.validate(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('deve rejeitar payload sem direction', () => {
    const payload = {
      messageId: 'msg-456',
      from: '5511999999999',
      to: '5511888888888',
      type: 'text',
      content: 'Oi',
      timestamp: '2026-04-16T20:00:00.000Z',
    };

    const result = MessagePersistedSchema.validate(payload);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: direction');
  });

  it('deve rejeitar direction invalida', () => {
    const payload = {
      messageId: 'msg-456',
      from: '5511999999999',
      to: '5511888888888',
      type: 'text',
      content: 'Oi',
      timestamp: '2026-04-16T20:00:00.000Z',
      direction: 'sideways',
    };

    const result = MessagePersistedSchema.validate(payload);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid direction: sideways. Allowed: inbound, outbound');
  });
});

console.log('🔔 Testes de notificação WhatsApp carregados');
