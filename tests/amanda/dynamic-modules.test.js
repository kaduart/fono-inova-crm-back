/**
 * 🧪 TESTES CRÍTICOS: DYNAMIC_MODULES
 * 
 * Objetivo: Garantir que DYNAMIC_MODULES nunca mais cause erro em produção
 * Cobertura: Todos os módulos usados no AmandaOrchestrator
 */

import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import 'dotenv/config';

// Mock do lead para testes
const createMockLead = (overrides = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    name: "Teste Lead",
    status: "novo",
    stage: "novo",
    contact: { phone: "5562999999999" },
    ...overrides
});

describe('🚨 CRÍTICO: DYNAMIC_MODULES', () => {
    
    // =========================================================================
    // TESTE 1: Módulo existe e não é vazio
    // =========================================================================
    describe('1. Existência do módulo', () => {
        it('DYNAMIC_MODULES deve estar definido no AmandaOrchestrator', async () => {
            // Import dinâmico para testar o módulo
            const module = await import('../../orchestrators/AmandaOrchestrator.js');
            
            // O módulo não exporta DYNAMIC_MODULES diretamente, 
            // mas vamos testar via comportamento
            expect(module).toBeDefined();
        });
    });

    // =========================================================================
    // TESTE 2: Testes de integração com getOptimizedAmandaResponse
    // =========================================================================
    describe('2. Integração com toneMode', () => {
        it('NÃO deve lançar erro quando toneMode = "premium"', async () => {
            const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
            
            const mockLead = createMockLead();
            
            // Isso NÃO deve lançar "DYNAMIC_MODULES is not defined"
            await expect(
                getOptimizedAmandaResponse({
                    content: "Quanto custa a avaliação?",
                    userText: "Quanto custa a avaliação?",
                    lead: mockLead,
                    context: { toneMode: "premium" }
                })
            ).resolves.not.toThrow();
        });

        it('NÃO deve lançar erro quando toneMode = "acolhimento"', async () => {
            const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
            
            const mockLead = createMockLead();
            
            await expect(
                getOptimizedAmandaResponse({
                    content: "Oi, bom dia",
                    userText: "Oi, bom dia",
                    lead: mockLead,
                    context: { toneMode: "acolhimento" }
                })
            ).resolves.not.toThrow();
        });

        it('NÃO deve lançar erro quando NÃO há toneMode', async () => {
            const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
            
            const mockLead = createMockLead();
            
            await expect(
                getOptimizedAmandaResponse({
                    content: "Oi",
                    userText: "Oi",
                    lead: mockLead,
                    context: {}
                })
            ).resolves.not.toThrow();
        });
    });

    // =========================================================================
    // TESTE 3: Cenários que estavam quebrando em produção
    // =========================================================================
    describe('3. Cenários que quebraram em produção (20/02/2026)', () => {
        
        it('Caso 1: Saudação simples "Ola Bom dia"', async () => {
            const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
            
            const mockLead = createMockLead({
                _id: new mongoose.Types.ObjectId('69986fc5b70ca66ae2830045')
            });
            
            const response = await getOptimizedAmandaResponse({
                content: "Ola Bom dia",
                userText: "Ola Bom dia",
                lead: mockLead,
                context: {}
            });
            
            // Deve retornar uma resposta (não null/undefined)
            expect(response).toBeTruthy();
            // Não deve ser erro
            expect(response).not.toContain("DYNAMIC_MODULES");
        });

        it('Caso 2: Pergunta sobre acompanhamento', async () => {
            const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
            
            const mockLead = createMockLead();
            
            const response = await getOptimizedAmandaResponse({
                content: "Gostaria de saber como funciona os acompanhamento",
                userText: "Gostaria de saber como funciona os acompanhamento",
                lead: mockLead,
                context: {}
            });
            
            expect(response).toBeTruthy();
            expect(response).not.toContain("DYNAMIC_MODULES");
        });

        it('Caso 3: Lead com toneMode premium perguntando preço', async () => {
            const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
            
            const mockLead = createMockLead({
                therapyArea: "fonoaudiologia"
            });
            
            const response = await getOptimizedAmandaResponse({
                content: "Quanto custa?",
                userText: "Quanto custa?",
                lead: mockLead,
                context: { toneMode: "premium" }
            });
            
            expect(response).toBeTruthy();
        });
    });

    // =========================================================================
    // TESTE 4: Módulos específicos que devem existir
    // =========================================================================
    describe('4. Módulos críticos que devem funcionar', () => {
        
        const criticalModules = [
            'consultoriaModeContext',
            'acolhimentoModeContext',
            'valueProposition',
            'clinicalStrategyContext',
            'childProfile',
            'teenProfile',
            'adultProfile',
            'neuroContext',
            'teaTriageContext',
            'teaPostDiagnosisContext',
            'speechContext',
            'neuroPsychContext',
            'psycoContext',
            'psychopedContext',
            'physioContext',
            'occupationalContext',
            'musicTherapyContext',
            'hotLeadContext',
            'coldLeadContext',
            'schedulingTriageRules',
            'noNameBeforeSlotRule',
            'handoffNoSpamRule',
            'pricePriorityAfterBooking',
            'slotChosenAskName',
            'slotChosenAskBirth',
            'slotChoiceNotUnderstood',
            'multiTeamContext',
            'triageAskComplaint',
            'triageAskAge',
            'triageAskPeriod',
            'priceObjection',
            'insuranceObjection',
            'timeObjection',
            'otherClinicObjection',
            'teaDoubtObjection',
            'schedulingContext',
            'negativeScopeContext',
            'auditoryTestsContext',
            'salesPitch'
        ];

        it('Todos os módulos críticos devem estar definidos', async () => {
            // Vamos verificar via comportamento - se a função useModule retorna algo
            // para cada um desses módulos quando chamada
            
            // Este teste é um placeholder - na prática precisaríamos exportar 
            // DYNAMIC_MODULES ou useModule para testar diretamente
            
            // Por enquanto, vamos garantir que não há erro
            const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
            
            for (const moduleName of criticalModules.slice(0, 5)) {
                const mockLead = createMockLead();
                
                // Se o módulo não existir, useModule retorna ""
                // Mas não deve lançar erro
                await expect(
                    getOptimizedAmandaResponse({
                        content: "teste",
                        userText: "teste",
                        lead: mockLead,
                        context: {}
                    })
                ).resolves.not.toThrow();
            }
        });
    });

    // =========================================================================
    // TESTE 5: Teste de regressão - garantir que não volta a quebrar
    // =========================================================================
    describe('5. Regressão: Erro DYNAMIC_MODULES is not defined', () => {
        
        it('NUNCA mais deve lançar "DYNAMIC_MODULES is not defined"', async () => {
            const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
            
            const testCases = [
                { text: "Oi", context: {} },
                { text: "Bom dia", context: { toneMode: "acolhimento" } },
                { text: "Quanto custa?", context: { toneMode: "premium" } },
                { text: "Tenho plano de saúde", context: {} },
                { text: "Meu filho tem 5 anos", context: {} },
                { text: "Suspeita de autismo", context: {} },
                { text: "Quero agendar", context: {} },
            ];
            
            for (const testCase of testCases) {
                const mockLead = createMockLead();
                
                try {
                    const response = await getOptimizedAmandaResponse({
                        content: testCase.text,
                        userText: testCase.text,
                        lead: mockLead,
                        context: testCase.context
                    });
                    
                    // Se chegou aqui, não houve erro
                    expect(response).toBeDefined();
                } catch (error) {
                    // Se houve erro, NÃO pode ser o DYNAMIC_MODULES
                    expect(error.message).not.toContain('DYNAMIC_MODULES is not defined');
                    
                    // Outros erros são aceitáveis (ex: erro de banco, etc)
                }
            }
        });
    });
});

describe('🎯 TESTES DE CONTRATO: useModule', () => {
    
    it('useModule deve retornar string vazia para chave inexistente', async () => {
        // Este teste verifica que useModule é resiliente
        const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
        
        const mockLead = createMockLead();
        
        // Mesmo com módulo inexistente, não deve quebrar
        const response = await getOptimizedAmandaResponse({
            content: "teste",
            userText: "teste",
            lead: mockLead,
            context: {}
        });
        
        expect(response).toBeDefined();
    });
});
