import { describe, expect, it, vi } from 'vitest';
import { resolveAttendancePollVoterPhone } from '../../utils/attendancePollVoter.js';

describe('resolveAttendancePollVoterPhone', () => {
  it('mantém o telefone recebido como @c.us', async () => {
    const phone = await resolveAttendancePollVoterPhone({
      voter: { _serialized: '5562999999999@c.us' },
    });

    expect(phone).toBe('5562999999999');
  });

  it('resolve votante @lid para o telefone real', async () => {
    const getContactLidAndPhone = vi.fn().mockResolvedValue([
      { lid: '123456789012345@lid', pn: '5562999999999@c.us' },
    ]);

    const phone = await resolveAttendancePollVoterPhone(
      { voter: { _serialized: '123456789012345@lid' } },
      { getContactLidAndPhone }
    );

    expect(phone).toBe('5562999999999');
    expect(getContactLidAndPhone).toHaveBeenCalledWith(['123456789012345@lid']);
  });

  it('retorna null quando o @lid não pode ser resolvido', async () => {
    const phone = await resolveAttendancePollVoterPhone(
      { voter: { _serialized: '123456789012345@lid' } },
      { getContactLidAndPhone: vi.fn().mockResolvedValue([]) }
    );

    expect(phone).toBeNull();
  });
});
