import { describe, it, expect } from 'vitest';
import { matchTherapySlots } from '../../services/liminar/matchTherapySlots.js';

const appointment = (id, date, time = '18:20') => ({ _id: id, date, time });
describe('Weekly therapy edits', () => {
  it('preserves the weekly slot on every future date', () => {
    const result = matchTherapySlots([
      appointment('a', '2026-09-22T00:00:00Z'),
      appointment('b', '2026-09-29T12:00:00Z'),
      appointment('c', '2026-10-06T21:20:00Z')
    ], [{ dayOfWeek: 2, time: '18:20' }]);
    expect(result.toCancelIds).toEqual([]);
    expect([...result.timeSyncMap.values()]).toEqual(['18:20', '18:20', '18:20']);
  });
  it('moves two weekly slots independently on each date', () => {
    const rows = ['2026-09-22', '2026-09-29'].flatMap(day => [
      appointment(day + 'a', day, '14:00'), appointment(day + 'b', day, '16:00')]);
    const result = matchTherapySlots(rows, [{ dayOfWeek: 2, time: '14:40' }, { dayOfWeek: 2, time: '16:40' }]);
    expect(result.toCancelIds).toEqual([]);
    expect([...result.timeSyncMap.values()]).toEqual(['14:40', '16:40', '14:40', '16:40']);
  });
  it('preserves exact slots before assigning moved appointments', () => {
    const result = matchTherapySlots([appointment('a', '2026-09-22', '13:40'), appointment('b', '2026-09-22', '14:00')],
      [{ dayOfWeek: 2, time: '14:00' }, { dayOfWeek: 2, time: '16:00' }]);
    expect(result.timeSyncMap.get('b')).toBe('14:00');
    expect(result.timeSyncMap.get('a')).toBe('16:00');
  });
  it('cancels only removed days or excess appointments on the same date', () => {
    const result = matchTherapySlots([appointment('a', '2026-09-22'), appointment('b', '2026-09-22'),
      appointment('c', '2026-09-29'), appointment('d', '2026-09-23')], [{ dayOfWeek: 2, time: '18:20' }]);
    expect(result.toCancelIds).toEqual(['b', 'd']);
    expect([...result.timeSyncMap.keys()]).toEqual(['a', 'c']);
  });
});
