/**
 * 19/11/2026: 1 aquisição por telefone (família). Irmãos agendados pelo mesmo contato com 1,5 min de
 * diferença geraram 2 Purchases no Meta (o índice único é por paciente). A mais antiga fica como aquisição.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { conversions: [], appointments: [], patients: {} };
const matches = (doc, q) => Object.entries(q).every(([k, v]) => {
  const val = doc[k];
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('$in' in v) return v.$in.map(String).includes(String(val));
    if ('$ne' in v) return String(val) !== String(v.$ne);
    if ('$gte' in v) return val >= v.$gte;
    if ('$lt' in v) return val < v.$lt;
  }
  return String(val) === String(v);
});
const chain = (rows) => ({ select: () => chain(rows), sort: () => chain(rows), limit: () => chain(rows), lean: async () => rows });

vi.mock('../../models/AdConversion.js', () => ({ default: {
  exists: async (q) => db.conversions.some((c) => matches(c, q)),
  find: (q) => chain(db.conversions.filter((c) => matches(c, { appointment: q.appointment }))),
  create: async (doc) => { db.conversions.push({ ...doc, createdAt: new Date() }); return doc; },
} }));
vi.mock('../../models/Appointment.js', () => ({ default: {
  find: (q) => chain(q.operationalStatus
    ? [...db.appointments].sort((a, b) => b.createdAt - a.createdAt)
    : db.appointments.filter((a) => matches(a, q))),
} }));
vi.mock('../../models/Patient.js', () => ({ default: {
  findById: (id) => ({ select: () => ({ lean: async () => db.patients[String(id)] || null }) }),
} }));
vi.mock('../../services/leadAttributionService.js', () => ({
  getAttributionByPhone: async () => null, getAttributionsByPhones: async () => new Map(), findGclidForConversion: async () => null,
}));
vi.mock('../../services/metaConversionsService.js', () => ({ sendPurchaseToMeta: vi.fn() }));
vi.mock('../../services/googleAdsConversionsService.js', () => ({ uploadOfflineConversion: vi.fn() }));
vi.mock('../../services/tiktokConversionsService.js', () => ({ sendEventToTikTok: vi.fn() }));

const { enqueueNew } = await import('../../crons/adsConversion.cron.js');
const { acquisitionPhoneVariants, decidePlatforms } = await import('../../crons/adsConversion.logic.js');

const t0 = Date.now() - 3600e3;
const appt = (id, patient, minutes, phone) => ({
  _id: id, patient, createdAt: new Date(t0 + minutes * 60e3), updatedAt: new Date(t0 + minutes * 60e3),
  operationalStatus: 'scheduled', patientInfo: { phone }, sessionValue: 200, history: [],
});

beforeEach(() => { db.conversions = []; db.appointments = []; db.patients = {}; });

describe('acquisitionPhoneVariants', () => {
  it('cobre com e sem o 9, com e sem +', () => {
    expect(acquisitionPhoneVariants('(62) 99999-4462')).toEqual(
      ['5562999994462', '+5562999994462', '556299994462', '+556299994462']);
  });
  it('vazio não gera variante', () => { expect(acquisitionPhoneVariants(null)).toEqual([]); });
});

describe('decidePlatforms com motivo de não-aquisição', () => {
  it('usa o motivo informado', () => {
    expect(decidePlatforms({ first: false, phone: '5562999994462', skipReason: 'aquisicao_mesmo_telefone' }).meta.reason)
      .toBe('aquisicao_mesmo_telefone');
  });
});

describe('enqueueNew: irmãos com o mesmo telefone', () => {
  it('só o agendamento mais antigo vira aquisição; o irmão é pulado', async () => {
    db.appointments = [appt('a1', 'p1', 0, '62999994462'), appt('a2', 'p2', 1.5, '5562999994462')];
    await enqueueNew();
    const byAppt = Object.fromEntries(db.conversions.map((c) => [c.appointment, c]));
    expect(byAppt.a1.isAcquisition).toBe(true);
    expect(byAppt.a2.isAcquisition).toBe(false);
    expect(byAppt.a2.meta.reason).toBe('aquisicao_mesmo_telefone');
  });
  it('telefones diferentes: cada paciente novo continua sendo aquisição', async () => {
    db.appointments = [appt('a1', 'p1', 0, '62999994462'), appt('a2', 'p2', 1.5, '62988881111')];
    await enqueueNew();
    expect(db.conversions.filter((c) => c.isAcquisition)).toHaveLength(2);
  });
});
