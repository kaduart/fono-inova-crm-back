/**
 * 🧪 TESTES - Entity-Driven Conversations
 * 
 * Simula diálogos naturais entre paciente e Amanda,
 * testando se ela interpreta corretamente e responde
 * de forma contextual (perguntando só o que falta).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks
const mockSafeLeadUpdate = vi.fn();
const mockFindAvailableSlots = vi.fn();

vi.mock('../../models/Leads.js', () => ({
    default: {
        findById: vi.fn(() => Promise.resolve({})),
        findByIdAndUpdate: mockSafeLeadUpdate
    }
}));

vi.mock('../../services/amandaBookingService.js', () => ({
    findAvailableSlots: mockFindAvailableSlots,
    formatDatePtBr: (d) => d,
    formatSlot: (s) => `${s.date} ${s.time}`
}));

// Importar as funções que vamos testar (simulando)
// Na prática, estas viriam do AmandaOrchestrator.js

/**
 * Simula o processamento completo da mensagem
 * Como se fosse a função processMessageCompletely
 */
function processMessageLikeAmanda(text, lead = {}) {
    const result = {
        extracted: {},
        missing: [],
        hasAll: false,
        response: null
    };
    
    // 1. Extrair todas as entidades
    const nameMatch = text.match(/(?:sou|me chamo|nome[\sé]+)\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?)/i);
    const ageMatch = text.match(/(\d+)\s*(anos?|meses?)/i);
    const periodMatch = text.match(/\b(manh[ãa]|tarde|noite)/i);

    // Detecta sujeito
    const isChild = /\b(minha filha|meu filho|minha criança|meu bebê|ela tem|ele tem)\b/i.test(text);
    const isSelf = /\b(eu tenho|eu sou|pra mim|atendimento pra mim)\b/i.test(text);

    // Extrai nome da criança (ex: "minha filha Ana", "meu filho João")
    // Captura o token após "minha filha/meu filho" e verifica se começa com maiúscula (nome próprio)
    const childNameMatch = text.match(/\bminha?\s+filh[ao]\s+([^\s,]+)/i);
    if (childNameMatch && /^[A-ZÀ-Ú]/.test(childNameMatch[1])) {
        result.extracted.patientName = childNameMatch[1];
    }

    // Extrai nome do responsável/paciente
    if (nameMatch) {
        if (isChild) {
            result.extracted.responsibleName = nameMatch[1];
        } else {
            result.extracted.patientName = nameMatch[1];
        }
    }
    
    // Extrai idade
    if (ageMatch) {
        result.extracted.age = parseInt(ageMatch[1]);
    }
    
    // Extrai período
    if (periodMatch) {
        result.extracted.period = periodMatch[1].toLowerCase().replace('ã', 'a');
    }
    
    // Extrai queixa/therapyArea
    if (/\b(não fala|fala pouco|atraso na fala|problema pra falar)\b/i.test(text)) {
        result.extracted.complaint = 'atraso de fala';
        result.extracted.therapyArea = 'fonoaudiologia';
    } else if (/\b(dificuldade de aprender|problema na escola|não consegue ler|dificuldade com leitura)\b/i.test(text)) {
        result.extracted.complaint = 'dificuldade escolar';
        result.extracted.therapyArea = 'psicopedagogia';
    } else if (/\b(comportamento|birra|não obedece|agressivo|hiperativo)\b/i.test(text)) {
        result.extracted.complaint = 'problemas de comportamento';
        result.extracted.therapyArea = 'psicologia';
    } else if (/\b(não anda|atraso motor|coordenação|equilíbrio)\b/i.test(text)) {
        result.extracted.complaint = 'atraso motor';
        result.extracted.therapyArea = 'fisioterapia';
    } else if (/\b(enurese|xixi na cama|micção)\b/i.test(text)) {
        result.extracted.complaint = 'enurese';
        result.extracted.therapyArea = 'fonoaudiologia';
    } else if (/\bfonoaudiologia\b/i.test(text)) {
        result.extracted.therapyArea = 'fonoaudiologia';
    }
    
    // 2. Merge com dados existentes do lead
    const hasTherapyArea = lead.therapyArea || result.extracted.therapyArea;
    const hasPeriod = lead.pendingPreferredPeriod || result.extracted.period;
    const hasPatientName = lead.patientInfo?.fullName || result.extracted.patientName;
    const hasResponsibleName = lead.responsibleName || result.extracted.responsibleName;
    const hasAge = lead.patientInfo?.age || result.extracted.age;
    const hasComplaint = lead.complaint || result.extracted.complaint;
    
    // 3. Determina o que falta
    if (!hasTherapyArea) result.missing.push('therapyArea');
    if (!hasPeriod) result.missing.push('period');
    // Quando é contexto de criança (isChild detectado ou lead já tem responsável),
    // precisamos do nome da criança (patientName) mesmo que o responsável já seja conhecido
    const needsPatientName = isChild || !!lead.responsibleName;
    if (!hasPatientName && (needsPatientName || !hasResponsibleName)) result.missing.push('name');
    if (!hasAge) result.missing.push('age');
    if (!hasComplaint) result.missing.push('complaint');
    
    result.hasAll = result.missing.length === 0;
    
    // 4. Gera resposta contextual
    result.response = buildAmandaResponse(result, lead);
    
    return result;
}

/**
 * Constrói resposta como a Amanda faria
 */
function buildAmandaResponse(processed, lead) {
    const { extracted, missing, hasAll } = processed;
    
    // Se tem tudo, oferece agendamento
    if (hasAll) {
        return '[OFERECER_SLOTS] Tenho esses horários disponíveis...';
    }
    
    // Pega o primeiro que falta
    const firstMissing = missing[0];
    
    // Contexto do que já sabemos
    const respName = extracted.responsibleName || lead.responsibleName;
    const patientName = extracted.patientName || lead.patientInfo?.fullName;
    const age = extracted.age || lead.patientInfo?.age;
    const therapyArea = extracted.therapyArea || lead.therapyArea;
    const period = extracted.period || lead.pendingPreferredPeriod;
    
    switch (firstMissing) {
        case 'therapyArea':
            return `Oi${respName ? ' ' + respName : ''}! Pra eu direcionar certinho, qual área terapêutica você precisa? Temos Fonoaudiologia, Psicologia, Terapia Ocupacional, Fisioterapia ou Neuropsicologia? 💚`;
            
        case 'period':
            if (respName && age && therapyArea) {
                return `Oi ${respName}! Entendi que seu filho(a) tem ${age} anos e precisa de ${therapyArea}. 💚\n\nPra eu organizar, prefere manhã ou tarde? 😊`;
            }
            if (respName) {
                return `Oi ${respName}! 💚 Pra eu organizar certinho, prefere manhã ou tarde? 😊`;
            }
            return `Olá! Pra eu organizar certinho, prefere manhã ou tarde? 😊`;
            
        case 'name':
            if (extracted.subject === 'child' || /minha filha|meu filho/i.test(lead.lastMessage || '')) {
                return `Oi${respName ? ' ' + respName : ''}! Entendi que é para seu filho(a). 💚 Qual o nome completo da criança?`;
            }
            return `Oi! Pra eu organizar, qual o nome completo do paciente? 😊`;
            
        case 'age':
            if (patientName) {
                return `Perfeito, ${patientName}! 💚 E qual a idade? (anos ou meses)`;
            }
            if (respName) {
                return `Obrigada, ${respName}! 💚 E qual a idade do paciente?`;
            }
            return `Qual a idade do paciente? (anos ou meses) 😊`;
            
        case 'complaint':
            if (patientName && age) {
                return `Entendi, ${patientName} tem ${age} anos. 💚 Me conta um pouquinho: o que vocês têm observado que motivou procurar ajuda?`;
            }
            return `Me conta um pouquinho: qual a principal preocupação ou queixa que vocês têm? 💚`;
            
        default:
            return `Pra eu organizar certinho, prefere manhã ou tarde? 😊`;
    }
}

describe('🗣️ Conversas Naturais - Entity Driven', () => {
    
    describe('Cenário 1: Paciente manda tudo de uma vez', () => {
        
        it('✅ Mensagem completa com todos os dados', () => {
            const lead = {};
            const text = "Oi, sou Maria. Minha filha tem 5 anos e não fala direito. Prefiro manhã.";
            
            const result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.extracted.age).toBe(5);
            expect(result.extracted.period).toBe('manha');
            expect(result.extracted.complaint).toBe('atraso de fala');
            expect(result.extracted.therapyArea).toBe('fonoaudiologia');
            expect(result.missing).toContain('name'); // Falta nome da criança
            expect(result.hasAll).toBe(false);
        });
        
        it('✅ Mensagem completa + nome da criança', () => {
            const lead = {};
            const text = "Oi sou Maria, minha filha Ana tem 5 anos, não fala direito, prefiro manhã";
            
            const result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.extracted.age).toBe(5);
            expect(result.extracted.period).toBe('manha');
            expect(result.extracted.complaint).toBe('atraso de fala');
            expect(result.extracted.therapyArea).toBe('fonoaudiologia');
            expect(result.missing).not.toContain('therapyArea');
            expect(result.missing).not.toContain('period');
            expect(result.missing).not.toContain('age');
            expect(result.hasAll).toBe(true); // Considerando que detectou Ana como paciente
        });
    });
    
    describe('Cenário 2: Paciente responde aos poucos (multi-turn)', () => {
        
        it('✅ Turno 1: Apenas nome e problema', () => {
            const lead = {};
            const text = "Oi, sou Maria. Minha filha tem problema pra falar.";
            
            const result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.extracted.complaint).toBe('atraso de fala');
            expect(result.extracted.therapyArea).toBe('fonoaudiologia');
            expect(result.missing).toContain('period');
            expect(result.missing).toContain('age');
            expect(result.missing).toContain('name');
            expect(result.response).toContain('manhã ou tarde');
        });
        
        it('✅ Turno 2: Paciente responde idade', () => {
            const lead = {
                responsibleName: 'Maria',
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso de fala'
            };
            const text = "Ela tem 4 anos";
            
            const result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.age).toBe(4);
            expect(result.missing).toContain('period');
            expect(result.missing).not.toContain('age');
        });
        
        it('✅ Turno 3: Paciente responde período', () => {
            const lead = {
                responsibleName: 'Maria',
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso de fala',
                patientInfo: { age: 4 }
            };
            const text = "Prefiro manhã";
            
            const result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.period).toBe('manha');
            expect(result.missing).toContain('name'); // Ainda falta nome da criança
        });
    });
    
    describe('Cenário 3: Paciente muda de assunto no meio', () => {
        
        it('✅ Pergunta sobre convênio durante triagem', () => {
            const lead = {
                responsibleName: 'Maria',
                therapyArea: 'fonoaudiologia',
                patientInfo: { age: 5 },
                complaint: 'atraso de fala'
                // Falta: period, patientName
            };
            const text = "Vocês atendem Unimed?";
            
            const result = processMessageLikeAmanda(text, lead);
            
            // Amanda deve detectar que é pergunta específica
            // Mas manter contexto da triagem
            expect(result.missing).toContain('period');
        });
        
        it('✅ Pergunta sobre preço durante triagem', () => {
            const lead = {
                responsibleName: 'Ana',
                patientInfo: { age: 3 }
                // Falta: therapyArea, period, complaint
            };
            const text = "Quanto custa a avaliação?";
            
            const result = processMessageLikeAmanda(text, lead);
            
            // Deve responder preço mas lembrar que falta dados
            expect(result.missing).toContain('therapyArea');
        });
    });
    
    describe('Cenário 4: Mensagens fora de ordem', () => {
        
        it('✅ Período primeiro, depois dados', () => {
            const lead = {};
            const text = "Quero de manhã";
            
            const result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.period).toBe('manha');
            expect(result.missing).toContain('therapyArea');
            expect(result.missing).toContain('name');
            expect(result.missing).toContain('age');
        });
        
        it('✅ Queixa detalhada sem dados organizados', () => {
            const lead = {};
            const text = "Olha, eu tô preocupada porque minha filha já tem 6 anos e ela ainda não consegue ler direito, as letras embaralham tudo sabe? A professora falou que pode ser dislexia";
            
            const result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.complaint).toBe('dificuldade escolar');
            expect(result.extracted.therapyArea).toBe('psicopedagogia');
            expect(result.extracted.age).toBe(6);
            expect(result.missing).toContain('period');
            expect(result.missing).toContain('name');
        });
    });
    
    describe('Cenário 5: Adulto para si mesmo', () => {
        
        it('✅ Paciente adulto buscando atendimento', () => {
            const lead = {};
            const text = "Oi, sou João. Eu tenho 35 anos e preciso de fonoaudiologia para minha voz. Prefiro tarde.";
            
            const result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.patientName).toBe('João');
            expect(result.extracted.age).toBe(35);
            expect(result.extracted.period).toBe('tarde');
            expect(result.extracted.therapyArea).toBe('fonoaudiologia');
            expect(result.extracted.responsibleName).toBeUndefined();
        });
    });
    
    describe('Cenário 6: Respostas contextuais da Amanda', () => {
        
        it('✅ Resposta reconhece dados já informados', () => {
            const lead = {};
            const text = "Oi sou Maria, minha filha tem 4 anos e não fala direito";
            
            const result = processMessageLikeAmanda(text, lead);
            
            // Amanda deve reconhecer na resposta
            expect(result.response).toContain('Maria');
            expect(result.response).toContain('4 anos');
            expect(result.response).toContain('manhã ou tarde');
        });
        
        it('✅ Resposta não repete pergunta já respondida', () => {
            const lead = {
                responsibleName: 'Maria',
                patientInfo: { age: 5 },
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso de fala',
                pendingPreferredPeriod: 'manha'
            };
            const text = "Ok";
            
            const result = processMessageLikeAmanda(text, lead);
            
            // Não deve perguntar período de novo
            expect(result.response).not.toContain('manhã ou tarde');
            expect(result.response).toContain('nome');
        });
    });
    
    describe('Cenário 7: Diferentes tipos de queixas', () => {
        
        it('✅ Detecta fonoaudiologia - atraso de fala', () => {
            const text = "Meu filho tem 3 anos e não fala";
            const result = processMessageLikeAmanda(text, {});
            expect(result.extracted.therapyArea).toBe('fonoaudiologia');
        });
        
        it('✅ Detecta psicologia - comportamento', () => {
            const text = "Minha filha tem birra demais, não obedece";
            const result = processMessageLikeAmanda(text, {});
            expect(result.extracted.therapyArea).toBe('psicologia');
        });
        
        it('✅ Detecta fisioterapia - motor', () => {
            const text = "Meu bebê tem 1 ano e ainda não anda";
            const result = processMessageLikeAmanda(text, {});
            expect(result.extracted.therapyArea).toBe('fisioterapia');
        });
        
        it('✅ Detecta psicopedagogia - escolar', () => {
            const text = "Não consegue ler, tem dificuldade na escola";
            const result = processMessageLikeAmanda(text, {});
            expect(result.extracted.therapyArea).toBe('psicopedagogia');
        });
    });
    
    describe('Cenário 8: Fluxo completo até agendamento', () => {
        
        it('✅ Fluxo completo simulado', () => {
            // Turno 1: Primeira mensagem
            let lead = {};
            let text = "Oi, sou Maria. Minha filha Ana tem 5 anos e não fala direito. Prefiro manhã.";
            let result = processMessageLikeAmanda(text, lead);
            
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.extracted.patientName).toBe('Ana');
            expect(result.extracted.age).toBe(5);
            expect(result.extracted.period).toBe('manha');
            expect(result.extracted.therapyArea).toBe('fonoaudiologia');
            expect(result.hasAll).toBe(true);
            expect(result.response).toContain('[OFERECER_SLOTS]');
        });
    });
});

console.log('🧪 Testes de conversas entity-driven carregados');
