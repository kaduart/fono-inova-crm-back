import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisMock = { set: vi.fn(), del: vi.fn() };
vi.mock('../../config/redisConnection.js', () => ({
  redisConnection: redisMock,
  bullMqConnection: null,
  safeRedis: {},
}));

const startSession = vi.fn();
vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal();
  const mongoose = actual.default;
  mongoose.startSession = startSession;
  return { ...actual, default: mongoose };
});

const { cancelAllSessions } = await import('../../controllers/therapyPackageController.js');

const makeRes = () => {
  const res = { headersSent: false };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};
const makeReq = () => ({ params: { id: '507f1f77bcf86cd799439011' }, body: {}, headers: {}, user: { id: 'u1' } });

describe('cancelAllSessions — lock de idempotência (Redis)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // sem `reason` no body o controller responde 400 dentro do try → o finally (liberação do lock) roda
    startSession.mockResolvedValue({ endSession: vi.fn(), inTransaction: () => false, abortTransaction: vi.fn() });
  });

  it('lock já existente → 409 sem tocar no Mongo', async () => {
    redisMock.set.mockResolvedValue(null); // NX falhou: chave existe
    const res = makeRes();
    await cancelAllSessions(makeReq(), res);

    expect(redisMock.set).toHaveBeenCalledWith('cancel:all:507f1f77bcf86cd799439011', '1', 'EX', 30, 'NX');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(startSession).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled(); // não é dono do lock → não libera
  });

  it('lock adquirido → segue e libera o lock no fim', async () => {
    redisMock.set.mockResolvedValue('OK');
    redisMock.del.mockResolvedValue(1);
    await cancelAllSessions(makeReq(), makeRes()).catch(() => {});

    expect(startSession).toHaveBeenCalled();
    expect(redisMock.del).toHaveBeenCalledWith('cancel:all:507f1f77bcf86cd799439011');
  });

  it('Redis falhando → segue sem lock (não responde 409) e não tenta liberar', async () => {
    redisMock.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = makeRes();
    await cancelAllSessions(makeReq(), res).catch(() => {});

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(startSession).toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});
