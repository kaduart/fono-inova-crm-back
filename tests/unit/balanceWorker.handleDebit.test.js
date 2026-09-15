/**
 * 🧪 balanceWorker.handleDebit() — validação no consumidor + idempotência
 * (Problema 2). Antes: escrevia via $push cru sem runValidators e sem
 * checar duplicidade por appointmentId — foi assim que os 5 lançamentos
 * quebrados do caso Julia Boarati entraram no PatientBalance (2026-09-15).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../infrastructure/queue/queueConfig.js', () => ({
    getQueue: () => ({ add: vi.fn() }),
    queues: {},
    redisConnection: { status: 'ready', on: () => {} }
}));

import PatientBalance from '../../models/PatientBalance.js';
import { handleDebit } from '../../workers/balanceWorker.js';

describe('Unit: balanceWorker.handleDebit()', () => {
    let mongoServer;
    const PATIENT_ID = new mongoose.Types.ObjectId();

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        await mongoose.connect(mongoServer.getUri());
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoServer.stop();
    });

    beforeEach(async () => {
        await PatientBalance.deleteMany({ patient: PATIENT_ID });
    });

    it('rejeita e não grava quando description está ausente', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        await expect(handleDebit({
            patientId: PATIENT_ID.toString(),
            amount: 200,
            description: '',
            appointmentId
        }, 'evt-1')).rejects.toThrow(/INVALID_PAYLOAD/);

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance).toBeNull();
    });

    it('rejeita e não grava quando amount é inválido', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        await expect(handleDebit({
            patientId: PATIENT_ID.toString(),
            amount: 0,
            description: 'Sessão fiada',
            appointmentId
        }, 'evt-2')).rejects.toThrow(/INVALID_PAYLOAD/);

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance).toBeNull();
    });

    it('grava normalmente um débito válido (schema respeitado via runValidators)', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const result = await handleDebit({
            patientId: PATIENT_ID.toString(),
            amount: 200,
            description: 'Sessão fiada - Teste',
            appointmentId
        }, 'evt-3');

        expect(result.status).toBe('success');
        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance.currentBalance).toBe(200);
        expect(balance.transactions).toHaveLength(1);
        expect(balance.transactions[0].description).toBe('Sessão fiada - Teste');
    });

    it('não duplica ao reprocessar o mesmo evento (mesmo appointmentId) — idempotente', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const payload = {
            patientId: PATIENT_ID.toString(),
            amount: 200,
            description: 'Sessão fiada - Teste',
            appointmentId
        };

        const first = await handleDebit(payload, 'evt-4a');
        expect(first.status).toBe('success');

        // Reentrega do mesmo evento (retry do BullMQ, replay manual, etc.)
        const second = await handleDebit(payload, 'evt-4b');
        expect(second.status).toBe('skipped');
        expect(second.reason).toBe('duplicate_appointment_debit');

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance.transactions).toHaveLength(1);
        expect(balance.currentBalance).toBe(200); // não dobrou
    });

    it('processa débitos concorrentes de appointments diferentes sem conflito', async () => {
        const appt1 = new mongoose.Types.ObjectId();
        const appt2 = new mongoose.Types.ObjectId();

        await Promise.all([
            handleDebit({ patientId: PATIENT_ID.toString(), amount: 100, description: 'Sessão 1', appointmentId: appt1 }, 'evt-5a'),
            handleDebit({ patientId: PATIENT_ID.toString(), amount: 150, description: 'Sessão 2', appointmentId: appt2 }, 'evt-5b')
        ]);

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance.transactions).toHaveLength(2);
        expect(balance.currentBalance).toBe(250);
    });

    it('CONCORRÊNCIA REAL: duas entregas simultâneas do MESMO evento/appointment não duplicam, mesmo sem PatientBalance prévio', async () => {
        // Paciente novo — nenhum PatientBalance existe ainda. As duas
        // entregas (reentrega do BullMQ, ou dois workers processando o
        // mesmo job por engano) disparam ao mesmo tempo via Promise.all,
        // não uma depois da outra — exercita a corrida real no create()
        // (E11000 no índice único de `patient`) e no updateOne guardado.
        const freshPatientId = new mongoose.Types.ObjectId();
        const appointmentId = new mongoose.Types.ObjectId();
        const payload = {
            patientId: freshPatientId.toString(),
            amount: 200,
            description: 'Sessão fiada - concorrência',
            appointmentId
        };

        const [r1, r2] = await Promise.all([
            handleDebit(payload, 'evt-conc-a'),
            handleDebit(payload, 'evt-conc-b')
        ]);

        const statuses = [r1.status, r2.status].sort();
        // Uma cria, a outra é ignorada como duplicata (idempotente) — nunca as duas 'success'.
        expect(statuses).toEqual(['skipped', 'success']);

        const balance = await PatientBalance.findOne({ patient: freshPatientId });
        expect(balance.transactions).toHaveLength(1);
        expect(balance.currentBalance).toBe(200);
        expect(balance.totalDebited).toBe(200);
    });

    it('permite um débito legítimo novo pro mesmo appointment depois que o anterior foi revertido (isDeleted)', async () => {
        // Regra existente: "1 appointment = 1 débito ATIVO", não "1
        // appointment = 1 débito para sempre". Um débito estornado
        // (isDeleted:true, ex: reversão de completação) não pode bloquear
        // permanentemente uma cobrança legítima futura pro mesmo appointment.
        const appointmentId = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 0,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                {
                    type: 'debit', amount: 200, description: 'Sessão fiada (revertida)',
                    appointmentId, isPaid: false, isDeleted: true, deletedAt: new Date(),
                    deleteReason: 'Reversão de completação'
                }
            ]
        });

        const result = await handleDebit({
            patientId: PATIENT_ID.toString(),
            amount: 200,
            description: 'Sessão fiada - nova cobrança',
            appointmentId
        }, 'evt-6');

        expect(result.status).toBe('success');
        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        const activeDebits = balance.transactions.filter(t => t.type === 'debit' && !t.isDeleted);
        expect(activeDebits).toHaveLength(1);
        expect(balance.currentBalance).toBe(200);
    });

    it('continua bloqueando reentrega quando o débito existente está ATIVO (não revertido)', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 200,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                { type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false, isDeleted: false }
            ]
        });

        const result = await handleDebit({
            patientId: PATIENT_ID.toString(),
            amount: 200,
            description: 'Reentrega do mesmo evento',
            appointmentId
        }, 'evt-7');

        expect(result.status).toBe('skipped');
        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance.transactions).toHaveLength(1);
        expect(balance.currentBalance).toBe(200);
    });
});
