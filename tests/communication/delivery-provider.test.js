// back/tests/communication/delivery-provider.test.js
//
// Testes de regressão da arquitetura Delivery Provider para InsuranceCommunication.
//
// Garante:
//   - Canal "external" marca comunicação como sent sem enfileirar job BullMQ.
//   - Canal "email" continua enfileirando job e transicionando ready -> sending.
//   - Reenvio de comunicação já sent/approved não quebra o fluxo.
//   - Auditoria (CommunicationEmailLog) registra channel/type corretos.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// ─── MOCKS: devem ser declarados antes de importar os módulos que os usam ─────
const { mockQueueAdd, mockSendEmailWithAttachments } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(async () => ({ id: 'job-test-id' })),
  mockSendEmailWithAttachments: vi.fn(async () => ({
    success: true,
    messageId: '<test@resend.com>'
  }))
}));

vi.mock('../../infrastructure/queue/queueConfig.js', () => ({
  getQueue: vi.fn(() => ({ add: mockQueueAdd }))
}));

vi.mock('../../services/emailService.js', () => ({
  sendEmailWithAttachments: mockSendEmailWithAttachments
}));

vi.mock('../../services/email/EmailProviderFactory.js', () => ({
  getEmailProviderName: vi.fn(() => 'resend')
}));

vi.mock('../../services/communication/InsuranceRuleService.js', () => ({
  getRequiredDocumentTypes: vi.fn(() => [])
}));

vi.mock('../../utils/logger.js', () => ({
  createContextLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}));

// ─── IMPORTS (depois dos mocks) ───────────────────────────────────────────────
import { sendCommunication, handleDeliveryResult } from '../../services/communication/CommunicationService.js';
import InsuranceCommunication from '../../models/InsuranceCommunication.js';
import CommunicationPackage from '../../models/CommunicationPackage.js';
import CommunicationEmailLog, { EmailLogType } from '../../models/CommunicationEmailLog.js';
import User from '../../models/User.js';

// ─── SETUP ─────────────────────────────────────────────────────────────────────
let mongoServer;
let user;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60_000);

beforeEach(async () => {
  await InsuranceCommunication.deleteMany({});
  await CommunicationPackage.deleteMany({});
  await CommunicationEmailLog.deleteMany({});
  await User.deleteMany({});

  user = await User.create({
    fullName: 'Usuário Teste',
    email: 'teste@example.com',
    password: '123456',
    role: 'admin'
  });

  mockQueueAdd.mockClear();
  mockSendEmailWithAttachments.mockClear();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function createCommunication(overrides = {}) {
  return InsuranceCommunication.create({
    patientId: new mongoose.Types.ObjectId(),
    insuranceProvider: 'test-convenio',
    purpose: 'billing',
    specialty: 'fonoaudiologia',
    requestedSessions: 4,
    status: 'draft',
    createdBy: user._id,
    ...overrides
  });
}

async function createPackage(communicationId, attachments = []) {
  return CommunicationPackage.create({
    communicationId,
    attachments,
    status: 'draft',
    createdBy: user._id
  });
}

// ─── TESTES: CANAL EXTERNAL ───────────────────────────────────────────────────
describe('Delivery Provider - Canal external', () => {
  it('marca InsuranceCommunication.status como sent sem enfileirar job', async () => {
    const communication = await createCommunication();

    const result = await sendCommunication(communication._id.toString(), {
      deliveryMethod: 'external',
      reason: 'Enviado pelo portal do convênio',
      userId: user._id.toString()
    });

    expect(result.status).toBe('sent');
    expect(result.log).toBeDefined();
    expect(mockQueueAdd).not.toHaveBeenCalled();

    const updated = await InsuranceCommunication.findById(communication._id).lean();
    expect(updated.status).toBe('sent');
    expect(updated.deliveryMethod).toBe('external');
  });

  it('cria log de auditoria do tipo EXTERNAL com channel external', async () => {
    const communication = await createCommunication();

    await sendCommunication(communication._id.toString(), {
      deliveryMethod: 'external',
      reason: 'Enviado por e-mail manual',
      userId: user._id.toString()
    });

    const logs = await CommunicationEmailLog.find({ communicationId: communication._id }).lean();
    expect(logs).toHaveLength(1);

    const log = logs[0];
    expect(log.type).toBe(EmailLogType.EXTERNAL);
    expect(log.channel).toBe('external');
    expect(log.status).toBe('success');
    expect(log.reason).toBe('Enviado por e-mail manual');
    expect(log.sentBy.toString()).toBe(user._id.toString());
  });

  it('cria CommunicationPackage vazio quando não existir', async () => {
    const communication = await createCommunication();

    await sendCommunication(communication._id.toString(), {
      deliveryMethod: 'external',
      userId: user._id.toString()
    });

    const pkg = await CommunicationPackage.findOne({ communicationId: communication._id }).lean();
    expect(pkg).toBeTruthy();
    expect(pkg.status).toBe('sent');
    expect(pkg.attachments).toHaveLength(0);
  });

  it('permite reenvio sem quebrar quando comunicação já está sent', async () => {
    const communication = await createCommunication({ status: 'sent', deliveryMethod: 'external' });
    await createPackage(communication._id);

    const result = await sendCommunication(communication._id.toString(), {
      deliveryMethod: 'external',
      reason: 'Reenvio externo registrado',
      userId: user._id.toString()
    });

    expect(result.status).toBe('sent');

    const updated = await InsuranceCommunication.findById(communication._id).lean();
    expect(updated.status).toBe('sent');

    const logs = await CommunicationEmailLog.find({ communicationId: communication._id }).sort({ createdAt: 1 }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe(EmailLogType.EXTERNAL);
  });

  it('rejeita reenvio quando comunicação está denied', async () => {
    const communication = await createCommunication({ status: 'denied' });

    await expect(sendCommunication(communication._id.toString(), {
      deliveryMethod: 'external',
      userId: user._id.toString()
    })).rejects.toThrow('Comunicação já finalizada');
  });
});

// ─── TESTES: CANAL EMAIL ──────────────────────────────────────────────────────
describe('Delivery Provider - Canal email', () => {
  it('enfileira job BullMQ e transiciona ready -> sending', async () => {
    const communication = await createCommunication();
    await createPackage(communication._id, [{
      documentId: new mongoose.Types.ObjectId(),
      type: 'invoice',
      filename: 'nota-fiscal.pdf',
      url: 'https://example.com/doc.pdf',
      hash: 'abc',
      mimeType: 'application/pdf',
      size: 1234,
      includedAt: new Date()
    }]);

    const result = await sendCommunication(communication._id.toString(), {
      deliveryMethod: 'email',
      to: 'financeiro@convenio.com',
      subject: 'Documentação',
      userId: user._id.toString()
    });

    expect(result.status).toBe('queued');
    expect(result.jobId).toBe('job-test-id');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'send-communication-email',
      expect.objectContaining({ communicationId: communication._id.toString() }),
      expect.any(Object)
    );

    // O payload do job precisa carregar o communicationId real. Enfileirar com
    // undefined faz o worker cair em findById(undefined) -> "Comunicação não
    // encontrada", retentar 5x e ir pra DLQ sem gravar log nenhum — a falha some
    // da aba "Envios" (regressão 2026-08-10). Antes o teste só checava que a fila
    // tinha sido chamada, e o bug passou batido.
    const [, jobPayload, jobOpts] = mockQueueAdd.mock.calls[0];
    expect(jobPayload.communicationId).toBe(communication._id.toString());
    expect(jobOpts.jobId).toContain(communication._id.toString());

    const updated = await InsuranceCommunication.findById(communication._id).lean();
    expect(updated.status).toBe('sending');
  });

  it('worker finaliza envio de email e transiciona sending -> sent', async () => {
    const communication = await createCommunication({ status: 'sending' });
    const pkg = await createPackage(communication._id, [{
      documentId: new mongoose.Types.ObjectId(),
      type: 'invoice',
      filename: 'nota-fiscal.pdf',
      url: 'https://example.com/doc.pdf',
      hash: 'abc',
      mimeType: 'application/pdf',
      size: 1234,
      includedAt: new Date()
    }]);

    await CommunicationEmailLog.create({
      communicationId: communication._id,
      communicationPackageId: pkg._id,
      to: 'financeiro@convenio.com',
      subject: 'Documentação',
      attachments: [],
      attempt: 1,
      type: EmailLogType.FIRST_SEND,
      channel: 'email',
      status: 'success',
      sentBy: user._id,
      sentAt: new Date(),
      provider: 'resend',
      messageId: '<test@resend.com>'
    });

    await handleDeliveryResult(communication._id.toString(), {
      success: true,
      log: { _id: new mongoose.Types.ObjectId() }
    });

    const updated = await InsuranceCommunication.findById(communication._id).lean();
    expect(updated.status).toBe('sent');

    const pkgUpdated = await CommunicationPackage.findById(pkg._id).lean();
    expect(pkgUpdated.status).toBe('sent');
  });

  it('permite reenvio quando comunicação já está sent', async () => {
    const communication = await createCommunication({ status: 'sent' });
    await createPackage(communication._id, [{
      documentId: new mongoose.Types.ObjectId(),
      type: 'invoice',
      filename: 'nota-fiscal.pdf',
      url: 'https://example.com/doc.pdf',
      hash: 'abc',
      mimeType: 'application/pdf',
      size: 1234,
      includedAt: new Date()
    }]);

    const result = await sendCommunication(communication._id.toString(), {
      deliveryMethod: 'email',
      to: 'financeiro@convenio.com',
      userId: user._id.toString()
    });

    expect(result.status).toBe('queued');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);

    const updated = await InsuranceCommunication.findById(communication._id).lean();
    expect(updated.status).toBe('sent');
  });
});

// ─── TESTES: VALIDAÇÕES COMUNS ──────────────────────────────────────────────────
describe('Delivery Provider - Validações comuns', () => {
  it('rejeita deliveryMethod não suportado', async () => {
    const communication = await createCommunication();

    await expect(sendCommunication(communication._id.toString(), {
      deliveryMethod: 'whatsapp',
      userId: user._id.toString()
    })).rejects.toThrow('DELIVERY_METHOD_NOT_SUPPORTED');
  });
});
