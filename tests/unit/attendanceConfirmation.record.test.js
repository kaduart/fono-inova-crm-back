/**
 * Registro da resposta do paciente na coluna "Confirmação".
 *
 * Contexto do bug (2026-10-20, investigado no agendamento real que ficou com
 * `attendanceConfirmation.messageId: 'unknown'` e `respondedAt: null`):
 *   - o clique do paciente era descartado quando o atendimento já estava em
 *     "missed" (Faltou), porque a busca filtrava `operationalStatus` ativo;
 *   - e também era descartado quando o WhatsApp Web não devolvia o ID da enquete,
 *     porque a busca era só por `attendanceConfirmation.messageId`.
 *
 * Este teste sobe um MongoDB efêmero em memória (MongoMemoryReplSet — o mesmo
 * padrão de tests/e2e/*.e2e.test.js) e NUNCA lê MONGO_URI/.env. Ele só apaga os
 * documentos que ele mesmo cria (marcados pelo `correlationId` deste arquivo).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const emitSocketEventMock = vi.hoisted(() => vi.fn().mockResolvedValue({ emitted: true, via: 'test' }));
vi.mock('../../config/socket.js', () => ({ emitSocketEvent: emitSocketEventMock }));

const PHONE = '5562999999999';
// Marca exclusiva dos documentos deste teste — o cleanup usa `correlationId`.
const testCorrelationId = `attendance-confirmation-test-${Date.now()}`;

let mongoServer;
let Appointment;
let recordAttendanceConfirmationResponse;
let recordAttendanceConfirmationPollVote;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ launchTimeout: 120_000 }],
  });
  await mongoose.connect(mongoServer.getUri());

  Appointment = (await import('../../models/Appointment.js')).default;
  ({ recordAttendanceConfirmationResponse, recordAttendanceConfirmationPollVote } = await import(
    '../../services/appointment/attendanceConfirmation.service.js'
  ));
}, 120_000);

afterEach(async () => {
  emitSocketEventMock.mockClear();
  await Appointment.deleteMany({ correlationId: testCorrelationId });
});

afterAll(async () => {
  // Só os documentos deste teste; o banco é o efêmero em memória.
  if (Appointment) await Appointment.deleteMany({ correlationId: testCorrelationId });
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

function seedAppointment(overrides = {}) {
  return Appointment.create({
    date: new Date(),
    time: '08:00',
    specialty: 'fonoaudiologia',
    correlationId: testCorrelationId,
    patientInfo: { name: 'Paciente Teste', phone: PHONE },
    operationalStatus: 'missed',
    attendanceConfirmation: {
      status: 'no_response',
      sentAt: new Date(),
      messageId: 'unknown',
      ...overrides.attendanceConfirmation,
    },
    ...overrides,
  });
}

describe('resposta do paciente é registrada independente do status operacional', () => {
  it('registra a resposta por texto mesmo com o atendimento já em "missed" (Faltou)', async () => {
    const appointment = await seedAppointment();

    const result = await recordAttendanceConfirmationResponse({ phone: PHONE, text: '1' });

    expect(result.matched).toBe(true);
    expect(result.status).toBe('confirmed');

    const saved = await Appointment.findById(appointment._id).lean();
    expect(saved.attendanceConfirmation.status).toBe('confirmed');
    expect(saved.attendanceConfirmation.respondedAt).toBeInstanceOf(Date);
    // A resposta não mexe no status do atendimento.
    expect(saved.operationalStatus).toBe('missed');
    expect(emitSocketEventMock).toHaveBeenCalledWith(
      'appointmentUpdated',
      expect.objectContaining({
        _id: String(appointment._id),
        attendanceConfirmation: expect.objectContaining({ status: 'confirmed' }),
      })
    );
  });

  it('registra a votação da enquete mesmo sem ID de mensagem confiável', async () => {
    const appointment = await seedAppointment();

    const result = await recordAttendanceConfirmationPollVote({
      phone: PHONE,
      pollMessageId: 'unknown',
      optionName: 'Confirmar presença ✅',
    });

    expect(result.matched).toBe(true);
    expect(result.status).toBe('confirmed');

    const saved = await Appointment.findById(appointment._id).lean();
    expect(saved.attendanceConfirmation.status).toBe('confirmed');
  });

  it('prefere o ID da enquete quando ele é confiável', async () => {
    const messageId = 'true_5562999999999@c.us_3EB0ABCDEF';
    const appointment = await seedAppointment({
      attendanceConfirmation: { status: 'no_response', sentAt: new Date(), messageId },
    });

    const result = await recordAttendanceConfirmationPollVote({
      phone: PHONE,
      pollMessageId: messageId,
      optionName: 'Falar com a recepção',
    });

    expect(result.matched).toBe(true);
    expect(result.status).toBe('review_required');

    const saved = await Appointment.findById(appointment._id).lean();
    expect(saved.attendanceConfirmation.responseMessageId).toBe(messageId);
  });

  it('não sobrescreve uma confirmação já respondida', async () => {
    const appointment = await seedAppointment({
      attendanceConfirmation: { status: 'confirmed', sentAt: new Date(), respondedAt: new Date() },
    });

    const result = await recordAttendanceConfirmationResponse({ phone: PHONE, text: 'cancelar' });

    expect(result.matched).toBe(false);
    const saved = await Appointment.findById(appointment._id).lean();
    expect(saved.attendanceConfirmation.status).toBe('confirmed');
  });

  it('ignora resposta de outro telefone', async () => {
    await seedAppointment();

    const result = await recordAttendanceConfirmationResponse({ phone: '5511888888888', text: 'Sim, confirmo' });

    expect(result.matched).toBe(false);
  });
});
