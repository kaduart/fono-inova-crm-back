import { describe, it, expect, vi, beforeEach } from 'vitest';
const { save, captured } = vi.hoisted(() => ({ save: vi.fn(), captured: [] }));
vi.mock('../../models/AuditLog.js', () => ({ default: class {
  constructor(data) { captured.push(data); }
  save() { return save(); }
} }));
vi.mock('../../config/featureFlags.js', () => ({ FeatureFlags: { AUDIT: { ENABLED: true } } }));
import { recordAudit } from '../../services/auditLogService.js';

describe('Audit actor identity', () => {
  beforeEach(() => { captured.length = 0; save.mockReset(); save.mockResolvedValue(undefined); });
  const record = user => recordAudit({ user, action: 'appointment_canceled', entityType: 'Appointment',
    entityId: '69c145a0c19d35b8454a293a', source: 'test', before: { operationalStatus: 'scheduled' }, after: { operationalStatus: 'canceled' } });
  it('attributes authenticated id-shaped users to their real role', async () => {
    await record({ id: '6a2806fbd330bd5bec8e8d37', role: 'admin' });
    expect(captured[0]).toMatchObject({ userId: '6a2806fbd330bd5bec8e8d37', actorRole: 'admin' });
  });
  it('preserves existing _id-shaped actors', async () => {
    await record({ _id: '6a2806fbd330bd5bec8e8d37', role: 'receptionist' });
    expect(captured[0].actorRole).toBe('receptionist');
    expect(captured[0].userId).toBe('6a2806fbd330bd5bec8e8d37');
  });
  it('keeps genuinely automated events identified as system', async () => {
    await record(null);
    expect(captured[0]).toMatchObject({ userId: null, actorRole: 'SYSTEM' });
  });
});
