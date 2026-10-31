// Timeout ao inativar guia (2026-10-30, guia 15809471): efeitos pós-commit,
// descarte em abort e dedupe de inativações concorrentes da mesma guia.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeSession = () => ({
  startTransaction: vi.fn(),
  commitTransaction: vi.fn(),
  abortTransaction: vi.fn(),
  endSession: vi.fn(),
});
let sessions = [];
vi.mock('mongoose', () => ({
  default: { startSession: vi.fn(async () => { const s = fakeSession(); sessions.push(s); return s; }) },
}));

const { registerAfterCommit } = await import('../../utils/afterCommit.js');
const { runTransactionWithRetry } = await import('../../utils/transactionRetry.js');
const flush = () => new Promise(r => setTimeout(r, 10));

describe('afterCommit + runTransactionWithRetry', () => {
  beforeEach(() => { sessions = []; });

  it('roda o efeito só depois do commit', async () => {
    const order = [];
    await runTransactionWithRetry(async (session) => {
      session.commitTransaction.mockImplementation(() => order.push('commit'));
      expect(registerAfterCommit(session, async () => order.push('effect'))).toBe(true);
      order.push('body');
    });
    await flush();
    expect(order).toEqual(['body', 'commit', 'effect']);
  });

  it('descarta o efeito de uma tentativa abortada por WriteConflict', async () => {
    const effect = vi.fn();
    let attempt = 0;
    await runTransactionWithRetry(async (session) => {
      attempt++;
      registerAfterCommit(session, effect);
      if (attempt === 1) { const e = new Error('wc'); e.code = 112; throw e; }
    });
    await flush();
    expect(attempt).toBe(2);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('sem transação gerenciada devolve false (chamador roda inline)', () => {
    expect(registerAfterCommit(undefined, vi.fn())).toBe(false);
    expect(registerAfterCommit({}, vi.fn())).toBe(false);
  });
});
