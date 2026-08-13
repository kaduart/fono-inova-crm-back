/**
 * Testes de caracterizacao do financialSanitizer plugin.
 *
 * Validam o contrato de bypass para campos financeiros legados no caminho
 * `save`/`create`:
 *  - valores que NUNCA foram tocados pelo call site preservam o default do schema
 *  - valores explicitamente escritos sem bypass caem para o default do schema
 *  - valores explicitamente escritos COM bypass sao preservados
 *  - Model.create com array reusa o mesmo objeto de options sem vazamento
 *  - insertMany e create produzem o mesmo resultado para a mesma entrada
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import financialSanitizer from '../financialSanitizer.js';

let mongoServer;
let TestModel;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const schema = new mongoose.Schema({
    tag: { type: String, index: true },
    status: { type: String, default: 'scheduled' },
    sessionValue: { type: Number, default: 0 },
    isPaid: { type: Boolean, default: false },
    paymentStatus: {
      type: String,
      enum: ['paid', 'pending', 'unpaid', 'pending_balance', 'package_paid'],
      default: 'pending'
    }
  });
  schema.plugin(financialSanitizer, { entity: 'TestEntity' });

  TestModel = mongoose.model('TestEntity', schema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await TestModel.collection.deleteMany({});
});

async function findByTag(tag) {
  return TestModel.collection.findOne({ tag });
}

describe('financialSanitizer — save/create', () => {
  it('create sem tocar em campo financeiro grava os defaults do schema', async () => {
    await TestModel.create([{ tag: 'create-default' }]);
    const doc = await findByTag('create-default');
    expect(doc.isPaid).toBe(false);
    expect(doc.paymentStatus).toBe('pending');
  });

  it('new + save sem tocar em campo financeiro grava os defaults do schema', async () => {
    const doc = new TestModel({ tag: 'save-default' });
    await doc.save();
    const reloaded = await findByTag('save-default');
    expect(reloaded.isPaid).toBe(false);
    expect(reloaded.paymentStatus).toBe('pending');
  });

  it('create com valor explicito e sem bypass cai para o default do schema', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await TestModel.create([{ tag: 'create-explicit', isPaid: true, paymentStatus: 'package_paid' }]);
    const doc = await findByTag('create-explicit');

    expect(doc.isPaid).toBe(false);
    expect(doc.paymentStatus).toBe('pending');
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls.find(c => String(c[0]).includes('[FINANCIAL SANITIZER] RESET_TO_DEFAULT'));
    expect(logged).toBeTruthy();
    const meta = JSON.parse(logged[1]);
    expect(meta.removedFields).toEqual({ isPaid: true, paymentStatus: 'package_paid' });
    expect(meta.stack).not.toContain('models/plugins/financialSanitizer.js');
    expect(meta.stack).not.toContain('node_modules');
    expect(meta.stack).toContain('    at ');

    warnSpy.mockRestore();
  });

  it('create com valor explicito e bypass via options preserva os valores', async () => {
    await TestModel.create(
      [{ tag: 'create-bypass', isPaid: true, paymentStatus: 'package_paid' }],
      { __fromFinancialGuard: true, __guardContext: 'FINANCIAL' }
    );
    const doc = await findByTag('create-bypass');
    expect(doc.isPaid).toBe(true);
    expect(doc.paymentStatus).toBe('package_paid');
  });

  it('create com array compartilha options sem vazamento entre documentos', async () => {
    const sharedOpts = { __fromFinancialGuard: true, __guardContext: 'FINANCIAL' };
    await TestModel.create([
      { tag: 'array-bypass-1', isPaid: true, paymentStatus: 'package_paid' },
      { tag: 'array-bypass-2', isPaid: true, paymentStatus: 'package_paid' },
      { tag: 'array-bypass-3', isPaid: true, paymentStatus: 'package_paid' }
    ], sharedOpts);

    for (let i = 1; i <= 3; i++) {
      const doc = await findByTag(`array-bypass-${i}`);
      expect(doc.isPaid).toBe(true);
      expect(doc.paymentStatus).toBe('package_paid');
    }
  });

  it('save com bypass via $locals preserva os valores', async () => {
    const doc = new TestModel({ tag: 'save-locals', isPaid: true, paymentStatus: 'package_paid' });
    doc.$locals.__fromFinancialGuard = true;
    doc.$locals.__guardContext = 'FINANCIAL';
    await doc.save();
    const reloaded = await findByTag('save-locals');
    expect(reloaded.isPaid).toBe(true);
    expect(reloaded.paymentStatus).toBe('package_paid');
  });
});

describe('financialSanitizer — create e insertMany produzem o mesmo resultado', () => {
  it('create e insertMany com entrada identica resultam no mesmo estado persistido', async () => {
    await TestModel.create([{ tag: 'create-cmp', isPaid: true, paymentStatus: 'package_paid' }]);
    await TestModel.insertMany([{ tag: 'insertmany-cmp', isPaid: true, paymentStatus: 'package_paid' }]);

    const createDoc = await findByTag('create-cmp');
    const insertManyDoc = await findByTag('insertmany-cmp');

    expect(createDoc.isPaid).toBe(insertManyDoc.isPaid);
    expect(createDoc.paymentStatus).toBe(insertManyDoc.paymentStatus);
  });
});

describe('financialSanitizer — preserva defaults do schema sem escrita financeira explicita', () => {
  it('documento criado sem escrita financeira mantem pending/false mesmo apos mudanca de status', async () => {
    const [doc] = await TestModel.create([{ tag: 'missed-default', sessionValue: 150 }]);
    doc.status = 'missed';
    await doc.save();

    const reloaded = await findByTag('missed-default');
    expect(reloaded.paymentStatus).toBe('pending');
    expect(reloaded.isPaid).toBe(false);
  });
});
