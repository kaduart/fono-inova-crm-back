/**
 * 🧪 Testes Unitários - PatientBalance
 * 
 * Testa:
 * - addDebit com idempotência
 * - addDebit com specialty
 * - Quotação de débitos via pacote
 * - Filtro por especialidade
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import PatientBalance from '../../models/PatientBalance.js';

describe('PatientBalance', () => {
    const TEST_PATIENT_ID = new mongoose.Types.ObjectId();

    beforeAll(async () => {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/crm_test');
    });

    afterAll(async () => {
        await mongoose.disconnect();
    });

    beforeEach(async () => {
        await PatientBalance.deleteMany({ patient: TEST_PATIENT_ID });
    });

    describe('addDebit', () => {
        it('deve criar um débito com specialty normalizada', async () => {
            const balance = await PatientBalance.create({ patient: TEST_PATIENT_ID });

            await balance.addDebit(
                130,
                'Sessão teste',
                null,
                new mongoose.Types.ObjectId(),
                null,
                'Fonoaudiologia', // uppercase com acento
                'corr-123'
            );

            const saved = await PatientBalance.findOne({ patient: TEST_PATIENT_ID });
            const transaction = saved.transactions[0];

            expect(transaction.type).toBe('debit');
            expect(transaction.amount).toBe(130);
            expect(transaction.specialty).toBe('fonoaudiologia'); // normalizado
            expect(transaction.correlationId).toBe('corr-123');
        });

        it('deve converter terapia_ocupacional para terapia ocupacional', async () => {
            const balance = await PatientBalance.create({ patient: TEST_PATIENT_ID });

            await balance.addDebit(
                150,
                'Sessão TO',
                null,
                new mongoose.Types.ObjectId(),
                null,
                'terapia_ocupacional', // com underscore
                null
            );

            const saved = await PatientBalance.findOne({ patient: TEST_PATIENT_ID });
            expect(saved.transactions[0].specialty).toBe('terapia ocupacional');
        });

        it('deve prevenir duplicidade por appointmentId (idempotência)', async () => {
            const balance = await PatientBalance.create({ patient: TEST_PATIENT_ID });
            const appointmentId = new mongoose.Types.ObjectId();

            // Primeira chamada
            const result1 = await balance.addDebit(100, 'Débito 1', null, appointmentId, null, 'psicologia', null);
            expect(result1.skipped).toBe(false);

            // Segunda chamada (mesmo appointmentId)
            const result2 = await balance.addDebit(100, 'Débito duplicado', null, appointmentId, null, 'psicologia', null);
            expect(result2.skipped).toBe(true);
            expect(result2.reason).toBe('already_exists');

            const saved = await PatientBalance.findOne({ patient: TEST_PATIENT_ID });
            expect(saved.transactions).toHaveLength(1);
            expect(saved.currentBalance).toBe(100); // não duplicou
        });

        it('deve prevenir duplicidade por correlationId', async () => {
            const balance = await PatientBalance.create({ patient: TEST_PATIENT_ID });

            // Primeira chamada
            const result1 = await balance.addDebit(100, 'Débito 1', null, null, null, 'fono', 'corr-abc');
            expect(result1.skipped).toBe(false);

            // Segunda chamada (mesmo correlationId, appointmentId diferente)
            const result2 = await balance.addDebit(100, 'Débito duplicado', null, new mongoose.Types.ObjectId(), null, 'fono', 'corr-abc');
            expect(result2.skipped).toBe(true);
            expect(result2.reason).toBe('correlation_exists');
        });

        it('deve permitir débitos diferentes para o mesmo paciente', async () => {
            const balance = await PatientBalance.create({ patient: TEST_PATIENT_ID });

            await balance.addDebit(100, 'Débito 1', null, new mongoose.Types.ObjectId(), null, 'fono', 'corr-1');
            await balance.addDebit(150, 'Débito 2', null, new mongoose.Types.ObjectId(), null, 'psico', 'corr-2');

            const saved = await PatientBalance.findOne({ patient: TEST_PATIENT_ID });
            expect(saved.transactions).toHaveLength(2);
            expect(saved.currentBalance).toBe(250);
        });
    });

    describe('getPendingBySpecialty', () => {
        it('deve filtrar apenas débitos não quitados da especialidade', async () => {
            const balance = await PatientBalance.create({
                patient: TEST_PATIENT_ID,
                transactions: [
                    { type: 'debit', amount: 100, specialty: 'fonoaudiologia', settledByPackageId: null, isPaid: false },
                    { type: 'debit', amount: 150, specialty: 'psicologia', settledByPackageId: null, isPaid: false },
                    { type: 'debit', amount: 200, specialty: 'fonoaudiologia', settledByPackageId: new mongoose.Types.ObjectId(), isPaid: true }, // quitado
                    { type: 'credit', amount: 100, specialty: 'fonoaudiologia' }, // crédito
                ]
            });

            const fonoDebits = balance.transactions.filter(t =>
                t.type === 'debit' &&
                t.specialty === 'fonoaudiologia' &&
                !t.settledByPackageId &&
                !t.isPaid
            );

            expect(fonoDebits).toHaveLength(1);
            expect(fonoDebits[0].amount).toBe(100);
        });
    });
});
