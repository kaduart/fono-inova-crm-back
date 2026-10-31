/**
 * Gestão › Secretárias (auditoria 31/10/2026): desativar/reativar e redefinir senha.
 * Só admin. Mocka auth (injeta req.user pelo header) e o model Admin.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../middleware/auth.js', () => ({
  auth: (req, _res, next) => {
    req.user = { id: req.headers['x-uid'] || 'admin1', role: req.headers['x-role'] || 'admin' };
    next();
  },
}));

const saveMock = vi.fn();
const adminDoc = { _id: 's1', role: 'secretary', password: 'old', save: saveMock };
vi.mock('../../models/Admin.js', () => ({
  default: {
    find: () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }),
    findOneAndUpdate: vi.fn((q, u) => ({ select: async () => (q._id === 'missing' ? null : { _id: q._id, role: 'secretary', active: u.$set?.active ?? true }) })),
    findOne: () => ({ select: async () => (globalThis.__found === false ? null : adminDoc) }),
  },
}));
vi.mock('../../models/Appointment.js', () => ({ default: {} }));
vi.mock('../../models/Doctor.js', () => ({ default: {} }));
vi.mock('../../models/User.js', () => ({ default: {} }));
vi.mock('../../models/Patient.js', () => ({ default: {} }));

const adminRouter = (await import('../../routes/admin.js')).default;
const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

const as = (role, uid = 'admin1') => ({ 'x-role': role, 'x-uid': uid });

beforeEach(() => { saveMock.mockReset(); globalThis.__found = true; });

describe('PATCH /secretaries/:id/active', () => {
  it('secretária logada não desativa ninguém (403)', async () => {
    const r = await request(app).patch('/api/admin/secretaries/s1/active').set(as('secretary')).send({ active: false });
    expect(r.status).toBe(403);
  });
  it('admin desativa secretária', async () => {
    const r = await request(app).patch('/api/admin/secretaries/s1/active').set(as('admin')).send({ active: false });
    expect(r.status).toBe(200);
    expect(r.body.data.active).toBe(false);
  });
  it('admin não desativa a própria conta', async () => {
    const r = await request(app).patch('/api/admin/secretaries/admin1/active').set(as('admin', 'admin1')).send({ active: false });
    expect(r.status).toBe(400);
  });
  it('active ausente → 400', async () => {
    const r = await request(app).patch('/api/admin/secretaries/s1/active').set(as('admin')).send({});
    expect(r.status).toBe(400);
  });
});

describe('PATCH /secretaries/:id/reset-password', () => {
  it('admin redefine senha (>=6) e salva', async () => {
    const r = await request(app).patch('/api/admin/secretaries/s1/reset-password').set(as('admin')).send({ password: 'novaSenha1' });
    expect(r.status).toBe(200);
    expect(saveMock).toHaveBeenCalled();
    expect(adminDoc.password).toBe('novaSenha1');
  });
  it('senha curta → 400 e não salva', async () => {
    const r = await request(app).patch('/api/admin/secretaries/s1/reset-password').set(as('admin')).send({ password: '123' });
    expect(r.status).toBe(400);
    expect(saveMock).not.toHaveBeenCalled();
  });
  it('secretária não redefine senha (403)', async () => {
    const r = await request(app).patch('/api/admin/secretaries/s1/reset-password').set(as('secretary')).send({ password: 'novaSenha1' });
    expect(r.status).toBe(403);
  });
});
