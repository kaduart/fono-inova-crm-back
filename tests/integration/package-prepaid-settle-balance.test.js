/**
 * 🧪 Testes de Integração - Pacote pré-pado quita débitos pendentes
 *
 * Testa que ao criar um pacote pré-pago, o PatientBalance é ajustado
 * automaticamente: débitos pendentes são quitados pelo valor pago.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import '../../models/PatientsView.js';
import PatientBalance from '../../models/PatientBalance.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import { createPackageV2 } from '../../controllers/packageController.v2.js';

describe('Integração: Pacote pré-pago ↔ PatientBalance', () => {
    let mongoReplSet;
    const PATIENT_ID = new mongoose.Types.ObjectId();
    const DOCTOR_ID = new mongoose.Types.ObjectId();

    beforeAll(async () => {
        mongoReplSet = await MongoMemoryReplSet.create({
            replSet: { count: 1, dbName: 'crm_test' }
        });
        await mongoose.connect(mongoReplSet.getUri());

        await Patient.create({
            _id: PATIENT_ID,
            fullName: 'Paciente Teste',
            dateOfBirth: new Date('1990-01-01'),
            phone: '11999999999'
        });

        await Doctor.create({
            _id: DOCTOR_ID,
            fullName: 'Doutor Teste',
            specialty: 'fonoaudiologia',
            phoneNumber: '11988888888',
            licenseNumber: 'CRM-12345',
            email: 'doctor@test.com'
        });
    });

    afterAll(async () => {
        await PatientBalance.deleteMany({ patient: PATIENT_ID });
        await Appointment.deleteMany({ patient: PATIENT_ID });
        await Package.deleteMany({ patient: PATIENT_ID });
        await Patient.deleteMany({ _id: PATIENT_ID });
        await Doctor.deleteMany({ _id: DOCTOR_ID });
        await mongoose.disconnect();
        await mongoReplSet.stop();
    });

    beforeEach(async () => {
        await PatientBalance.deleteMany({ patient: PATIENT_ID });
        await Appointment.deleteMany({ patient: PATIENT_ID });
        await Package.deleteMany({ patient: PATIENT_ID });
    });

    it('deve quitar débitos pendentes ao criar pacote pré-pago', async () => {
        // 1. Cria saldo devedor de 320 (2 sessões fiadas)
        const balance = await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 320,
            totalDebited: 320,
            transactions: [
                { type: 'debit', amount: 160, specialty: 'fonoaudiologia', description: 'Sessão fiada 1' },
                { type: 'debit', amount: 160, specialty: 'fonoaudiologia', description: 'Sessão fiada 2' }
            ]
        });

        // 2. Cria pacote pré-pago de 640 (4 sessões de 160)
        const req = {
            body: {
                type: 'package',
                patientId: PATIENT_ID.toString(),
                doctorId: DOCTOR_ID.toString(),
                specialty: 'fonoaudiologia',
                sessionType: 'fonoaudiologia',
                totalSessions: 4,
                sessionValue: 160,
                totalValue: 640,
                model: 'prepaid',
                paymentType: 'full',
                paymentMethod: 'pix',
                payments: [{ amount: 640, method: 'pix', date: '2026-07-03' }],
                selectedSlots: [
                    { date: '2026-07-10', time: '09:00' },
                    { date: '2026-07-17', time: '09:00' },
                    { date: '2026-07-24', time: '09:00' },
                    { date: '2026-07-31', time: '09:00' }
                ]
            },
            user: { _id: new mongoose.Types.ObjectId() }
        };

        const res = {
            status(code) { this.statusCode = code; return this; },
            json(data) { this.data = data; return this; }
        };

        await createPackageV2(req, res);

        if (res.statusCode !== 201) {
            console.log('createPackageV2 response:', JSON.stringify(res.data, null, 2));
        }

        expect(res.statusCode).toBe(201);
        expect(res.data.success).toBe(true);

        // 3. Verifica que o saldo foi zerado
        const updatedBalance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(updatedBalance.currentBalance).toBe(0);
        expect(updatedBalance.totalCredited).toBe(320);

        // 4. Verifica que os débitos foram marcados como quitados
        const settledDebits = updatedBalance.transactions.filter(
            t => t.type === 'debit' && t.isPaid && t.settledByPackageId
        );
        expect(settledDebits).toHaveLength(2);

        // 5. Verifica que existe transação de crédito de quitação
        const creditTx = updatedBalance.transactions.find(
            t => t.type === 'credit' && t.amount === 320
        );
        expect(creditTx).toBeTruthy();
    });

    it('deve quitar parcialmente quando pagamento é menor que a dívida', async () => {
        // 1. Cria saldo devedor de 480
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 480,
            totalDebited: 480,
            transactions: [
                { type: 'debit', amount: 160, specialty: 'fonoaudiologia', description: 'Sessão fiada 1' },
                { type: 'debit', amount: 160, specialty: 'fonoaudiologia', description: 'Sessão fiada 2' },
                { type: 'debit', amount: 160, specialty: 'fonoaudiologia', description: 'Sessão fiada 3' }
            ]
        });

        // 2. Cria pacote pré-pago de 320 (2 sessões de 160)
        const req = {
            body: {
                type: 'package',
                patientId: PATIENT_ID.toString(),
                doctorId: DOCTOR_ID.toString(),
                specialty: 'fonoaudiologia',
                sessionType: 'fonoaudiologia',
                totalSessions: 2,
                sessionValue: 160,
                totalValue: 320,
                model: 'prepaid',
                paymentType: 'full',
                paymentMethod: 'pix',
                payments: [{ amount: 320, method: 'pix', date: '2026-07-03' }],
                selectedSlots: [
                    { date: '2026-07-10', time: '09:00' },
                    { date: '2026-07-17', time: '09:00' }
                ]
            },
            user: { _id: new mongoose.Types.ObjectId() }
        };

        const res = {
            status(code) { this.statusCode = code; return this; },
            json(data) { this.data = data; return this; }
        };

        await createPackageV2(req, res);

        expect(res.statusCode).toBe(201);

        const updatedBalance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(updatedBalance.currentBalance).toBe(160);

        const settledDebits = updatedBalance.transactions.filter(
            t => t.type === 'debit' && t.isPaid && t.settledByPackageId
        );
        expect(settledDebits).toHaveLength(2);

        const pendingDebits = updatedBalance.transactions.filter(
            t => t.type === 'debit' && !t.isPaid && !t.isDeleted
        );
        expect(pendingDebits).toHaveLength(1);
        expect(pendingDebits[0].amount).toBe(160);
    });
});
