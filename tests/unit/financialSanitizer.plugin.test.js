import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import financialSanitizer from '../../models/plugins/financialSanitizer.js';

let mongoServer;

const testSchema = new mongoose.Schema({
  name: String,
  isPaid: Boolean,
  paymentStatus: String,
  value: Number
});

testSchema.plugin(financialSanitizer, { entity: 'TestEntity' });

const TestModel = mongoose.model('FinancialSanitizerTest', testSchema);

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60_000);

beforeEach(async () => {
  await TestModel.deleteMany({});
});

describe('financialSanitizer plugin', () => {
  describe('insertMany', () => {
    it('remove campos legados quando chamado sem bypass', async () => {
      const docs = await TestModel.insertMany([{
        name: 'sem bypass',
        isPaid: true,
        paymentStatus: 'paid'
      }]);

      expect(docs[0].isPaid).toBeUndefined();
      expect(docs[0].paymentStatus).toBeUndefined();

      const persisted = await TestModel.findById(docs[0]._id).lean();
      expect(persisted.isPaid).toBeUndefined();
      expect(persisted.paymentStatus).toBeUndefined();
    });

    it('preserva campos legados quando bypass e informado por options', async () => {
      const options = {
        __fromFinancialGuard: true,
        __guardContext: 'FINANCIAL'
      };

      const docs = await TestModel.insertMany([{
        name: 'com bypass',
        isPaid: true,
        paymentStatus: 'package_paid'
      }], options);

      expect(docs[0].isPaid).toBe(true);
      expect(docs[0].paymentStatus).toBe('package_paid');

      const persisted = await TestModel.findById(docs[0]._id).lean();
      expect(persisted.isPaid).toBe(true);
      expect(persisted.paymentStatus).toBe('package_paid');
    });

    it('nao vaza flags de bypass para options reutilizado nem entre chamadas', async () => {
      const sharedOptions = {
        __fromFinancialGuard: true,
        __guardContext: 'FINANCIAL'
      };

      await TestModel.insertMany([{
        name: 'primeira',
        isPaid: true,
        paymentStatus: 'package_paid'
      }], sharedOptions);

      expect(sharedOptions.__fromFinancialGuard).toBeUndefined();
      expect(sharedOptions.__guardContext).toBeUndefined();

      const reused = await TestModel.insertMany([{
        name: 'segunda',
        isPaid: true,
        paymentStatus: 'paid'
      }], sharedOptions);

      expect(reused[0].isPaid).toBeUndefined();
      expect(reused[0].paymentStatus).toBeUndefined();
    });

    it('processa documento unico quando docs nao e array', async () => {
      const doc = await TestModel.insertMany({
        name: 'unico',
        isPaid: true,
        paymentStatus: 'paid'
      });

      expect(doc.isPaid).toBeUndefined();
      expect(doc.paymentStatus).toBeUndefined();
    });
  });

  describe('save', () => {
    it('remove campos legados em documento novo', async () => {
      const doc = new TestModel({
        name: 'novo',
        isPaid: true,
        paymentStatus: 'paid'
      });
      await doc.save();

      const persisted = await TestModel.findById(doc._id).lean();
      expect(persisted.isPaid).toBeUndefined();
      expect(persisted.paymentStatus).toBeUndefined();
    });

    it('NAO remove campos legados em documento existente (caracterizacao)', async () => {
      const created = await TestModel.create({ name: 'existente' });
      created.isPaid = true;
      created.paymentStatus = 'paid';
      await created.save();

      const persisted = await TestModel.findById(created._id).lean();
      expect(persisted.isPaid).toBe(true);
      expect(persisted.paymentStatus).toBe('paid');
    });
  });

  describe('updateOne / updateMany / findOneAndUpdate', () => {
    let baseDoc;

    beforeEach(async () => {
      baseDoc = await TestModel.create({ name: 'base' });
    });

    it('remove campos legados de $set em updateOne', async () => {
      await TestModel.updateOne(
        { _id: baseDoc._id },
        { $set: { isPaid: true, paymentStatus: 'paid', value: 100 } }
      );

      const persisted = await TestModel.findById(baseDoc._id).lean();
      expect(persisted.isPaid).toBeUndefined();
      expect(persisted.paymentStatus).toBeUndefined();
      expect(persisted.value).toBe(100);
    });

    it('remove campos legados de $setOnInsert', async () => {
      const newId = new mongoose.Types.ObjectId();
      await TestModel.updateOne(
        { _id: newId },
        {
          $setOnInsert: {
            name: 'novo via setOnInsert',
            isPaid: true,
            paymentStatus: 'paid'
          }
        },
        { upsert: true }
      );

      const persisted = await TestModel.findById(newId).lean();
      expect(persisted.isPaid).toBeUndefined();
      expect(persisted.paymentStatus).toBeUndefined();
      expect(persisted.name).toBe('novo via setOnInsert');
    });

    it('remove campos legados de update por pipeline', async () => {
      await TestModel.updateOne(
        { _id: baseDoc._id },
        [
          { $set: { isPaid: true, paymentStatus: 'paid', value: 200 } }
        ]
      );

      const persisted = await TestModel.findById(baseDoc._id).lean();
      expect(persisted.isPaid).toBeUndefined();
      expect(persisted.paymentStatus).toBeUndefined();
      expect(persisted.value).toBe(200);
    });

    it('preserva campos legados quando bypass e informado por options', async () => {
      await TestModel.updateOne(
        { _id: baseDoc._id },
        { $set: { isPaid: true, paymentStatus: 'package_paid' } },
        { __fromFinancialGuard: true, __guardContext: 'FINANCIAL' }
      );

      const persisted = await TestModel.findById(baseDoc._id).lean();
      expect(persisted.isPaid).toBe(true);
      expect(persisted.paymentStatus).toBe('package_paid');
    });
  });
});
