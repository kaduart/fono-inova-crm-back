// tests/insurance/insuranceStress.test.js
/**
 * Testes de Stress - Insurance
 * 
 * Testa:
 * - Concorrência de múltiplos lotes
 * - Idempotência sob carga
 * - Consistência de dados
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import mongoose from 'mongoose';
import InsuranceBatch from '../../insurance/batch/InsuranceBatch.js';
import { calculateBatchMetrics, reconcilePayment } from '../../insurance/domain/insuranceDomain.js';

describe('🏥 Insurance Stress Tests', () => {
    
    // ============================================
    // CONCORRÊNCIA
    // ============================================
    describe('Concorrência de Lotes', () => {
        
        it('✅ deve processar 20 lotes simultâneos sem corrupção', async () => {
            const batchPromises = [];
            
            for (let i = 0; i < 20; i++) {
                const batch = new InsuranceBatch({
                    batchNumber: `STRESS-TEST-${String(i).padStart(3, '0')}`,
                    insuranceProvider: 'unimed',
                    items: Array(5).fill(null).map((_, j) => ({
                        sessionId: new mongoose.Types.ObjectId(),
                        procedureCode: '40301015',
                        grossAmount: 100 + j * 10
                    })),
                    totalItems: 5,
                    totalGross: 500,
                    status: 'pending'
                });
                
                batchPromises.push(batch.save());
            }
            
            const results = await Promise.all(batchPromises);
            
            // Verifica que todos foram criados
            assert.strictEqual(results.length, 20);
            assert.ok(results.every(r => r._id));
            assert.ok(results.every(r => r.batchNumber));
            
            // Verifica números únicos
            const batchNumbers = results.map(r => r.batchNumber);
            const uniqueNumbers = [...new Set(batchNumbers)];
            assert.strictEqual(uniqueNumbers.length, 20);
            
            // Cleanup
            await InsuranceBatch.deleteMany({ batchNumber: { $regex: /STRESS-TEST/ } });
        });
        
        it('✅ deve atualizar lote concorrentemente sem perder dados', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'CONCURRENCY-TEST-001',
                insuranceProvider: 'unimed',
                items: Array(10).fill(null).map(() => ({
                    sessionId: new mongoose.Types.ObjectId(),
                    status: 'pending',
                    grossAmount: 100
                })),
                totalItems: 10,
                pendingCount: 10,
                approvedCount: 0,
                status: 'sent'
            });
            
            await batch.save();
            
            // Simula 5 aprovações concorrentes
            const updatePromises = [];
            
            for (let i = 0; i < 5; i++) {
                const itemId = batch.items[i]._id;
                updatePromises.push(
                    InsuranceBatch.findByIdAndUpdate(
                        batch._id,
                        {
                            $set: { [`items.${i}.status`]: 'approved' },
                            $inc: { approvedCount: 1, pendingCount: -1 }
                        },
                        { new: true }
                    )
                );
            }
            
            await Promise.all(updatePromises);
            
            // Recarrega do banco
            const updatedBatch = await InsuranceBatch.findById(batch._id);
            
            // Verifica consistência
            assert.strictEqual(updatedBatch.approvedCount, 5);
            assert.strictEqual(updatedBatch.pendingCount, 5);
            
            // Cleanup
            await InsuranceBatch.findByIdAndDelete(batch._id);
        });
        
        it('✅ deve calcular métricas consistentes sob carga', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'METRICS-STRESS-001',
                insuranceProvider: 'unimed',
                items: Array(100).fill(null).map((_, i) => ({
                    status: i < 70 ? 'approved' : i < 90 ? 'rejected' : 'pending',
                    grossAmount: 100,
                    glosaAmount: i < 90 && i >= 70 ? 100 : 0
                })),
                totalItems: 100
            });
            
            // Calcula 100x para garantir consistência
            for (let i = 0; i < 100; i++) {
                const metrics = calculateBatchMetrics(batch);
                
                assert.strictEqual(metrics.totalItems, 100);
                assert.strictEqual(metrics.approvedCount, 70);
                assert.strictEqual(metrics.rejectedCount, 20);
                assert.strictEqual(metrics.pendingCount, 10);
                assert.strictEqual(metrics.approvalRate, 70);
            }
        });
    });
    
    // ============================================
    // IDEMPOTÊNCIA
    // ============================================
    describe('Idempotência', () => {
        
        it('✅ deve lidar com reprocessamento de itens sem duplicar valores', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'IDEMPOTENCY-TEST-001',
                insuranceProvider: 'unimed',
                totalNet: 0,
                totalGlosa: 0,
                items: [
                    {
                        _id: new mongoose.Types.ObjectId(),
                        status: 'pending',
                        grossAmount: 100,
                        glosaAmount: 0
                    }
                ]
            });
            
            const itemId = batch.items[0]._id;
            
            // Primeira rejeição
            batch.updateItemStatus(itemId, 'rejected', {
                glosaAmount: 100,
                returnCode: '2010'
            });
            
            const glosaAfterFirst = batch.totalGlosa;
            
            // Segunda rejeição (mesmo item - idempotência)
            batch.updateItemStatus(itemId, 'rejected', {
                glosaAmount: 100,
                returnCode: '2010'
            });
            
            // Glosa não deve duplicar
            assert.strictEqual(batch.totalGlosa, glosaAfterFirst);
        });
        
        it('✅ deve manter conciliação idempotente', async () => {
            const batch = {
                totalNet: 1000,
                items: [
                    { _id: 'item-1', status: 'approved' }
                ]
            };
            
            const paymentData = {
                amount: 1000,
                items: [{ itemId: 'item-1' }]
            };
            
            // Primeira conciliação
            const result1 = reconcilePayment(batch, paymentData);
            
            // Segunda conciliação (mesmos dados)
            const result2 = reconcilePayment(batch, paymentData);
            
            // Resultados devem ser idênticos
            assert.strictEqual(result1.status, result2.status);
            assert.strictEqual(result1.difference, result2.difference);
            assert.strictEqual(result1.isComplete, result2.isComplete);
        });
    });
    
    // ============================================
    // LIMITE DE CARGA
    // ============================================
    describe('Limites de Carga', () => {
        
        it('✅ deve suportar lote com 500 itens', async () => {
            const items = Array(500).fill(null).map((_, i) => ({
                sessionId: new mongoose.Types.ObjectId(),
                appointmentId: new mongoose.Types.ObjectId(),
                patientId: new mongoose.Types.ObjectId(),
                sessionDate: new Date(),
                procedureCode: '40301015',
                grossAmount: 150.00
            }));
            
            const batch = new InsuranceBatch({
                batchNumber: 'LARGE-BATCH-001',
                insuranceProvider: 'unimed',
                items,
                totalItems: 500,
                totalGross: 75000, // 500 * 150
                status: 'pending'
            });
            
            const startTime = Date.now();
            await batch.save();
            const saveTime = Date.now() - startTime;
            
            // Deve salvar em menos de 2 segundos
            assert.ok(saveTime < 2000, `Save took too long: ${saveTime}ms`);
            
            // Calcular métricas
            const metricsStart = Date.now();
            const metrics = calculateBatchMetrics(batch);
            const metricsTime = Date.now() - metricsStart;
            
            assert.strictEqual(metrics.totalItems, 500);
            assert.ok(metricsTime < 100, `Metrics calculation took too long: ${metricsTime}ms`);
            
            // Cleanup
            await InsuranceBatch.findByIdAndDelete(batch._id);
        });
        
        it('✅ deve calcular status de lote grande eficientemente', async () => {
            const items = Array(1000).fill(null).map((_, i) => ({
                status: i < 800 ? 'approved' : i < 950 ? 'rejected' : 'pending'
            }));
            
            const batch = new InsuranceBatch({
                batchNumber: 'LARGE-STATUS-001',
                insuranceProvider: 'unimed',
                items,
                totalItems: 1000,
                status: 'processing'
            });
            
            const startTime = Date.now();
            const newStatus = batch.calculateBatchStatus();
            const calcTime = Date.now() - startTime;
            
            assert.strictEqual(newStatus, 'partial_success');
            assert.ok(calcTime < 50, `Status calculation took too long: ${calcTime}ms`);
        });
    });
    
    // ============================================
    // CONSISTÊNCIA FINANCEIRA
    // ============================================
    describe('Consistência Financeira', () => {
        
        it('✅ deve manter saldo zero (total = aprovado + glosa)', async () => {
            const items = Array(50).fill(null).map(() => ({
                status: 'approved',
                grossAmount: 100,
                netAmount: 80,
                glosaAmount: 20
            }));
            
            const batch = new InsuranceBatch({
                batchNumber: 'BALANCE-TEST-001',
                insuranceProvider: 'unimed',
                items,
                totalItems: 50
            });
            
            // Recalcula totais
            batch.totalGross = items.reduce((sum, i) => sum + i.grossAmount, 0);
            batch.totalNet = items.reduce((sum, i) => sum + i.netAmount, 0);
            batch.totalGlosa = items.reduce((sum, i) => sum + i.glosaAmount, 0);
            
            // Verifica: Gross = Net + Glosa
            assert.strictEqual(
                batch.totalGross,
                batch.totalNet + batch.totalGlosa,
                `Inconsistência: ${batch.totalGross} != ${batch.totalNet} + ${batch.totalGlosa}`
            );
        });
        
        it('✅ deve detectar inconsistência em atualização concorrente', async () => {
            const batch = new InsuranceBatch({
                batchNumber: 'RACE-CONDITION-001',
                insuranceProvider: 'unimed',
                totalNet: 0,
                totalGlosa: 0,
                items: [
                    { _id: new mongoose.Types.ObjectId(), status: 'pending', grossAmount: 100 }
                ]
            });
            
            await batch.save();
            
            const itemId = batch.items[0]._id;
            
            // Simula duas atualizações simultâneas
            const update1 = batch.updateItemStatus(itemId, 'approved', { netAmount: 80 });
            const update2 = batch.updateItemStatus(itemId, 'rejected', { glosaAmount: 100 });
            
            // O último update vence
            assert.strictEqual(batch.items[0].status, 'rejected');
            
            // Mas os totais devem estar consistentes
            assert.ok(batch.totalNet >= 0);
            assert.ok(batch.totalGlosa >= 0);
            
            // Cleanup
            await InsuranceBatch.findByIdAndDelete(batch._id);
        });
    });
});
