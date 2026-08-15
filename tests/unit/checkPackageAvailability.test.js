import { beforeEach, describe, expect, it, vi } from 'vitest';
import Package from '../../models/Package.js';
import { checkPackageAvailability } from '../../middleware/checkPackageAvailability.js';

vi.mock('../../models/Package.js', () => ({
  default: { findById: vi.fn() },
}));

function responseMock() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

describe('checkPackageAvailability — package_session V2', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignora atendimentos que não são sessão de pacote', async () => {
    const req = { body: { serviceType: 'individual_session' } };
    const res = responseMock();
    const next = vi.fn();
    await checkPackageAvailability(req, res, next);
    expect(Package.findById).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('valida capacidade usando o vínculo package do payload V2', async () => {
    const pkg = { _id: 'pkg-1', status: 'active', remainingSessions: 2 };
    Package.findById.mockResolvedValue(pkg);
    const req = { body: { serviceType: 'package_session', package: 'pkg-1' } };
    const res = responseMock();
    const next = vi.fn();
    await checkPackageAvailability(req, res, next);
    expect(Package.findById).toHaveBeenCalledWith('pkg-1');
    expect(req.packageData).toBe(pkg);
    expect(next).toHaveBeenCalledOnce();
  });

  it('bloqueia pacote inativo antes de criar Appointment/Session', async () => {
    Package.findById.mockResolvedValue({ status: 'canceled', remainingSessions: 2 });
    const req = { body: { serviceType: 'package_session', package: 'pkg-1' } };
    const res = responseMock();
    const next = vi.fn();
    await checkPackageAvailability(req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PACKAGE_INACTIVE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('bloqueia pacote sem capacidade', async () => {
    Package.findById.mockResolvedValue({ status: 'active', remainingSessions: 0 });
    const req = { body: { serviceType: 'package_session', packageId: 'pkg-1' } };
    const res = responseMock();
    const next = vi.fn();
    await checkPackageAvailability(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
