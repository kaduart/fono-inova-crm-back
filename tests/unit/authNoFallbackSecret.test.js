import { afterEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { auth } from '../../middleware/auth.js';

const saved = process.env.JWT_SECRET;

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

afterEach(() => {
  if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved;
  vi.restoreAllMocks();
});

describe('auth sem fallback de segredo', () => {
  it('recusa token assinado com "secreta" quando JWT_SECRET não está definido', async () => {
    delete process.env.JWT_SECRET;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const forged = jwt.sign({ id: '507f1f77bcf86cd799439011', role: 'admin' }, 'secreta');
    const res = response();
    const next = vi.fn();
    await auth({ headers: { authorization: `Bearer ${forged}` }, query: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    // falha na VERIFICAÇÃO da assinatura (não depois, na busca do usuário)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });
});
