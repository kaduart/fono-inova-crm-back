/**
 * Teste de fluxo: Débito → Pagamento → Saldo abatido
 * 
 * Cenário: 
 * 1. Paciente tem débito de 100
 * 2. Faz pagamento de 90
 * 3. Saldo deve mostrar 10 (não 100)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import PatientBalance from '../models/PatientBalance.js';
import { setupTestDB, teardownTestDB } from './setup.js';

const TEST_PATIENT_ID = new mongoose.Types.ObjectId();

describe('Balance Payment Flow', () => {
    beforeAll(async () => {
        await setupTestDB();
    });

    afterAll(async () => {
        // Limpa dados de teste
        await PatientBalance.deleteOne({ patient: TEST_PATIENT_ID });
        await teardownTestDB();
    });

    it('deve abater o saldo quando um pagamento é feito', async () => {
        // ============================================================
        // PASSO 1: Criar um débito de 100
        // ============================================================
        console.log('PASSO 1: Criando débito de 100...');
        
        let balance = await PatientBalance.getOrCreate(TEST_PATIENT_ID);
        await balance.addDebit(100, 'Sessão de teste - Débito 100', null, null, null);
        
        // Verifica saldo após débito
        balance = await PatientBalance.findOne({ patient: TEST_PATIENT_ID });
        console.log('  Saldo após débito:', balance.currentBalance);
        console.log('  Total debitado:', balance.totalDebited);
        console.log('  Total creditado:', balance.totalCredited);
        
        expect(balance.currentBalance).toBe(100);
        expect(balance.totalDebited).toBe(100);
        expect(balance.totalCredited).toBe(0);
        
        // ============================================================
        // PASSO 2: Fazer pagamento de 90
        // ============================================================
        console.log('PASSO 2: Fazendo pagamento de 90...');
        
        await balance.addPayment(90, 'dinheiro', 'Pagamento parcial - 90', null);
        
        // Verifica saldo após pagamento
        balance = await PatientBalance.findOne({ patient: TEST_PATIENT_ID });
        console.log('  Saldo após pagamento:', balance.currentBalance);
        console.log('  Total debitado:', balance.totalDebited);
        console.log('  Total creditado:', balance.totalCredited);
        
        // ============================================================
        // PASSO 3: Verificar resultado
        // ============================================================
        console.log('PASSO 3: Verificando resultado...');
        
        // O saldo deve ser 10 (100 - 90)
        expect(balance.currentBalance).toBe(10);
        expect(balance.totalDebited).toBe(100);
        expect(balance.totalCredited).toBe(90);
        
        // Verificar transações
        const debitTransactions = balance.transactions.filter(t => t.type === 'debit');
        const paymentTransactions = balance.transactions.filter(t => t.type === 'payment');
        
        console.log('  Transações de débito:', debitTransactions.length);
        console.log('  Transações de pagamento:', paymentTransactions.length);
        
        expect(debitTransactions).toHaveLength(1);
        expect(debitTransactions[0].amount).toBe(100);
        
        expect(paymentTransactions).toHaveLength(1);
        expect(paymentTransactions[0].amount).toBe(90);
        
        console.log('✅ TESTE PASSOU: Saldo foi abatido corretamente!');
        console.log('   Débito: 100 | Pagamento: 90 | Saldo final: 10');
    });

    it('deve zerar o saldo quando pagamento é total', async () => {
        const patientId = new mongoose.Types.ObjectId();
        
        // Cria débito de 150
        let balance = await PatientBalance.getOrCreate(patientId);
        await balance.addDebit(150, 'Sessão de teste - Débito 150', null, null, null);
        
        // Paga integralmente
        await balance.addPayment(150, 'cartao_credito', 'Pagamento total', null);
        
        // Verifica
        balance = await PatientBalance.findOne({ patient: patientId });
        
        expect(balance.currentBalance).toBe(0);
        expect(balance.totalDebited).toBe(150);
        expect(balance.totalCredited).toBe(150);
        
        console.log('✅ TESTE PASSOU: Saldo zerado corretamente!');
        
        // Limpa
        await PatientBalance.deleteOne({ patient: patientId });
    });
});
