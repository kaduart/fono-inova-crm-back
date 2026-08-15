import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../config/socket.js', () => ({ getIo: () => ({ emit: vi.fn(), to: () => ({ emit: vi.fn() }) }) }));

let replSet;
let Package;
let Session;
let handlePackageSessionUpdate;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  Package = (await import('../../models/Package.js')).default;
  Session = (await import('../../models/Session.js')).default;
  handlePackageSessionUpdate = (await import('../../services/syncService.js')).handlePackageSessionUpdate;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

describe('handlePackageSessionUpdate — campos derivados', () => {
  it('remove o vínculo cancelado sem persistir o virtual remainingSessions', async () => {
    const patientId = new mongoose.Types.ObjectId();
    const doctorId = new mongoose.Types.ObjectId();
    const appointmentId = new mongoose.Types.ObjectId();
    const session = await Session.create({
      appointmentId, patient: patientId, doctor: doctorId,
      date: new Date('2026-08-20T03:00:00.000Z'), time: '10:00',
      specialty: 'fonoaudiologia', sessionType: 'fonoaudiologia', status: 'scheduled',
    });
    const pkg = await Package.create({
      durationMonths: 1, sessionsPerWeek: 1, patient: patientId, doctor: doctorId,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia', sessionValue: 100,
      totalSessions: 2, totalValue: 200, date: new Date('2026-08-20T03:00:00.000Z'),
      type: 'therapy', model: 'prepaid', status: 'active', sessions: [appointmentId],
    });

    await handlePackageSessionUpdate(
      { _id: appointmentId, session: session._id, package: pkg._id },
      'cancel',
      { _id: new mongoose.Types.ObjectId() },
      { changes: { reason: 'teste' } },
    );

    const raw = await Package.collection.findOne({ _id: pkg._id });
    expect(raw.sessions).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(raw, 'remainingSessions')).toBe(false);
  });
});
