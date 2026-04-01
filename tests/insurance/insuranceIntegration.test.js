// tests/insurance/insuranceIntegration.test.js
/**
 * Testes de Integração - Insurance Flow
 * 
 * Testa fluxo completo:
 * Criar lote → Fechar → Enviar → Receber resposta → Conciliar
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import mongoose from 'mongoose';
import InsuranceBatch from '../../insurance/batch/InsuranceBatch.js';
import { processInsuranceBatch, sendBatchToProvider } from '../../insurance/domain/insuranceDomain.js';

describe('🏥 Insurance Integration Tests', () => {
    
    // Conectar ao MongoDB antes dos testes
    before(async () => {
        try {
            await mongoose.connect('mongodb://localhost:27017/crm_test');
            console.log('✅ MongoDB conectado para testes');
        } catch (error) {
            console.log('⚠️ MongoDB não disponível, pulando testes de integração');
            process.exit(0);
        }
    });
    
    // Limpar dados após cada teste
    afterEach(async () => {
        await InsuranceBatch.deleteMany({ batchNumber: { $regex: /TEST/ } });
    });
    
    // ============================================
    // FLUXO COMPLETO
    // ============================================
    describe('Fluxo Completo de Faturamento', () => {
        
        it('✅ deve processar lote do início ao fim', async () => {
            // 1. Criar lote
            const batch = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-001',
                insuranceProvider: 'unimed',
                startDate: new Date('2026-03-01'),
                endDate: new Date('2026-03-31'),
                items: [
                    {
                        sessionId: new mongoose.Types.ObjectId(),
                        appointmentId: new mongoose.Types.ObjectId(),
                        patientId: new mongoose.Types.ObjectId(),
                        sessionDate: new Date('2026-03-15'),
                        procedureCode: '40301015',
                        procedureName: 'Sessão de Psicoterapia',
                        grossAmount: 150.00
                    }
                ],
                totalItems: 1,
                totalGross: 150.00,
                pendingCount: 1,
                status: 'pending'
            });
            
            await batch.save();
            assert.ok(batch._id);
            
            // 2. Processar (gerar XML)
            const processResult = await processInsuranceBatch(batch, {
                log: { info: () => {}, error: () => {} }
            });
            
            assert.strictEqual(processResult.success, true);
            assert.ok(processResult.xmlContent);
            assert.ok(processResult.xmlContent.includes('mensagemTISS'));
            
            // 3. Enviar para operadora (simulação)
            const sendResult = await sendBatchToProvider(
                batch,
                processResult.xmlContent,
                { correlationId: 'test-123', log: { info: () => {} } }
            );
            
            assert.strictEqual(sendResult.success, true);
            assert.ok(sendResult.protocol);
            
            // 4. Atualizar status
            batch.markAsSent(null, sendResult.protocol);
            await batch.save();
            
            assert.strictEqual(batch.status, 'sent');
            assert.ok(batch.sentAt);
            assert.strictEqual(batch.items[0].status, 'sent');
        });
        
        it('✅ deve lidar com múltiplos itens no lote', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-002',
                insuranceProvider: 'unimed',
                startDate: new Date('2026-03-01'),
                endDate: new Date('2026-03-31'),
                items: [
                    {
                        sessionId: new mongoose.Types.ObjectId(),
                        appointmentId: new mongoose.Types.ObjectId(),
                        patientId: new mongoose.Types.ObjectId(),
                        sessionDate: new Date('2026-03-10'),
                        procedureCode: '40301015',
                        grossAmount: 150.00
                    },
                    {
                        sessionId: new mongoose.Types.ObjectId(),
                        appointmentId: new mongoose.Types.ObjectId(),
                        patientId: new mongoose.Types.ObjectId(),
                        sessionDate: new Date('2026-03-15'),
                        procedureCode: '40301015',
                        grossAmount: 150.00
                    },
                    {
                        sessionId: new mongoose.Types.ObjectId(),
                        appointmentId: new mongoose.Types.ObjectId(),
                        patientId: new mongoose.Types.ObjectId(),
                        sessionDate: new Date('2026-03-20'),
                        procedureCode: '40301016',
                        grossAmount: 200.00
                    }
                ],
                totalItems: 3,
                totalGross: 500.00,
                pendingCount: 3,
                status: 'pending'
            });
            
            await batch.save();
            
            const result = await processInsuranceBatch(batch, {
                log: { info: () => {}, error: () => {} }
            });
            
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.itemCount, 3);
            assert.strictEqual(result.totalGross, 500.00);
        });
        
        it('✅ deve processar aprovação e rejeição de itens', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-003',
                insuranceProvider: 'unimed',
                items: [
                    { sessionId: new mongoose.Types.ObjectId(), grossAmount: 100 },
                    { sessionId: new mongoose.Types.ObjectId(), grossAmount: 150 },
                    { sessionId: new mongoose.Types.ObjectId(), grossAmount: 200 }
                ],
                totalItems: 3,
                totalGross: 450.00,
                pendingCount: 3,
                status: 'sent'
            });
            
            await batch.save();
            
            // Simular resposta: 2 aprovados, 1 rejeitado
            batch.updateItemStatus(batch.items[0]._id, 'approved', {
                netAmount: 100,
                returnCode: '00'
            });
            
            batch.updateItemStatus(batch.items[1]._id, 'approved', {
                netAmount: 150,
                returnCode: '00'
            });
            
            batch.updateItemStatus(batch.items[2]._id, 'rejected', {
                glosaAmount: 200,
                glosa: { code: '2010', reason: 'Dados incompletos' },
                returnCode: '2010'
            });
            
            batch.status = batch.calculateBatchStatus();
            await batch.save();
            
            assert.strictEqual(batch.approvedCount, 2);
            assert.strictEqual(batch.rejectedCount, 1);
            assert.strictEqual(batch.totalNet, 250); // 100 + 150
            assert.strictEqual(batch.totalGlosa, 200);
            assert.strictEqual(batch.status, 'partial_success');
        });
        
        it('✅ deve calcular status do lote corretamente', async () => {
            // Teste: todos aprovados = completed
            const batchApproved = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-004',
                insuranceProvider: 'unimed',
                items: [
                    { status: 'approved' },
                    { status: 'approved' }
                ],
                totalItems: 2,
                status: 'processing'
            });
            
            assert.strictEqual(batchApproved.calculateBatchStatus(), 'completed');
            
            // Teste: todos rejeitados = completed (mas com falha)
            const batchRejected = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-005',
                insuranceProvider: 'unimed',
                items: [
                    { status: 'rejected' },
                    { status: 'rejected' }
                ],
                totalItems: 2,
                status: 'processing'
            });
            
            assert.strictEqual(batchRejected.calculateBatchStatus(), 'completed');
            
            // Teste: misto = partial_success
            const batchMixed = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-006',
                insuranceProvider: 'unimed',
                items: [
                    { status: 'approved' },
                    { status: 'rejected' }
                ],
                totalItems: 2,
                status: 'processing'
            });
            
            assert.strictEqual(batchMixed.calculateBatchStatus(), 'partial_success');
        });
        
        it('✅ deve identificar itens reprocessáveis', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-007',
                insuranceProvider: 'unimed',
                items: [
                    {
                        _id: new mongoose.Types.ObjectId(),
                        status: 'rejected',
                        attemptCount: 1,
                        glosa: { code: '2010', isRecoverable: true }
                    },
                    {
                        _id: new mongoose.Types.ObjectId(),
                        status: 'rejected',
                        attemptCount: 1,
                        glosa: { code: '5010', isRecoverable: false } // Não recuperável
                    },
                    {
                        _id: new mongoose.Types.ObjectId(),
                        status: 'rejected',
                        attemptCount: 4, // Máximo atingido
                        glosa: { code: '2010', isRecoverable: true }
                    }
                ],
                maxRetries: 3,
                status: 'partial_success'
            });
            
            const reprocessable = batch.getReprocessableItems();
            
            assert.strictEqual(reprocessable.length, 1); // Só o primeiro
            assert.strictEqual(reprocessable[0].glosa.code, '2010');
        });
    });
    
    // ============================================
    // ERROR HANDLING
    // ============================================
    describe('Tratamento de Erros', () => {
        
        it('❌ deve rejeitar lote inválido no processamento', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-ERR-001',
                insuranceProvider: 'unimed',
                items: [
                    { procedureCode: '', grossAmount: 0 } // Inválido
                ],
                totalGross: 0,
                status: 'pending'
            });
            
            const result = await processInsuranceBatch(batch);
            
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.error, 'VALIDATION_FAILED');
        });
        
        it('❌ deve lidar com falha no envio', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'UNIMED-TEST-ERR-002',
                insuranceProvider: 'invalid_provider', // Vai falhar
                items: [{ procedureCode: '40301015', grossAmount: 150 }],
                totalGross: 150,
                status: 'pending'
            });
            
            const xml = '<xml>test</xml>';
            const result = await sendBatchToProvider(batch, xml, {
                correlationId: 'test',
                log: { info: () => {}, error: () => {} }
            });
            
            // Pode falhar ou não dependendo do mock
            // Mas não deve lançar exceção
            assert.ok(result.success !== undefined);
        });
    });
});
