/**
 * 🧪 Testes unitários - updatePackageCommand
 *
 * Garante que a atualização de pacote segue o padrão canônico:
 * Command → Transaction → saveToOutbox(PACKAGE_UPDATED).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Package from '../../models/Package.js';
import Outbox from '../../infrastructure/outbox/OutboxModel.js';
import updatePackageCommand from '../../services/billing/commands/updatePackageCommand.js';

describe('updatePackageCommand', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('atualiza o pacote e salva PACKAGE_UPDATED no Outbox', async () => {
    const pkg = await Package.create({
      patient: new mongoose.Types.ObjectId(),
      doctor: new mongoose.Types.ObjectId(),
      specialty: 'fonoaudiologia',
      sessionType: 'fonoaudiologia',
      durationMonths: 6,
      sessionsPerWeek: 2,
      totalSessions: 12,
      totalValue: 1200,
      sessionValue: 100,
      date: new Date(),
      status: 'active',
    });

    const result = await updatePackageCommand.execute(
      pkg._id.toString(),
      { sessionValue: 150, durationMonths: 12 },
      { _id: new mongoose.Types.ObjectId() }
    );

    expect(result.data.sessionValue).toBe(150);
    expect(result.data.durationMonths).toBe(12);
    expect(result.eventEmitted).toBe(true);

    const outboxEvent = await Outbox.findOne({
      aggregateId: pkg._id.toString(),
      eventType: 'PACKAGE_UPDATED',
    });

    expect(outboxEvent).toBeTruthy();
    expect(outboxEvent.payload.packageId).toBe(pkg._id.toString());
    expect(outboxEvent.payload.updatedFields).toContain('sessionValue');
    expect(outboxEvent.payload.updatedFields).toContain('durationMonths');
  });

  it('não emite evento quando não há mudança real', async () => {
    const pkg = await Package.create({
      patient: new mongoose.Types.ObjectId(),
      doctor: new mongoose.Types.ObjectId(),
      specialty: 'psicologia',
      sessionType: 'psicologia',
      durationMonths: 3,
      sessionsPerWeek: 1,
      totalSessions: 4,
      totalValue: 400,
      sessionValue: 100,
      date: new Date(),
      status: 'active',
    });

    const result = await updatePackageCommand.execute(
      pkg._id.toString(),
      { sessionValue: 100 },
      { _id: new mongoose.Types.ObjectId() }
    );

    expect(result.eventEmitted).toBe(false);

    const outboxEvent = await Outbox.findOne({
      aggregateId: pkg._id.toString(),
      eventType: 'PACKAGE_UPDATED',
    });

    expect(outboxEvent).toBeFalsy();
  });

  it('rejeita campos imutáveis', async () => {
    const pkg = await Package.create({
      patient: new mongoose.Types.ObjectId(),
      doctor: new mongoose.Types.ObjectId(),
      specialty: 'fisioterapia',
      sessionType: 'fisioterapia',
      durationMonths: 2,
      sessionsPerWeek: 1,
      totalSessions: 2,
      totalValue: 200,
      sessionValue: 100,
      date: new Date(),
      status: 'active',
    });

    const originalPatient = pkg.patient.toString();

    const result = await updatePackageCommand.execute(
      pkg._id.toString(),
      { patient: new mongoose.Types.ObjectId(), sessionValue: 200 },
      { _id: new mongoose.Types.ObjectId() }
    );

    expect(result.data.sessionValue).toBe(200);

    const updated = await Package.findById(pkg._id).lean();
    expect(updated.patient.toString()).toBe(originalPatient);
  });

  it('retorna 404 para pacote inexistente', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();

    await expect(
      updatePackageCommand.execute(fakeId, { sessionValue: 200 }, {})
    ).rejects.toMatchObject({
      status: 404,
      code: 'PACKAGE_NOT_FOUND',
    });
  });
});
