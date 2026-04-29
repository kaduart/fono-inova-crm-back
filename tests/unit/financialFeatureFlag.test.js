/**
 * Testes de integração do financialFeatureFlag middleware.
 * Valida que o rollout V1→V2 funciona corretamente.
 */

import { jest } from '@jest/globals';

// Mock do User model antes de importar o middleware
jest.unstable_mockModule('../../models/User.js', () => ({
  default: {
    findById: jest.fn()
  }
}));

jest.unstable_mockModule('../../infrastructure/featureFlags/featureFlags.js', () => ({
  isEnabled: jest.fn()
}));

const { financialFeatureFlag } = await import('../../middleware/financialFeatureFlag.js');
const { default: User } = await import('../../models/User.js');
const { isEnabled } = await import('../../infrastructure/featureFlags/featureFlags.js');

function makeReq(overrides = {}) {
  return {
    headers: {},
    query: {},
    params: {},
    user: null,
    ...overrides
  };
}

function makeRes() {
  return {};
}

function makeNext() {
  return jest.fn();
}

describe('financialFeatureFlag middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(false); // default: ledger desabilitado
    User.findById.mockResolvedValue(null);
  });

  describe('V1 (default — flag desabilitado)', () => {
    it('atribui v1 quando ledger está desabilitado e sem header/query', async () => {
      const req = makeReq({ user: { _id: 'user1' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v1');
    });

    it('força v1 mesmo com header v2 quando ledger desabilitado', async () => {
      const req = makeReq({ headers: { 'x-financial-version': 'v2' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v1');
    });

    it('força v1 mesmo com query v2 quando ledger desabilitado', async () => {
      const req = makeReq({ query: { financialVersion: 'v2' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v1');
    });

    it('força v1 quando modo dual e ledger desabilitado', async () => {
      const req = makeReq({ headers: { 'x-financial-version': 'dual' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v1');
    });
  });

  describe('V2 (flag habilitado)', () => {
    beforeEach(() => {
      isEnabled.mockReturnValue(true);
    });

    it('atribui v2 via header quando ledger habilitado', async () => {
      const req = makeReq({ headers: { 'x-financial-version': 'v2' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v2');
    });

    it('atribui v2 via query quando ledger habilitado', async () => {
      const req = makeReq({ query: { financialVersion: 'v2' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v2');
    });

    it('atribui dual via header quando ledger habilitado', async () => {
      const req = makeReq({ headers: { 'x-financial-version': 'dual' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('dual');
    });

    it('header tem prioridade sobre query', async () => {
      const req = makeReq({
        headers: { 'x-financial-version': 'v1' },
        query: { financialVersion: 'v2' }
      });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v1');
    });

    it('usa preferência do usuário no banco quando sem header/query', async () => {
      User.findById.mockResolvedValue({ financialVersion: 'v2' });
      const req = makeReq({ user: { _id: 'user1' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v2');
    });
  });

  describe('Segurança e fallback', () => {
    it('rejeita version inválida no header e cai para v1', async () => {
      const req = makeReq({ headers: { 'x-financial-version': 'v99' } });
      await financialFeatureFlag(req, makeRes(), makeNext());
      expect(req.financialVersion).toBe('v1');
    });

    it('sempre chama next()', async () => {
      const next = makeNext();
      await financialFeatureFlag(makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('fallback para v1 em caso de erro no User.findById', async () => {
      isEnabled.mockReturnValue(true);
      User.findById.mockRejectedValue(new Error('DB error'));
      const req = makeReq({ user: { _id: 'user1' } });
      const next = makeNext();
      await financialFeatureFlag(req, makeRes(), next);
      expect(req.financialVersion).toBe('v1');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
