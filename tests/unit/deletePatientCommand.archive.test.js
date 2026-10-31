// Auditoria do Dashboard admin (31/10/2026), B1: a exclusão de paciente grava a
// cópia integral ANTES de apagar e apaga agendamentos DENTRO da transação.
import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';

const calls = [];
const q = (name, docs = []) => ({
  find: vi.fn(() => ({ session: () => ({ lean: async () => { calls.push(`${name}.find`); return docs; } }) })),
  deleteMany: vi.fn(() => ({ session: async () => { calls.push(`${name}.deleteMany`); return { deletedCount: docs.length }; } })),
});
const pid = new mongoose.Types.ObjectId();

vi.mock('../../models/Patient.js', () => ({ default: {
  findById: () => ({ session: () => ({ lean: async () => ({ _id: pid, fullName: 'Fulano Teste' }) }) }),
  findByIdAndDelete: vi.fn(async () => { calls.push('Patient.delete'); }),
} }));
vi.mock('../../models/Payment.js', () => ({ default: q('Payment', [{ _id: 1 }]) }));
vi.mock('../../models/Session.js', () => ({ default: q('Session') }));
vi.mock('../../models/Package.js', () => ({ default: q('Package') }));
vi.mock('../../models/PatientBalance.js', () => ({ default: q('PatientBalance') }));
vi.mock('../../models/PatientsView.js', () => ({ default: q('PatientsView') }));
vi.mock('../../models/Appointment.js', () => ({ default: {} }));
const archiveCreate = vi.fn(async () => { calls.push('Archive.create'); });
vi.mock('../../models/DeletedPatientArchive.js', () => ({ default: { create: archiveCreate } }));

const apptDelete = vi.fn(async () => { calls.push('appointments.deleteMany'); return { deletedCount: 2 }; });
Object.defineProperty(mongoose.connection, 'db', { configurable: true, get: () => ({
  collection: () => ({
    find: () => ({ toArray: async () => { calls.push('appointments.find'); return [{ _id: 'a1' }, { _id: 'a2' }]; } }),
    deleteMany: apptDelete,
  }),
}) });

const { execute } = await import('../../domains/patient/commands/deletePatientCommand.js');

describe('deletePatientCommand', () => {
  it('arquiva antes de apagar e usa a session da transação nos agendamentos', async () => {
    const session = { id: 'tx' };
    const r = await execute(pid.toString(), { mongoSession: session, user: { id: 'u1', role: 'admin' }, reason: 'duplicado' });

    expect(calls.indexOf('Archive.create')).toBeGreaterThan(-1);
    expect(calls.indexOf('Archive.create')).toBeLessThan(calls.indexOf('Payment.deleteMany'));
    const [doc] = archiveCreate.mock.calls[0][0];
    expect(doc.deletedBy).toBe('u1');
    expect(doc.deletedByRole).toBe('admin');
    expect(doc.reason).toBe('duplicado');
    expect(doc.data.appointments).toHaveLength(2);
    expect(archiveCreate.mock.calls[0][1]).toEqual({ session });
    expect(apptDelete.mock.calls[0][1]).toEqual({ session });
    expect(r.counts.appointments).toBe(2);
  });
});
