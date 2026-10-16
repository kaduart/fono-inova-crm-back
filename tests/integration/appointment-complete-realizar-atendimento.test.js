/**
 * "Realizar atendimento" (PATCH /api/v2/appointments/:id/complete) — o mesmo endpoint que o
 * botão do calendário e, agora, o do Financeiro (PaymentPage) chamam.
 *
 * Banco em memória (replica set, por causa das transações). Sem rede e sem WhatsApp.
 * Cobre: pagamento normal, saldo devedor, pacote pré-pago, comissão (snapshot e "não remunerar")
 * e proteção contra execução duplicada (repetição e cliques simultâneos).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import moment from 'moment-timezone';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_complete_realizar';

const fakeQueue = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue({ id: 'job' }) }));
vi.mock('../../config/bullConfig.js', () => new Proxy({}, {
  get: (_t, k) => (k === '__esModule' ? true : k === 'then' ? undefined : fakeQueue),
  has: () => true,
}));
vi.mock('../../config/socket.js', () => ({ getIo: vi.fn().mockReturnValue({ emit: vi.fn() }), initializeSocket: vi.fn() }));

let Appointment, Doctor, Patient, Session, Payment, PatientBalance, Package, Admin, app, createPackageV2;
const adminId = new mongoose.Types.ObjectId();
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await import('../../models/PatientsView.js');
  await import('../../models/User.js');
  Appointment = (await import('../../models/Appointment.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Patient = (await import('../../models/Patient.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  PatientBalance = (await import('../../models/PatientBalance.js')).default;
  Package = (await import('../../models/Package.js')).default;
  Admin = (await import('../../models/Admin.js')).default;
  ({ createPackageV2 } = await import('../../controllers/packageController.v2.js'));
  const router = (await import('../../routes/appointment.v2.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/v2/appointments', router);
}, 120000);

afterAll(async () => { await mongoose.disconnect(); await mongoServer.stop(); });

beforeEach(async () => {
  await Admin.deleteMany({});
  await Admin.create({ _id: adminId, fullName: 'Admin Teste', email: 'admin@teste.com', password: 'x-123456-hash', role: 'admin' });
  await Promise.all([Appointment, Doctor, Patient, Session, Payment, PatientBalance, Package].map((m) => m.deleteMany({})));
});

const token = () => jwt.sign({ id: String(adminId), role: 'admin' }, process.env.JWT_SECRET);
const complete = (id, body = {}) => request(app).patch(`/api/v2/appointments/${id}/complete`).set('Authorization', `Bearer ${token()}`).send(body);

async function makeAvulso({ sessionValue = 150 } = {}) {
  const doctor = await Doctor.create({ fullName: 'Dra. Ana', email: `d${Math.random()}@t.com`, phoneNumber: '62999999999', licenseNumber: `C-${Math.random()}`, specialty: 'fonoaudiologia', active: true });
  const patient = await Patient.create({ fullName: 'Maria Souza', phone: '11999998888', dateOfBirth: '1990-05-15' });
  const date = moment().tz('America/Sao_Paulo').format('YYYY-MM-DD');
  const appointment = await Appointment.create({
    patient: patient._id, doctor: doctor._id, date, time: '10:00', specialty: 'fonoaudiologia',
    operationalStatus: 'scheduled', duration: 40, billingType: 'particular', sessionValue,
  });
  const session = await Session.create({
    patient: patient._id, doctor: doctor._id, date, time: '10:00', specialty: 'fonoaudiologia',
    sessionType: 'fonoaudiologia', status: 'scheduled', appointmentId: appointment._id, sessionValue,
  });
  await Appointment.updateOne({ _id: appointment._id }, { $set: { session: session._id } });
  return { doctor, patient, appointment, session };
}

describe('Realizar atendimento — pagamento normal (particular avulso)', () => {
  it('conclui, grava o recebimento uma vez e registra a comissão', async () => {
    const { appointment, session, patient } = await makeAvulso();
    const res = await complete(appointment._id, { sessionValue: 150, paymentMethod: 'pix' });
    expect(res.status).toBe(200);
    expect(res.body.processing).toMatchObject({ async: false, status: 'completed' });

    const appt = await Appointment.findById(appointment._id).lean();
    expect(appt.operationalStatus).toBe('completed');
    expect(appt.paymentStatus).toBe('paid');

    const payments = await Payment.find({ patient: patient._id }).lean();
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount: 150, status: 'paid', paymentMethod: 'pix' });

    const sess = await Session.findById(session._id).lean();
    expect(sess.status).toBe('completed');
    expect(sess.professionalPaymentStatus).toBe('payable');
    expect(sess.commissionSnapshot).toBeTruthy();

    // não é fiado: nenhum débito no saldo do paciente
    const balance = await PatientBalance.findOne({ patient: patient._id }).lean();
    expect(balance?.currentBalance || 0).toBe(0);
  });

  it('"não remunerar profissional" grava non_payable com o motivo, sem afetar o recebimento', async () => {
    const { appointment, session, patient } = await makeAvulso();
    const res = await complete(appointment._id, {
      sessionValue: 150, paymentMethod: 'pix', excludeFromProfessionalPayment: true, exclusionReason: 'sessão de cortesia',
    });
    expect(res.status).toBe(200);
    const sess = await Session.findById(session._id).lean();
    expect(sess.professionalPaymentStatus).toBe('non_payable');
    expect(sess.professionalPaymentOverride).toMatchObject({ excluded: true, reason: 'sessão de cortesia' });
    expect(await Payment.countDocuments({ patient: patient._id, status: 'paid' })).toBe(1);
  });
});

describe('Realizar atendimento — saldo devedor (conta corrente)', () => {
  it('não recebe nada agora: lança o débito no saldo e deixa o pagamento pendente', async () => {
    const { appointment, patient } = await makeAvulso();
    const res = await complete(appointment._id, {
      sessionValue: 150, addToBalance: true, balanceAmount: 150, balanceDescription: 'Sessão fiada',
    });
    expect(res.status).toBe(200);

    const appt = await Appointment.findById(appointment._id).lean();
    expect(appt.operationalStatus).toBe('completed');
    expect(appt.paymentStatus).not.toBe('paid');

    const balance = await PatientBalance.findOne({ patient: patient._id }).lean();
    expect(balance.currentBalance).toBe(150);
    expect(balance.transactions.filter((t) => t.type === 'debit')).toHaveLength(1);

    // nenhum recebimento "pago" foi criado — senão o caixa contaria o mesmo valor duas vezes
    expect(await Payment.countDocuments({ patient: patient._id, status: 'paid' })).toBe(0);
  });
});

describe('Realizar atendimento — pacote pré-pago', () => {
  async function makePrepaid() {
    const doctor = await Doctor.create({ fullName: 'Dra. Ana', email: `d${Math.random()}@t.com`, phoneNumber: '62999999999', licenseNumber: `C-${Math.random()}`, specialty: 'fonoaudiologia', active: true });
    const patient = await Patient.create({ fullName: 'Maria Souza', phone: '11999998888', dateOfBirth: '1990-05-15' });
    const base = moment().tz('America/Sao_Paulo');
    const req = {
      body: {
        type: 'package', patientId: String(patient._id), doctorId: String(doctor._id), specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia', totalSessions: 4, sessionValue: 160, totalValue: 640, model: 'prepaid',
        paymentType: 'full', paymentMethod: 'pix', payments: [{ amount: 640, method: 'pix', date: base.format('YYYY-MM-DD') }],
        sessionsPerWeek: 1, durationMonths: 1,
        schedule: [0, 7, 14, 21].map((d) => ({ date: base.clone().add(d + 1, 'days').format('YYYY-MM-DD'), time: '09:00' })),
      },
      user: { _id: new mongoose.Types.ObjectId() },
    };
    const res = { status(c) { this.statusCode = c; return this; }, json(d) { this.data = d; return this; } };
    await createPackageV2(req, res);
    if (res.statusCode !== 201) console.log('PKG', JSON.stringify(res.data));
    expect(res.statusCode).toBe(201);
    const pkg = await Package.findOne({ patient: patient._id }).lean();
    const appt = await Appointment.findOne({ patient: patient._id }).sort({ date: 1 }).lean();
    return { patient, pkg, appt };
  }

  it('consome uma sessão do pacote e NÃO cria um novo recebimento', async () => {
    const { patient, pkg, appt } = await makePrepaid();
    const paidBefore = await Payment.countDocuments({ patient: patient._id, status: 'paid' });

    const res = await complete(appt._id, {});
    expect(res.status).toBe(200);

    const after = await Appointment.findById(appt._id).lean();
    expect(after.operationalStatus).toBe('completed');
    expect(await Payment.countDocuments({ patient: patient._id, status: 'paid' })).toBe(paidBefore);
    const pkgAfter = await Package.findById(pkg._id).lean();
    expect(pkgAfter.sessionsDone).toBe((pkg.sessionsDone || 0) + 1);
  });
});

describe('Realizar atendimento — proteção contra execução duplicada', () => {
  it('repetir a chamada é idempotente: não duplica recebimento nem comissão', async () => {
    const { appointment, patient } = await makeAvulso();
    const first = await complete(appointment._id, { sessionValue: 150, paymentMethod: 'pix' });
    const second = await complete(appointment._id, { sessionValue: 150, paymentMethod: 'pix' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await Payment.countDocuments({ patient: patient._id })).toBe(1);
    expect(await Session.countDocuments({ patient: patient._id, status: 'completed' })).toBe(1);
  });

  it('dois cliques simultâneos: só um conclui; o outro é recusado ou idempotente, sem duplicar', async () => {
    const { appointment, patient } = await makeAvulso();
    const [a, b] = await Promise.all([
      complete(appointment._id, { sessionValue: 150, paymentMethod: 'pix' }),
      complete(appointment._id, { sessionValue: 150, paymentMethod: 'pix' }),
    ]);
    expect([a.status, b.status].some((s) => s === 200)).toBe(true);
    expect(await Payment.countDocuments({ patient: patient._id })).toBe(1);
  });

  it('saldo devedor repetido não lança o débito duas vezes', async () => {
    const { appointment, patient } = await makeAvulso();
    const body = { sessionValue: 150, addToBalance: true, balanceAmount: 150, balanceDescription: 'fiado' };
    await complete(appointment._id, body);
    await complete(appointment._id, body);
    const balance = await PatientBalance.findOne({ patient: patient._id }).lean();
    expect(balance.currentBalance).toBe(150);
  });
});
