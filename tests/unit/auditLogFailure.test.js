import { describe, it, expect, vi, beforeEach } from 'vitest';

const { save, sendAlert } = vi.hoisted(() => ({ save: vi.fn(), sendAlert: vi.fn() }));
vi.mock('../../models/AuditLog.js', () => ({ default: class { save() { return save(); } } }));
vi.mock('../../config/featureFlags.js', () => ({ FeatureFlags: { AUDIT: { ENABLED: true } } }));
vi.mock('../../infrastructure/alerts/alertService.js', () => ({ sendAlert }));

import { recordAudit, getAuditFailureStats, isTransientAuditError } from '../../services/auditLogService.js';

const record = () => recordAudit({
  user: null, action: 'appointment_canceled', entityType: 'Appointment',
  entityId: '69c145a0c19d35b8454a293a', source: 'test', correlationId: 'c-1',
  before: { operationalStatus: 'scheduled', notes: 'dado pessoal' }, after: { operationalStatus: 'canceled' },
});

function networkError() {
  const err = new Error('socket closed');
  err.name = 'MongoNetworkError';
  return err;
}

describe('recordAudit: falha visível', () => {
  beforeEach(() => {
    save.mockReset();
    sendAlert.mockReset();
    sendAlert.mockResolvedValue({ sent: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('não alerta quando a gravação funciona', async () => {
    save.mockResolvedValue(undefined);
    await record();
    expect(save).toHaveBeenCalledTimes(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('tenta de novo uma vez em erro transitório e não alerta se a segunda passar', async () => {
    save.mockRejectedValueOnce(networkError()).mockResolvedValueOnce(undefined);
    const before = getAuditFailureStats();
    await record();
    expect(save).toHaveBeenCalledTimes(2);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(getAuditFailureStats().retriedOk).toBe(before.retriedOk + 1);
  });

  it('alerta quando o erro transitório persiste, sem lançar para quem chamou', async () => {
    save.mockRejectedValue(networkError());
    const before = getAuditFailureStats();
    await expect(record()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(getAuditFailureStats().failures).toBe(before.failures + 1);
  });

  it('não repete erro de validação e alerta sem before/after no payload', async () => {
    const err = new Error('Cast to ObjectId failed');
    err.name = 'ValidationError';
    save.mockRejectedValue(err);
    await record();
    expect(save).toHaveBeenCalledTimes(1);
    const payload = sendAlert.mock.calls[0][0];
    expect(payload).toMatchObject({ level: 'critical', type: 'audit_write_failed' });
    expect(payload.details).toMatchObject({ action: 'appointment_canceled', entityType: 'Appointment', correlationId: 'c-1', errorName: 'ValidationError' });
    expect(JSON.stringify(payload)).not.toContain('dado pessoal');
  });

  it('falha do próprio alerta não quebra o fluxo', async () => {
    save.mockRejectedValue(new Error('boom'));
    sendAlert.mockRejectedValue(new Error('slack fora'));
    await expect(record()).resolves.toBeUndefined();
  });

  it('classifica erros transitórios', () => {
    expect(isTransientAuditError(networkError())).toBe(true);
    expect(isTransientAuditError({ name: 'X', hasErrorLabel: (l) => l === 'RetryableWriteError' })).toBe(true);
    expect(isTransientAuditError(new Error('x'))).toBe(false);
    expect(isTransientAuditError(null)).toBe(false);
  });
});
