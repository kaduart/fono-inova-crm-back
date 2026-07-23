/**
 * Testes de closeGuideBillingPeriod — fechamento automático de período de
 * faturamento de guia per_month (cancela appointments pendentes vinculados).
 *
 * Ver plano: /home/user/.claude/plans/purring-sleeping-allen.md
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let mongoServer;
let Appointment;
let InsuranceGuide;
let closeGuideBillingPeriod;

beforeAll(async () => {
  // closeGuideBillingPeriod usa mongoose.startSession()/transação — precisa de replica set,
  // um MongoMemoryServer standalone não suporta transactionNumber.
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  // Import dinâmico DEPOIS de conectar e registrar os models reais — InsuranceGuide.js
  // importa identityResolver.js, que resolve mongoose.model('PatientsView') no topo do
  // módulo; se o serviço fosse importado estaticamente no topo deste arquivo, isso
  // rodaria antes de models/index.js registrar tudo, e quebraria com MissingSchemaError.
  await import('../../../models/index.js');
  ({ closeGuideBillingPeriod } = await import('../closeGuideBillingPeriod.js'));
  Appointment = mongoose.model('Appointment');
  InsuranceGuide = mongoose.model('InsuranceGuide');
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Appointment.collection.deleteMany({});
  await InsuranceGuide.collection.deleteMany({});
});

let guideCounter = 0;
const createGuide = (overrides = {}) => {
  guideCounter += 1;
  return InsuranceGuide.create({
    number: `TESTE-${guideCounter}`,
    patientId: new mongoose.Types.ObjectId(),
    specialty: 'fonoaudiologia',
    insurance: 'unimed-teste',
    totalSessions: 10,
    expiresAt: new Date('2099-01-01'),
    billingMode: 'per_month',
    ...overrides
  });
};

const createAppointment = (guideId, overrides = {}) => Appointment.create({
  date: new Date(),
  time: '10:00',
  patient: new mongoose.Types.ObjectId(),
  doctor: new mongoose.Types.ObjectId(),
  specialty: 'fonoaudiologia',
  operationalStatus: 'scheduled',
  insuranceGuide: guideId,
  // bypass do guard "[SECURITY] operationalStatus=completed só via completeSessionService"
  // — aqui é só fixture de teste, não o fluxo real de conclusão
  ...(overrides.operationalStatus === 'completed' ? { _fromCompleteService: true } : {}),
  ...overrides
});

describe('closeGuideBillingPeriod', () => {
  it('faz skip em guia per_guide (não mexe em nada)', async () => {
    const guide = await createGuide({ billingMode: 'per_guide' });
    await createAppointment(guide._id);

    const result = await closeGuideBillingPeriod(guide._id, { userId: new mongoose.Types.ObjectId() });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('not_per_month');

    const appt = await Appointment.findOne({ insuranceGuide: guide._id });
    expect(appt.operationalStatus).toBe('scheduled');
  });

  it('faz skip quando a guia não existe', async () => {
    const result = await closeGuideBillingPeriod(new mongoose.Types.ObjectId());
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('guide_not_found');
  });

  it('cancela appointments pendentes (passados e futuros) de guia per_month, sem tocar em completed', async () => {
    const guide = await createGuide();
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

    const pastPending = await createAppointment(guide._id, { date: past, operationalStatus: 'scheduled' });
    const futurePending = await createAppointment(guide._id, { date: future, operationalStatus: 'confirmed' });
    const preAgendado = await createAppointment(guide._id, { operationalStatus: 'pre_agendado' });
    const alreadyCompleted = await createAppointment(guide._id, { operationalStatus: 'completed' });

    const userId = new mongoose.Types.ObjectId();
    const result = await closeGuideBillingPeriod(guide._id, { userId });

    expect(result.skipped).toBe(false);
    expect(result.canceled).toBe(3);
    expect(result.errors).toEqual([]);

    const reloadedGuide = await InsuranceGuide.findById(guide._id);
    expect(reloadedGuide.status).toBe('closed');
    expect(reloadedGuide.closedAt).toBeInstanceOf(Date);
    expect(reloadedGuide.closedBy).toEqual(userId);

    const reloaded = await Appointment.find({ _id: { $in: [pastPending._id, futurePending._id, preAgendado._id] } });
    for (const a of reloaded) {
      expect(a.operationalStatus).toBe('canceled');
      expect(a.cancelReason).toBe('guide_cycle_closed');
      expect(a.cancelSource).toBe('guide_closure');
    }

    const completedReloaded = await Appointment.findById(alreadyCompleted._id);
    expect(completedReloaded.operationalStatus).toBe('completed');
  });

  it('não faz nada e retorna canceled:0 quando a guia não tem appointments pendentes', async () => {
    const guide = await createGuide();
    await createAppointment(guide._id, { operationalStatus: 'completed' });

    const result = await closeGuideBillingPeriod(guide._id, { userId: new mongoose.Types.ObjectId() });

    expect(result.skipped).toBe(false);
    expect(result.canceled).toBe(0);
  });

  it('é idempotente — chamar duas vezes não gera erro nem duplica efeito', async () => {
    const guide = await createGuide();
    await createAppointment(guide._id, { operationalStatus: 'scheduled' });

    const first = await closeGuideBillingPeriod(guide._id, { userId: new mongoose.Types.ObjectId() });
    expect(first.canceled).toBe(1);

    const second = await closeGuideBillingPeriod(guide._id, { userId: new mongoose.Types.ObjectId() });
    expect(second.skipped).toBe(false);
    expect(second.canceled).toBe(0);
    expect(second.errors).toEqual([]);
  });
});
