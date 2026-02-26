/**
 * 💬 TESTES DE FLUXO DE CONVERSA (2 LADOS)
 * 
 * Simula o diálogo entre usuário e Amanda
 * Verifica se Amanda não repete perguntas e avança o triageStep corretamente
 */

import { describe, it, expect } from 'vitest';
import { extractName, extractAgeFromText, extractPeriodFromText } from '../../utils/patientDataExtractor.js';

/**
 * Simula a lógica de decisão do Amanda para triagem
 * Retorna qual seria a próxima pergunta baseada no estado atual
 */
function simularDecisaoAmanda(estadoAtual, mensagemUsuario) {
    const { triageStep, qualificationData = {} } = estadoAtual;
    
    // Extrai dados da mensagem do usuário
    const periodo = extractPeriodFromText(mensagemUsuario);
    const nome = extractName(mensagemUsuario);
    const idade = extractAgeFromText(mensagemUsuario);
    
    // Merge com dados já existentes
    const dadosAtualizados = {
        ...qualificationData,
        ...(periodo && { periodo }),
        ...(nome && { nome }),
        ...(idade && { idade: idade.age, idadeUnidade: idade.unit })
    };
    
    // Lógica de decisão do Amanda
    let novoTriageStep = triageStep;
    let proximaPergunta = null;
    
    switch (triageStep) {
        case 'ask_period':
            if (periodo) {
                novoTriageStep = 'ask_profile';
                proximaPergunta = dadosAtualizados.nome ? 'ask_complaint' : 'ask_name';
            } else {
                proximaPergunta = 'ask_period'; // Repete
            }
            break;
            
        case 'ask_profile':
            if (nome) {
                novoTriageStep = 'ask_complaint';
                proximaPergunta = 'ask_complaint';
            } else {
                proximaPergunta = 'ask_name'; // Repete
            }
            break;
            
        case 'ask_complaint':
            novoTriageStep = 'done';
            proximaPergunta = null;
            break;
            
        default:
            proximaPergunta = 'ask_period';
            novoTriageStep = 'ask_period';
    }
    
    return {
        novoTriageStep,
        proximaPergunta,
        dadosExtraidos: dadosAtualizados,
        repetiuPergunta: triageStep === novoTriageStep && !['done', 'ask_complaint'].includes(triageStep)
    };
}

describe('💬 CONVERSATION FLOW (2 LADOS)', () => {
    
    describe('Cenário 1: Usuário responde corretamente', () => {
        
        it('Deve avançar de ask_period quando usuário manda período', () => {
            const estadoInicial = {
                triageStep: 'ask_period',
                qualificationData: {}
            };
            
            const mensagem = 'manhã';
            const resultado = simularDecisaoAmanda(estadoInicial, mensagem);
            
            expect(resultado.repetiuPergunta).toBe(false);
            expect(resultado.novoTriageStep).toBe('ask_profile');
            expect(resultado.dadosExtraidos.periodo).toBe('manha');
        });

        it('Deve detectar período mesmo com typo Dmanha e avançar', () => {
            const estadoInicial = {
                triageStep: 'ask_period',
                qualificationData: {}
            };
            
            const mensagem = 'Dmanha';
            const resultado = simularDecisaoAmanda(estadoInicial, mensagem);
            
            expect(resultado.repetiuPergunta).toBe(false);
            expect(resultado.novoTriageStep).toBe('ask_profile');
            expect(resultado.dadosExtraidos.periodo).toBe('manha');
        });

        it('Deve avançar de ask_profile quando usuário manda nome', () => {
            const estadoInicial = {
                triageStep: 'ask_profile',
                qualificationData: { periodo: 'manha' }
            };
            
            const mensagem = 'meu nome é João Silva';
            const resultado = simularDecisaoAmanda(estadoInicial, mensagem);
            
            expect(resultado.repetiuPergunta).toBe(false);
            expect(resultado.novoTriageStep).toBe('ask_complaint');
            expect(resultado.dadosExtraidos.nome).toBe('João Silva');
        });

        it('Deve extrair nome simples quando usuário só manda o nome', () => {
            const estadoInicial = {
                triageStep: 'ask_profile',
                qualificationData: {}
            };
            
            const mensagem = 'Ana Paula';
            const resultado = simularDecisaoAmanda(estadoInicial, mensagem);
            
            expect(resultado.novoTriageStep).toBe('ask_complaint');
            expect(resultado.dadosExtraidos.nome).toBe('Ana Paula');
        });
    });

    describe('Cenário 2: Conversa em múltiplas mensagens', () => {
        
        it('Fluxo completo: período → nome → queixa', () => {
            // Mensagem 1: Usuário responde período
            let estado = { triageStep: 'ask_period', qualificationData: {} };
            let resultado = simularDecisaoAmanda(estado, 'De tarde');
            
            expect(resultado.novoTriageStep).toBe('ask_profile');
            expect(resultado.dadosExtraidos.periodo).toBe('tarde');
            
            // Atualiza estado
            estado = { 
                triageStep: resultado.novoTriageStep, 
                qualificationData: resultado.dadosExtraidos 
            };
            
            // Mensagem 2: Usuário responde nome
            resultado = simularDecisaoAmanda(estado, 'Ana Maria');
            expect(resultado.novoTriageStep).toBe('ask_complaint');
            expect(resultado.dadosExtraidos.nome).toBe('Ana Maria');
            
            // Atualiza estado
            estado = { 
                triageStep: resultado.novoTriageStep, 
                qualificationData: resultado.dadosExtraidos 
            };
            
            // Mensagem 3: Usuário responde queixa
            resultado = simularDecisaoAmanda(estado, 'Ela tem dificuldade de fala');
            expect(resultado.novoTriageStep).toBe('done');
            expect(resultado.proximaPergunta).toBeNull();
        });
    });

    describe('Cenário 3: Múltiplas crianças', () => {
        
        it('Deve extrair primeira criança quando nome vem primeiro', () => {
            const estadoInicial = {
                triageStep: 'ask_profile',
                qualificationData: { periodo: 'tarde' }
            };
            
            // Quando usuário manda nome primeiro (como resposta direta)
            const mensagem = 'Maria Luísa 7 anos José neto 5 anos';
            const resultado = simularDecisaoAmanda(estadoInicial, mensagem);
            
            expect(resultado.dadosExtraidos.nome).toBe('Maria Luísa');
            expect(resultado.dadosExtraidos.idade).toBe(7);
            expect(resultado.novoTriageStep).toBe('ask_complaint');
        });
    });

    describe('Cenário 4: Respostas parciais - Amanda NÃO deve repetir', () => {
        
        it('Deve manter ask_period se usuário não disse período', () => {
            const estadoInicial = {
                triageStep: 'ask_period',
                qualificationData: {}
            };
            
            const mensagem = 'Oi, quero agendar'; // Sem período
            const resultado = simularDecisaoAmanda(estadoInicial, mensagem);
            
            expect(resultado.repetiuPergunta).toBe(true);
            expect(resultado.novoTriageStep).toBe('ask_period');
            expect(resultado.proximaPergunta).toBe('ask_period');
        });

        it('Deve manter ask_profile se usuário mandou mensagem sem nome', () => {
            const estadoInicial = {
                triageStep: 'ask_profile',
                qualificationData: { periodo: 'manha' }
            };
            
            const mensagem = 'Sim, quero agendar'; // Sem nome
            const resultado = simularDecisaoAmanda(estadoInicial, mensagem);
            
            expect(resultado.repetiuPergunta).toBe(true);
            expect(resultado.novoTriageStep).toBe('ask_profile');
            expect(resultado.proximaPergunta).toBe('ask_name');
        });

        it('BUG CRÍTICO: Se usuário manda "manhã. Meu filho é Pedro", Amanda deve pedir nome', () => {
            // Este teste documenta a limitação atual:
            // extractName não extrai nome quando vem depois do período na mesma mensagem
            const estadoInicial = {
                triageStep: 'ask_period',
                qualificationData: {}
            };
            
            const mensagem = 'manhã. Meu filho é Pedro Henrique 5 anos';
            const resultado = simularDecisaoAmanda(estadoInicial, mensagem);
            
            // Período é detectado
            expect(resultado.dadosExtraidos.periodo).toBe('manha');
            // Mas nome NÃO é extraído (limitação atual)
            expect(resultado.dadosExtraidos.nome).toBeUndefined();
            // Amanda deve perguntar o nome
            expect(resultado.novoTriageStep).toBe('ask_profile');
            expect(resultado.proximaPergunta).toBe('ask_name');
        });
    });

    describe('Cenário 5: Correção de dados', () => {
        
        it('Deve permitir usuário corrigir período', () => {
            let estado = { 
                triageStep: 'ask_profile', 
                qualificationData: { periodo: 'manha' } 
            };
            
            const resultado = simularDecisaoAmanda(estado, 'tarde');
            
            expect(resultado.dadosExtraidos.periodo).toBe('tarde');
        });

        it('Deve manter dados já coletados ao receber nova informação', () => {
            let estado = { 
                triageStep: 'ask_profile', 
                qualificationData: { periodo: 'manha' } 
            };
            
            // Usuário só manda o nome agora
            const resultado = simularDecisaoAmanda(estado, 'João Silva');
            
            expect(resultado.dadosExtraidos.periodo).toBe('manha'); // Mantido
            expect(resultado.dadosExtraidos.nome).toBe('João Silva'); // Novo
        });
    });
});

console.log('💬 Testes de fluxo de conversa carregados');
