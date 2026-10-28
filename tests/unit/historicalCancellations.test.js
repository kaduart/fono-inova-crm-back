import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCancellations, classifyExistingCancellation } from '../../services/liminar/historicalCancellationRules.js';
const mocks = vi.hoisted(() => {
  const state = { existing: [], writes: [], plan: null, contract: null, doctor: { _id: '68bedf1104ec4875aaea8188' } };
  const query = value => ({ select() { return this; }, session() { return this; }, lean: async () => value });
  const session = { withTransaction: async cb => cb(), endSession: vi.fn() };
  return { state, query, session };
});
vi.mock('mongoose', () => ({ default: { isValidObjectId: x => /^[a-f\d]{24}$/i.test(String(x)), startSession: async () => mocks.session } }));
vi.mock('../../models/Appointment.js', () => ({ default: {
  find: () => mocks.query(mocks.state.existing),
  insertMany: async docs => { mocks.state.writes.push(['appointment', docs]); return docs.map(d => ({ ...d, _id: 'aaaaaaaaaaaaaaaaaaaaaaaa' })); },
  updateOne: async (...args) => { mocks.state.writes.push(['link', args]); },
} }));
vi.mock('../../models/Session.js', () => ({ default: { insertMany: async docs => { mocks.state.writes.push(['session', docs]); return [{ ...docs[0], _id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }]; } } }));
vi.mock('../../models/Doctor.js', () => ({ default: { findById: () => mocks.query(mocks.state.doctor) } }));
vi.mock('../../models/TherapeuticPlan.js', () => ({ default: {
  findOne: () => mocks.query(mocks.state.plan), updateOne: async () => { mocks.state.writes.push(['planLock']); },
} }));
vi.mock('../../models/LiminarContract.js', () => ({ default: { findById: () => mocks.query(mocks.state.contract) } }));
import { recordHistoricalCancellations } from '../../services/liminar/recordHistoricalCancellations.js';

const row = { specialty: 'fonoaudiologia', date: '2026-09-29', time: '14:00', doctorId: '68bedf1104ec4875aaea8188', sessionValue: 160, reason: 'Paciente solicitou cancelamento', cancelRequester: 'patient' };
const contractId = '111111111111111111111111', planId = '222222222222222222222222', patient = '333333333333333333333333';
const args = extra => ({ contractId, planId, cancellations: [row], dryRun: true, user: { id: '444444444444444444444444' }, ...extra });
beforeEach(() => {
  mocks.state.writes = []; mocks.state.existing = []; mocks.state.doctor = { _id: row.doctorId };
  mocks.state.plan = { _id: planId, patient, liminarContract: contractId, therapies: { fonoaudiologia: {} }, version: 1 };
  mocks.state.contract = { _id: contractId, patient, creditBalance: 1000, usedCredit: 100 };
});
describe('cancelamento histórico', () => {
  it('valida uma entrada explícita sem presumir data do pedido', () => expect(normalizeCancellations([row])[0].cancelRequestedAt).toBeNull());
  it.each(['2026-02-30', 'inválido', '2026-13-01'])('rejeita data impossível %s', date => expect(() => normalizeCancellations([{ ...row, date }])).toThrow());
  it('não preenche valor, horário, profissional ou solicitante ausentes', () => {
    for (const field of ['sessionValue', 'time', 'doctorId', 'cancelRequester']) expect(() => normalizeCancellations([{ ...row, [field]: undefined }])).toThrow();
  });
  it('rejeita horário impossível e duplicata no lote', () => {
    expect(() => normalizeCancellations([{ ...row, time: '25:00' }])).toThrow();
    expect(() => normalizeCancellations([row, row])).toThrow('repetido');
  });
  it('prévia não escreve nada', async () => {
    const result = await recordHistoricalCancellations(args()); expect(result.decisions[0].action).toBe('create'); expect(mocks.state.writes).toEqual([]);
  });
  it('cria apenas appointment e sessão cancelados e vínculo, com autoria e sem data do pedido inventada', async () => {
    const result = await recordHistoricalCancellations(args({ dryRun: false }));
    expect(result.created).toBe(1); expect(mocks.state.writes.map(w => w[0])).toEqual(['planLock', 'appointment', 'session', 'link']);
    const ap = mocks.state.writes[1][1][0], s = mocks.state.writes[2][1][0];
    expect(ap.operationalStatus).toBe('canceled'); expect(s.status).toBe('canceled'); expect(s.isPaid).toBe(false);
    expect(ap.cancelRequestedAt).toBeNull(); expect(ap.history[0].details.historicalCancellation).toBe(true);
    expect(mocks.state.contract.creditBalance).toBe(1000); expect(mocks.state.contract.usedCredit).toBe(100);
    expect(ap.date.toISOString()).toBe('2026-09-29T17:00:00.000Z');
  });
  it('reexecução preserva cancelado existente sem escrever', async () => {
    mocks.state.existing = [{ _id: 'existing', doctor: row.doctorId, specialty: row.specialty, liminarContract: contractId, operationalStatus: 'canceled' }];
    const result = await recordHistoricalCancellations(args({ dryRun: false }));
    expect(result.created).toBe(0); expect(result.preserved).toBe(1); expect(mocks.state.writes).toEqual([]);
  });
  it.each(['completed', 'scheduled', 'confirmed', 'missed'])('não altera atendimento %s', async operationalStatus => {
    mocks.state.existing = [{ operationalStatus }]; const result = await recordHistoricalCancellations(args({ dryRun: false }));
    expect(result.conflicts).toHaveLength(1); expect(mocks.state.writes).toEqual([]);
  });
  it('não trata cancelamento de outro contrato ou profissional como equivalente', () => {
    expect(classifyExistingCancellation(row, [{ operationalStatus: 'canceled', doctor: row.doctorId, specialty: row.specialty, liminarContract: 'other' }], contractId).action).toBe('conflict');
  });
  it('bloqueia paciente divergente entre plano e contrato', async () => {
    mocks.state.plan.patient = 'other'; await expect(recordHistoricalCancellations(args({ dryRun: false }))).rejects.toThrow('incompatíveis'); expect(mocks.state.writes).toEqual([]);
  });
  it('bloqueia profissional de outra clínica', async () => {
    mocks.state.contract.clinicId = 'a'; mocks.state.doctor.clinicId = 'b'; await expect(recordHistoricalCancellations(args())).rejects.toThrow('outra clínica');
  });
  it('permite registrar cancelamento informado de uma data futura sem criar atendimento ativo', async () => {
    const result = await recordHistoricalCancellations(args({ cancellations: [{ ...row, date: '2099-01-01' }], dryRun: false }));
    expect(result.created).toBe(1); expect(mocks.state.writes[1][1][0].operationalStatus).toBe('canceled');
  });
  it('exige dryRun explícito e usuário válido', async () => {
    await expect(recordHistoricalCancellations(args({ dryRun: undefined }))).rejects.toThrow('dryRun');
    await expect(recordHistoricalCancellations(args({ user: {} }))).rejects.toThrow('autenticado');
  });
});
