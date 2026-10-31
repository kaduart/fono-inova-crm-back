import { describe, it, expect, vi } from 'vitest';
import { canUpdateDoctor } from '../../routes/doctor.v2.js';

const run = (user, id, body) => {
  const req = { user, params: { id }, body: { ...body } };
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  const next = vi.fn();
  canUpdateDoctor(req, res, next);
  return { req, res, next };
};

describe('PUT /v2/doctors/:id — quem pode editar', () => {
  it('secretária edita qualquer profissional com todos os campos', () => {
    const { next, req } = run({ role: 'secretary' }, 'd1', { commissionRules: {}, fullName: 'X' });
    expect(next).toHaveBeenCalled();
    expect(req.body.commissionRules).toBeDefined();
  });
  it('terapeuta edita o próprio cadastro, só dados pessoais', () => {
    const { next, req } = run({ role: 'doctor', id: 'd1' }, 'd1', { fullName: 'Ana', commissionRules: { a: 1 }, active: false, email: 'x@y' });
    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ fullName: 'Ana' });
  });
  it('terapeuta não edita outro profissional', () => {
    const { next, res } = run({ role: 'doctor', id: 'd1' }, 'd2', { fullName: 'X' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
