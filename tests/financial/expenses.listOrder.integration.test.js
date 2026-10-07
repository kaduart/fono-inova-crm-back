import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../config/redisConnection.js', () => ({ safeRedis: {}, redisConnection: null, bullMqConnection: null }));

let replSet;
let Expense;
let buildExpenseListPipeline;
let EXPENSE_LIST_COLLATION;
let toObjectIdIfValid;
const doctorIds = {};

const run = (filters, skip = 0, limit = 50) =>
  Expense.aggregate(buildExpenseListPipeline({ filters, skip, limit }), EXPENSE_LIST_COLLATION);
const names = (rows) => rows.map((r) => r.relatedDoctor?.fullName ?? `(sem profissional) ${r.description}`);

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await import('../../models/index.js');
  ({ buildExpenseListPipeline, EXPENSE_LIST_COLLATION, toObjectIdIfValid } = await import('../../routes/expenses.v2.js'));
  Expense = (await import('../../models/Expense.js')).default;
  const Doctor = (await import('../../models/Doctor.js')).default;

  // Inseridos de propósito FORA de ordem alfabética e com createdAt embaralhado.
  const doctors = ['Thayna Miranda', 'Ana Paula', 'Álvaro Dias', 'Beatriz Lima'];
  for (const fullName of doctors) {
    const _id = new mongoose.Types.ObjectId();
    doctorIds[fullName] = _id;
    await Doctor.collection.insertOne({ _id, fullName, specialty: 'psicologia', email: `${_id}@teste.local`, licenseNumber: String(_id) });
  }

  const base = { category: 'commission', amount: 100, paymentMethod: 'transferencia_bancaria', status: 'pending', fixedExpenseId: null };
  const rows = [
    { ...base, date: '2026-09-30', relatedDoctor: doctorIds['Thayna Miranda'], createdAt: new Date('2026-10-06T10:00:01Z') },
    { ...base, date: '2026-09-30', relatedDoctor: doctorIds['Beatriz Lima'], createdAt: new Date('2026-10-06T10:00:02Z') },
    { ...base, date: '2026-09-30', relatedDoctor: doctorIds['Ana Paula'], createdAt: new Date('2026-10-06T10:00:03Z') },
    { ...base, date: '2026-09-30', relatedDoctor: doctorIds['Álvaro Dias'], createdAt: new Date('2026-10-06T10:00:04Z') },
    { ...base, category: 'other', description: 'Aluguel', date: '2026-09-30', relatedDoctor: null, createdAt: new Date('2026-10-06T10:00:00Z') },
    { ...base, date: '2026-09-15', relatedDoctor: doctorIds['Ana Paula'], createdAt: new Date('2026-10-06T10:00:05Z') }
  ];
  await Expense.collection.insertMany(rows.map((r) => ({ _id: new mongoose.Types.ObjectId(), ...r })));
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe('listagem de despesas — ordem determinística', () => {
  it('data desc; no mesmo dia, profissional A–Z ignorando acento; sem profissional por último no dia', async () => {
    const rows = await run({});
    expect(names(rows)).toEqual([
      'Álvaro Dias',
      'Ana Paula',
      'Beatriz Lima',
      'Thayna Miranda',
      '(sem profissional) Aluguel',
      'Ana Paula' // 15/09 — dia mais antigo vem depois, mesmo sendo "mais novo" em createdAt
    ]);
  });

  it('não depende da ordem de inserção/criação: mesma lista em execuções repetidas', async () => {
    const a = names(await run({}));
    const b = names(await run({}));
    expect(b).toEqual(a);
  });

  it('paginação é estável: página 1 + página 2 = recorte da lista completa', async () => {
    const all = await run({});
    const p1 = await run({}, 0, 3);
    const p2 = await run({}, 3, 3);
    expect([...p1, ...p2].map((r) => String(r._id))).toEqual(all.map((r) => String(r._id)));
  });

  it('mantém o formato do antigo populate e não vaza campos auxiliares', async () => {
    const [first] = await run({});
    expect(Object.keys(first.relatedDoctor).sort()).toEqual(['_id', 'fullName', 'specialty']);
    for (const k of ['_doctor', '_noDoctor', '_sortName']) expect(first).not.toHaveProperty(k);
  });

  it('despesa sem profissional devolve relatedDoctor null', async () => {
    const rows = await run({ category: 'other' });
    expect(rows).toHaveLength(1);
    expect(rows[0].relatedDoctor).toBeNull();
  });
});

describe('filtro por profissional (cast de ObjectId)', () => {
  it('toObjectIdIfValid converte hex de 24 e deixa o resto intacto', () => {
    expect(toObjectIdIfValid(String(doctorIds['Ana Paula']))).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(toObjectIdIfValid('nao-e-id')).toBe('nao-e-id');
  });

  it('agregação de totais com o filtro convertido encontra as despesas (com string, vinha vazio)', async () => {
    const group = [{ $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } }];
    const idStr = String(doctorIds['Ana Paula']);
    const comString = await Expense.aggregate([{ $match: { relatedDoctor: idStr } }, ...group]);
    const comCast = await Expense.aggregate([{ $match: { relatedDoctor: toObjectIdIfValid(idStr) } }, ...group]);
    expect(comString).toEqual([]);
    expect(comCast[0]).toMatchObject({ n: 2, total: 200 });
  });

  it('a pipeline da listagem aceita doctorId como string', async () => {
    const rows = await run({ relatedDoctor: String(doctorIds['Ana Paula']) });
    expect(rows).toHaveLength(2);
  });
});
