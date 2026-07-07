/**
 * Testes do AppointmentWriteGuard — PR 3 (2026-07-07).
 *
 * Cobre a interceptação nova de `collection.findOneAndUpdate`, que fecha o
 * gap confirmado empiricamente: Model.findByIdAndUpdate e Model.findOneAndUpdate
 * delegam pro mesmo método nativo, não interceptado antes desta mudança.
 *
 * Usa os models reais (Appointment) em vez de um schema sintético, porque o
 * bug real encontrado durante a implementação só aparece com o schema de
 * verdade: o `strict` (default) do Mongoose descartava silenciosamente as
 * flags de autorização (`_fromCancelService` etc.) em updates via
 * findByIdAndUpdate, o que geraria falso positivo em todo cancelamento de
 * agendamento em produção. Corrigido declarando as flags no schema
 * (Appointment.js/Session.js/Payment.js) com `select: false`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer;
let Appointment;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await import('../../../models/index.js');
    Appointment = mongoose.model('Appointment');
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await Appointment.collection.deleteMany({});
});

const createTestAppointment = () => Appointment.create({
    date: new Date(),
    time: '10:00',
    patient: new mongoose.Types.ObjectId(),
    doctor: new mongoose.Types.ObjectId(),
    specialty: 'fonoaudiologia',
    operationalStatus: 'confirmed'
});

describe('AppointmentWriteGuard — collection.findOneAndUpdate (modo warn, padrão)', () => {
    it('loga warning quando findByIdAndUpdate toca operationalStatus sem flag', async () => {
        const doc = await createTestAppointment();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // clinicalStatus (não bloqueado pelo pre-hook de schema) evita o
        // FORBIDDEN_MANUAL_COMPLETE hard-block do próprio Appointment.js —
        // aqui o alvo é especificamente o AppointmentWriteGuard, não o outro guard.
        await Appointment.findByIdAndUpdate(doc._id, { $set: { clinicalStatus: 'completed' } });

        expect(warnSpy).toHaveBeenCalled();
        const logged = warnSpy.mock.calls.find(c => String(c[0]).includes('AppointmentWriteGuard'));
        expect(logged).toBeTruthy();
        expect(logged[1]).toContain('collection.findOneAndUpdate');
        warnSpy.mockRestore();
    });

    it('NÃO loga warning quando a flag autorizada (_fromCancelService) está presente — fluxo real de cancelAppointmentCommand', async () => {
        const doc = await createTestAppointment();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await Appointment.findByIdAndUpdate(doc._id, {
            $set: { operationalStatus: 'canceled', clinicalStatus: 'pending', _fromCancelService: true }
        });

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('a flag de autorização é persistida e sobrevive ao strict mode do Mongoose (regressão do bug real)', async () => {
        const doc = await createTestAppointment();

        await Appointment.findByIdAndUpdate(doc._id, {
            $set: { operationalStatus: 'canceled', _fromCancelService: true }
        });

        const reloaded = await Appointment.findById(doc._id).select('+_fromCancelService').lean();
        expect(reloaded._fromCancelService).toBe(true);
    });

    it('não interfere em updates que não tocam campo protegido', async () => {
        const doc = await createTestAppointment();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await Appointment.findByIdAndUpdate(doc._id, { $set: { notes: 'algo' } });

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('.save() em campo protegido já era coberto (delega pra collection.updateOne, não precisou de patch novo)', async () => {
        const doc = await createTestAppointment();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        doc.clinicalStatus = 'completed';
        await doc.save();

        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
