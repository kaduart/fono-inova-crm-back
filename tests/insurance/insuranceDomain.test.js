// tests/insurance/insuranceDomain.test.js
/**
 * Testes Unitários - Insurance Domain Logic
 * 
 * Cobre:
 * - Validação de lotes
 * - Cálculo de métricas
 * - Análise de glosa
 * - Conciliação de pagamentos
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    validateBatch,
    canAddItemToBatch,
    calculateBatchMetrics,
    analyzeGlosa,
    reconcilePayment,
    groupItemsByGuideType
} from '../../insurance/domain/insuranceDomain.js';

describe('🏥 Insurance Domain Tests', () => {
    
    // ============================================
    // VALIDATE BATCH
    // ============================================
    describe('validateBatch()', () => {
        
        it('✅ deve validar lote completo corretamente', () => {
            const batch = {
                insuranceProvider: 'unimed',
                items: [
                    {
                        sessionId: 'sess-001',
                        patientId: 'pat-001',
                        procedureCode: '40301015',
                        grossAmount: 150.00,
                        sessionDate: new Date('2026-03-15')
                    }
                ],
                totalGross: 150.00
            };
            
            const result = validateBatch(batch);
            
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.error, undefined);
        });
        
        it('❌ deve rejeitar lote sem convênio', () => {
            const batch = {
                items: [],
                totalGross: 0
            };
            
            const result = validateBatch(batch);
            
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.error, 'VALIDATION_FAILED');
            assert.ok(result.details.includes('Convênio não informado'));
        });
        
        it('❌ deve rejeitar lote sem itens', () => {
            const batch = {
                insuranceProvider: 'unimed',
                items: [],
                totalGross: 0
            };
            
            const result = validateBatch(batch);
            
            assert.strictEqual(result.valid, false);
            assert.ok(result.details.includes('Lote sem itens'));
        });
        
        it('❌ deve rejeitar item sem código de procedimento', () => {
            const batch = {
                insuranceProvider: 'unimed',
                items: [
                    {
                        sessionId: 'sess-001',
                        patientId: 'pat-001',
                        // procedureCode ausente
                        grossAmount: 150.00,
                        sessionDate: new Date()
                    }
                ],
                totalGross: 150.00
            };
            
            const result = validateBatch(batch);
            
            assert.strictEqual(result.valid, false);
            assert.ok(result.details.some(d => d.includes('código do procedimento')));
        });
        
        it('❌ deve rejeitar valor total divergente', () => {
            const batch = {
                insuranceProvider: 'unimed',
                items: [
                    {
                        sessionId: 'sess-001',
                        patientId: 'pat-001',
                        procedureCode: '40301015',
                        grossAmount: 150.00,
                        sessionDate: new Date()
                    }
                ],
                totalGross: 200.00 // Valor errado
            };
            
            const result = validateBatch(batch);
            
            assert.strictEqual(result.valid, false);
            assert.ok(result.details.some(d => d.includes('Divergência no valor total')));
        });
        
        it('❌ deve rejeitar valor inválido (zero ou negativo)', () => {
            const batch = {
                insuranceProvider: 'unimed',
                items: [
                    {
                        sessionId: 'sess-001',
                        patientId: 'pat-001',
                        procedureCode: '40301015',
                        grossAmount: 0, // Inválido
                        sessionDate: new Date()
                    }
                ],
                totalGross: 0
            };
            
            const result = validateBatch(batch);
            
            assert.strictEqual(result.valid, false);
            assert.ok(result.details.some(d => d.includes('valor inválido')));
        });
    });
    
    // ============================================
    // CAN ADD ITEM TO BATCH
    // ============================================
    describe('canAddItemToBatch()', () => {
        
        it('✅ deve permitir adicionar item em lote pendente', () => {
            const batch = {
                status: 'pending',
                items: [],
                startDate: new Date('2026-03-01'),
                endDate: new Date('2026-03-31')
            };
            
            const item = {
                sessionId: 'sess-001',
                sessionDate: new Date('2026-03-15')
            };
            
            const result = canAddItemToBatch(batch, item);
            
            assert.strictEqual(result.canAdd, true);
        });
        
        it('❌ deve negar adição em lote já enviado', () => {
            const batch = {
                status: 'sent',
                items: [],
                startDate: new Date('2026-03-01'),
                endDate: new Date('2026-03-31')
            };
            
            const item = { sessionId: 'sess-001', sessionDate: new Date() };
            
            const result = canAddItemToBatch(batch, item);
            
            assert.strictEqual(result.canAdd, false);
            assert.strictEqual(result.reason, 'BATCH_ALREADY_SENT');
        });
        
        it('❌ deve negar sessão duplicada no mesmo lote', () => {
            const batch = {
                status: 'pending',
                items: [
                    { sessionId: 'sess-001' }
                ],
                startDate: new Date('2026-03-01'),
                endDate: new Date('2026-03-31')
            };
            
            const item = {
                sessionId: 'sess-001', // Mesma sessão
                sessionDate: new Date('2026-03-15')
            };
            
            const result = canAddItemToBatch(batch, item);
            
            assert.strictEqual(result.canAdd, false);
            assert.strictEqual(result.reason, 'SESSION_ALREADY_IN_BATCH');
        });
        
        it('❌ deve negar item fora do período do lote', () => {
            const batch = {
                status: 'pending',
                items: [],
                startDate: new Date('2026-03-01'),
                endDate: new Date('2026-03-31')
            };
            
            const item = {
                sessionId: 'sess-001',
                sessionDate: new Date('2026-02-15') // Fora do período
            };
            
            const result = canAddItemToBatch(batch, item);
            
            assert.strictEqual(result.canAdd, false);
            assert.strictEqual(result.reason, 'DATE_OUTSIDE_BATCH_PERIOD');
        });
    });
    
    // ============================================
    // CALCULATE BATCH METRICS
    // ============================================
    describe('calculateBatchMetrics()', () => {
        
        it('✅ deve calcular métricas corretamente', () => {
            const batch = {
                items: [
                    { status: 'approved', grossAmount: 100, glosaAmount: 0 },
                    { status: 'approved', grossAmount: 150, glosaAmount: 0 },
                    { status: 'rejected', grossAmount: 200, glosaAmount: 200 },
                    { status: 'pending', grossAmount: 100, glosaAmount: 0 }
                ]
            };
            
            const metrics = calculateBatchMetrics(batch);
            
            assert.strictEqual(metrics.totalItems, 4);
            assert.strictEqual(metrics.approvedCount, 2);
            assert.strictEqual(metrics.rejectedCount, 1);
            assert.strictEqual(metrics.pendingCount, 1);
            assert.strictEqual(metrics.approvalRate, 50);
            assert.strictEqual(metrics.glosaRate, 40); // 200/500 = 40%
            assert.strictEqual(metrics.averageItemValue, 137.5); // 550/4
        });
        
        it('✅ deve retornar zeros para lote vazio', () => {
            const batch = { items: [] };
            
            const metrics = calculateBatchMetrics(batch);
            
            assert.strictEqual(metrics.totalItems, 0);
            assert.strictEqual(metrics.approvalRate, 0);
        });
        
        it('✅ deve calcular aprovação 100%', () => {
            const batch = {
                items: [
                    { status: 'approved', grossAmount: 100 },
                    { status: 'approved', grossAmount: 100 }
                ]
            };
            
            const metrics = calculateBatchMetrics(batch);
            
            assert.strictEqual(metrics.approvalRate, 100);
            assert.strictEqual(metrics.glosaRate, 0);
        });
    });
    
    // ============================================
    // ANALYZE GLOSA
    // ============================================
    describe('analyzeGlosa()', () => {
        
        it('✅ deve classificar glosa baixa (recuperável)', () => {
            const glosa = {
                code: '2010',
                reason: 'Dados incompletos',
                amount: 50
            };
            
            const analysis = analyzeGlosa(glosa);
            
            assert.strictEqual(analysis.severity, 'low');
            assert.strictEqual(analysis.action, 'auto_retry');
            assert.strictEqual(analysis.isRecoverable, true);
            assert.strictEqual(analysis.requiresManualReview, false);
        });
        
        it('✅ deve classificar glosa média (revisão manual)', () => {
            const glosa = {
                code: '3010',
                reason: 'Autorização pendente',
                amount: 150
            };
            
            const analysis = analyzeGlosa(glosa);
            
            assert.strictEqual(analysis.severity, 'medium');
            assert.strictEqual(analysis.action, 'manual_review');
            assert.strictEqual(analysis.isRecoverable, true);
            assert.strictEqual(analysis.requiresManualReview, true);
        });
        
        it('✅ deve classificar glosa alta (recurso)', () => {
            const glosa = {
                code: '4010',
                reason: 'Procedimento não coberto',
                amount: 500
            };
            
            const analysis = analyzeGlosa(glosa);
            
            assert.strictEqual(analysis.severity, 'high');
            assert.strictEqual(analysis.action, 'appeal');
            assert.strictEqual(analysis.isRecoverable, true);
            assert.strictEqual(analysis.requiresManualReview, true);
        });
        
        it('✅ deve classificar glosa crítica (perda)', () => {
            const glosa = {
                code: '5010',
                reason: 'Erro crítico',
                amount: 200
            };
            
            const analysis = analyzeGlosa(glosa);
            
            assert.strictEqual(analysis.severity, 'critical');
            assert.strictEqual(analysis.action, 'write_off');
            assert.strictEqual(analysis.isRecoverable, false);
        });
        
        it('✅ deve calcular impacto financeiro', () => {
            const glosa = {
                code: '2010',
                reason: 'Dados incompletos',
                amount: 100
            };
            
            const analysis = analyzeGlosa(glosa);
            
            assert.strictEqual(analysis.impact.amount, 100);
            assert.strictEqual(analysis.impact.severityWeight, 1); // low
            assert.strictEqual(analysis.impact.priorityScore, 100);
        });
        
        it('✅ deve calcular prioridade alta para valores grandes', () => {
            const glosa = {
                code: '4010',
                reason: 'Procedimento não coberto',
                amount: 1000
            };
            
            const analysis = analyzeGlosa(glosa);
            
            assert.strictEqual(analysis.impact.priorityScore, 3000); // 1000 * 3 (high)
        });
    });
    
    // ============================================
    // RECONCILE PAYMENT
    // ============================================
    describe('reconcilePayment()', () => {
        
        it('✅ deve conciliar pagamento exato', () => {
            const batch = {
                totalNet: 1000.00,
                items: [
                    { _id: 'item-1', status: 'approved' },
                    { _id: 'item-2', status: 'approved' }
                ]
            };
            
            const paymentData = {
                amount: 1000.00,
                items: [{ itemId: 'item-1' }, { itemId: 'item-2' }]
            };
            
            const result = reconcilePayment(batch, paymentData);
            
            assert.strictEqual(result.status, 'completed');
            assert.strictEqual(result.isComplete, true);
            assert.strictEqual(result.requiresAction, false);
            assert.strictEqual(result.difference, 0);
        });
        
        it('⚠️ deve detectar pagamento menor (quebra)', () => {
            const batch = {
                totalNet: 1000.00,
                items: [{ _id: 'item-1', status: 'approved' }]
            };
            
            const paymentData = {
                amount: 950.00,
                items: [{ itemId: 'item-1' }]
            };
            
            const result = reconcilePayment(batch, paymentData);
            
            assert.strictEqual(result.status, 'partial');
            assert.strictEqual(result.difference, -50);
            assert.strictEqual(result.requiresAction, true);
            assert.ok(result.discrepancies.some(d => d.type === 'shortfall'));
        });
        
        it('⚠️ deve detectar pagamento maior (sobra)', () => {
            const batch = {
                totalNet: 1000.00,
                items: [{ _id: 'item-1', status: 'approved' }]
            };
            
            const paymentData = {
                amount: 1100.00,
                items: [{ itemId: 'item-1' }]
            };
            
            const result = reconcilePayment(batch, paymentData);
            
            assert.strictEqual(result.status, 'partial');
            assert.strictEqual(result.difference, 100);
            assert.ok(result.discrepancies.some(d => d.type === 'overage'));
        });
        
        it('⚠️ deve detectar itens não pagos', () => {
            const batch = {
                totalNet: 1000.00,
                items: [
                    { _id: 'item-1', status: 'approved' },
                    { _id: 'item-2', status: 'approved' } // Não pago
                ]
            };
            
            const paymentData = {
                amount: 500.00,
                items: [{ itemId: 'item-1' }] // Só item-1
            };
            
            const result = reconcilePayment(batch, paymentData);
            
            assert.strictEqual(result.status, 'partial');
            assert.ok(result.discrepancies.some(d => d.type === 'missing_payments'));
            const missing = result.discrepancies.find(d => d.type === 'missing_payments');
            assert.strictEqual(missing.count, 1);
        });
        
        it('✅ deve tolerar diferença de 1 centavo', () => {
            const batch = {
                totalNet: 1000.00,
                items: [{ _id: 'item-1', status: 'approved' }]
            };
            
            const paymentData = {
                amount: 999.99, // 1 centavo a menos
                items: [{ itemId: 'item-1' }]
            };
            
            const result = reconcilePayment(batch, paymentData);
            
            assert.strictEqual(result.status, 'completed'); // Tolerado
            assert.strictEqual(result.isComplete, true);
        });
    });
    
    // ============================================
    // GROUP ITEMS BY GUIDE TYPE
    // ============================================
    describe('groupItemsByGuideType()', () => {
        
        it('✅ deve agrupar por tipo de guia', () => {
            const items = [
                { procedureCode: '10101012' }, // Consulta
                { procedureCode: '10102013' }, // Consulta
                { procedureCode: '20101015' }, // Procedimento
                { procedureCode: '40301015' }, // Terapia
                { procedureCode: '99999999' }  // Outro
            ];
            
            const groups = groupItemsByGuideType(items);
            
            assert.strictEqual(groups.consultation.length, 2);
            assert.strictEqual(groups.procedure.length, 1);
            assert.strictEqual(groups.therapy.length, 1);
            assert.strictEqual(groups.other.length, 1);
        });
        
        it('✅ deve lidar com lista vazia', () => {
            const groups = groupItemsByGuideType([]);
            
            assert.strictEqual(groups.consultation.length, 0);
            assert.strictEqual(groups.procedure.length, 0);
            assert.strictEqual(groups.therapy.length, 0);
        });
    });
});
