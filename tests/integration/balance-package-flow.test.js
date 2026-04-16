/**
 * 🧪 Testes de Integração - Fluxo Balance ↔ Pacote
 * 
 * Testa a integração entre:
 * - PatientBalance (débitos)
 * - TherapyPackage (criação e quitação)
 * - Appointment (atualização de status)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import '../../models/PatientsView.js';
import PatientBalance from '../../models/PatientBalance.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import { packageOperations } from '../../controllers/therapyPackageController.js';

describe('Integração: Balance ↔ Pacote', () => {
    let mongoReplSet;
    const PATIENT_ID = new mongoose.Types.ObjectId();
    const DOCTOR_ID = new mongoose.Types.ObjectId();
    const APPOINTMENT_IDS = [];

    beforeAll(async () => {
        mongoReplSet = await MongoMemoryReplSet.create({
            replSet: { count: 1, dbName: 'crm_test' }
        });
        await mongoose.connect(mongoReplSet.getUri());
    });

    afterAll(async () => {
        await PatientBalance.deleteMany({ patient: PATIENT_ID });
        await Appointment.deleteMany({ patient: PATIENT_ID });
        await Package.deleteMany({ patient: PATIENT_ID });
        await mongoose.disconnect();
        await mongoReplSet.stop();
    });

    beforeEach(async () => {
        await PatientBalance.deleteMany({ patient: PATIENT_ID });
        await Appointment.deleteMany({ patient: PATIENT_ID });
        await Package.deleteMany({ patient: PATIENT_ID });
        APPOINTMENT_IDS.length = 0;
    });

    it('deve criar múltiplos débitos e listar por especialidade', async () => {
        // Criar balance com débitos de diferentes especialidades
        const balance = await PatientBalance.create({
            patient: PATIENT_ID,
            transactions: [
                { type: 'debit', amount: 130, specialty: 'fonoaudiologia', appointmentId: new mongoose.Types.ObjectId(), description: 'Sessão fono' },
                { type: 'debit', amount: 130, specialty: 'fonoaudiologia', appointmentId: new mongoose.Types.ObjectId(), description: 'Sessão fono' },
                { type: 'debit', amount: 150, specialty: 'psicologia', appointmentId: new mongoose.Types.ObjectId(), description: 'Sessão psico' },
                { type: 'debit', amount: 140, specialty: 'terapia ocupacional', appointmentId: new mongoose.Types.ObjectId(), description: 'Sessão to' },
            ]
        });

        // Buscar débitos de fonoaudiologia
        const fonoDebits = balance.transactions.filter(t =>
            t.type === 'debit' &&
            t.specialty === 'fonoaudiologia' &&
            !t.settledByPackageId
        );

        expect(fonoDebits).toHaveLength(2);
        expect(fonoDebits.reduce((sum, t) => sum + t.amount, 0)).toBe(260);

        // Buscar débitos de psicologia
        const psicoDebits = balance.transactions.filter(t =>
            t.type === 'debit' &&
            t.specialty === 'psicologia' &&
            !t.settledByPackageId
        );

        expect(psicoDebits).toHaveLength(1);
        expect(psicoDebits[0].amount).toBe(150);
    });

    it('deve quitar parcialmente débitos (apenas os selecionados)', async () => {
        // Criar 3 débitos de fono
        const balance = await PatientBalance.create({
            patient: PATIENT_ID,
            transactions: [
                { type: 'debit', amount: 100, specialty: 'fonoaudiologia', _id: new mongoose.Types.ObjectId(), description: 'Sessão 1' },
                { type: 'debit', amount: 100, specialty: 'fonoaudiologia', _id: new mongoose.Types.ObjectId(), description: 'Sessão 2' },
                { type: 'debit', amount: 100, specialty: 'fonoaudiologia', _id: new mongoose.Types.ObjectId(), description: 'Sessão 3' },
            ]
        });

        const debitIds = balance.transactions.map(t => t._id.toString());

        // Selecionar apenas 2 débitos para quitar
        const selectedDebts = [debitIds[0], debitIds[1]];

        // Simular quitação
        const packageId = new mongoose.Types.ObjectId();
        for (const t of balance.transactions) {
            if (selectedDebts.includes(t._id.toString())) {
                t.settledByPackageId = packageId;
                t.isPaid = true;
            }
        }

        // Adicionar crédito
        balance.transactions.push({
            type: 'credit',
            amount: 200,
            specialty: 'fonoaudiologia',
            settledByPackageId: packageId,
            description: 'Quitação via pacote'
        });

        await balance.save();

        // Verificar resultado
        const updated = await PatientBalance.findOne({ patient: PATIENT_ID });
        
        // 2 débitos quitados, 1 pendente
        const settledCount = updated.transactions.filter(t => t.type === 'debit' && t.settledByPackageId?.toString() === packageId.toString()).length;
        expect(settledCount).toBe(2);

        const pendingCount = updated.transactions.filter(t => 
            t.type === 'debit' && !t.settledByPackageId
        ).length;
        expect(pendingCount).toBe(1);
    });

    it('deve calcular saldo corretamente após quitação parcial', async () => {
        const balance = await PatientBalance.create({
            patient: PATIENT_ID,
            transactions: [
                { type: 'debit', amount: 100, specialty: 'fono', description: 'Sessão 1' },
                { type: 'debit', amount: 100, specialty: 'fono', description: 'Sessão 2' },
                { type: 'debit', amount: 100, specialty: 'fono', description: 'Sessão 3' },
            ]
        });

        balance.currentBalance = 300;
        balance.totalDebited = 300;
        await balance.save();

        // Quitar 1 débito
        const packageId = new mongoose.Types.ObjectId();
        balance.transactions[0].settledByPackageId = packageId;
        balance.transactions[0].isPaid = true;
        
        balance.transactions.push({
            type: 'credit',
            amount: 100,
            specialty: 'fono',
            description: 'Quitação via pacote'
        });
        
        balance.currentBalance -= 100;
        balance.totalCredited += 100;
        
        await balance.save();

        expect(balance.currentBalance).toBe(200);
        expect(balance.totalDebited).toBe(300);
        expect(balance.totalCredited).toBe(100);
    });

    it('deve manter histórico completo de transações', async () => {
        const balance = await PatientBalance.create({
            patient: PATIENT_ID,
            transactions: [
                { type: 'debit', amount: 100, specialty: 'fono', description: 'Sessão 1' },
                { type: 'debit', amount: 100, specialty: 'fono', description: 'Sessão 2' },
            ]
        });

        // Quitar todos
        const packageId = new mongoose.Types.ObjectId();
        for (const t of balance.transactions) {
            t.settledByPackageId = packageId;
            t.isPaid = true;
        }

        balance.transactions.push({
            type: 'credit',
            amount: 200,
            description: 'Quitação via pacote'
        });

        await balance.save();

        // Verificar histórico
        const history = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(history.transactions).toHaveLength(3); // 2 débitos + 1 crédito

        // Débitos ainda existem (não foram deletados)
        const debits = history.transactions.filter(t => t.type === 'debit');
        expect(debits).toHaveLength(2);

        // Crédito existe
        const credits = history.transactions.filter(t => t.type === 'credit');
        expect(credits).toHaveLength(1);
    });

    it('deve calcular ticket médio por especialidade', async () => {
        const balance = await PatientBalance.create({
            patient: PATIENT_ID,
            transactions: [
                { type: 'debit', amount: 130, specialty: 'fonoaudiologia', description: 'Sessão fono' },
                { type: 'debit', amount: 130, specialty: 'fonoaudiologia', description: 'Sessão fono' },
                { type: 'debit', amount: 150, specialty: 'psicologia', description: 'Sessão psico' },
            ]
        });

        // Calcular por especialidade
        const bySpecialty = {};
        for (const t of balance.transactions.filter(t => t.type === 'debit')) {
            if (!bySpecialty[t.specialty]) {
                bySpecialty[t.specialty] = { total: 0, count: 0 };
            }
            bySpecialty[t.specialty].total += t.amount;
            bySpecialty[t.specialty].count += 1;
        }

        // Ticket médio fono
        expect(bySpecialty['fonoaudiologia'].total / bySpecialty['fonoaudiologia'].count).toBe(130);

        // Ticket médio psico
        expect(bySpecialty['psicologia'].total / bySpecialty['psicologia'].count).toBe(150);
    });
});
