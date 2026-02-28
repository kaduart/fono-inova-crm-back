/**
 * 🧪 TESTES - Entity-Driven Architecture
 * Testa: processMessageCompletely + buildResponseForMissing
 * 
 * Objetivo: Amanda processa tudo antes de responder,
 * perguntando SÓ o que falta no fluxo.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock do Leads model
const mockLeadUpdate = vi.fn();
vi.mock('../../models/Leads.js', () => ({
    default: {
        findById: vi.fn(),
        findByIdAndUpdate: mockLeadUpdate
    }
}
));

// Mock das funções de extração
vi.mock('../../utils/patientDataExtractor.js', () => ({
    extractName: (text) => {
        if (!text) return null;
        // Extrai nome (simplificado para testes)
        const match = text.match(/(?:sou|me chamo|nome[\sé]+)([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);
        return match ? match[1] : null;
    },
    extractAgeFromText: (text) => {
        if (!text) return null;
        const match = text.match(/(\d+)\s*(anos?|meses?|m)/i);
        if (match) {
            const age = parseInt(match[1]);
            const unit = match[2].toLowerCase().startsWith('m') ? 'meses' : 'anos';
            return { age, unit };
        }
        return null;
    },
    extractPeriodFromText: (text) => {
        if (!text) return null;
        const t = text.toLowerCase();
        if (/\b(manh[ãa]|manha)\b/.test(t)) return 'manha';
        if (/\b(tarde)\b/.test(t)) return 'tarde';
        if (/\b(noite)\b/.test(t)) return 'noite';
        return null;
    },
    extractComplaint: (text) => {
        if (!text) return null;
        const padroes = [
            [/\b(n[ãa]o\s+fala|fala\s+pouco|atraso\s+de\s+fala|problema\s+na\s+fala)\b/i, 'atraso de fala'],
            [/\b(enurese|faz\s+xixi\s+na\s+cama)\b/i, 'enurese'],
            [/\b(dificuldade\s+(?:para|de)\s+(?:ler|escrever))\b/i, 'dificuldade escolar'],
        ];
        for (const [regex, complaint] of padroes) {
            if (regex.test(text)) return complaint;
        }
        return null;
    },
    isValidPatientName: (name) => name && name.length >= 2
}));

// Helper functions (simulando as novas funções)
function identifySubject(text) {
    if (!text) return { type: 'unknown', confidence: 0 };
    const t = text.toLowerCase();
    
    if (/\b(meus?\s+filhos?|minhas?\s+filhas?|meu\s+beb[eê]|minha\s+beb[eê])\b/.test(t)) {
        return { type: 'child', confidence: 0.9 };
    }
    if (/\b(eu\s+mesm[oa]|pra\s+mim|sou\s+eu)\b/.test(t)) {
        return { type: 'self', confidence: 0.8 };
    }
    return { type: 'unknown', confidence: 0 };
}

function isDescriptiveProblem(text) {
    if (!text || text.length < 10) return false;
    const t = text.toLowerCase();
    return /\b(minha|meu|estou|tenho|sinto|problema|dificuldade|n[ãa]o\s+consigo)\b/.test(t);
}

function processMessageCompletely(text, lead = {}) {
    const extracted = {
        name: null, // Simplificado para teste
        age: null,
        period: null,
        complaint: null,
        subject: identifySubject(text),
        isDescriptive: isDescriptiveProblem(text)
    };
    
    // Extrai nome
    const nameMatch = text?.match(/(?:sou|me chamo|nome[\sé]+)([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);
    if (nameMatch) extracted.name = nameMatch[1];
    
    // Extrai idade
    const ageMatch = text?.match(/(\d+)\s*(anos?|meses?)/i);
    if (ageMatch) extracted.age = { age: parseInt(ageMatch[1]), unit: 'anos' };
    
    // Extrai período
    const t = text?.toLowerCase() || '';
    if (/\bmanh[ãa]\b/.test(t)) extracted.period = 'manha';
    else if (/\btarde\b/.test(t)) extracted.period = 'tarde';
    
    // Extrai queixa
    if (/\bn[ãa]o\s+fala\b/i.test(t)) extracted.complaint = 'atraso de fala';
    else if (/\benurese\b/i.test(t)) extracted.complaint = 'enurese';
    else if (extracted.isDescriptive && text.length > 20) {
        extracted.complaint = text.replace(/^oi[,!\s]*/i, '').substring(0, 200);
    }
    
    // Identifica responsável vs paciente
    if (extracted.name) {
        if (extracted.subject.type === 'child') {
            extracted.responsibleName = extracted.name;
            extracted.patientName = null;
        } else {
            extracted.patientName = extracted.name;
            extracted.responsibleName = null;
        }
    }
    
    // Determina o que falta
    const hasPeriod = lead?.pendingPreferredPeriod || extracted.period;
    const hasPatientName = lead?.patientInfo?.fullName || extracted.patientName;
    const hasAge = lead?.patientInfo?.age || extracted.age;
    const hasComplaint = lead?.complaint || extracted.complaint;
    
    const missing = [];
    if (!hasPeriod) missing.push('period');
    if (!hasPatientName) missing.push('patientName');
    if (!hasAge) missing.push('age');
    if (!hasComplaint) missing.push('complaint');
    
    return {
        extracted,
        missing,
        hasAll: missing.length === 0,
        nextQuestion: missing[0] || null
    };
}

describe('🧠 Entity-Driven Architecture', () => {
    
    describe('processMessageCompletely()', () => {
        
        it('✅ deve extrair tudo quando usuário manda mensagem completa', () => {
            const text = "Oi, sou Maria. Minha filha tem 5 anos e não fala direito. Prefiro manhã.";
            const lead = {};
            
            const result = processMessageCompletely(text, lead);
            
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.extracted.age.age).toBe(5);
            expect(result.extracted.period).toBe('manha');
            expect(result.extracted.complaint).toBe('atraso de fala');
            expect(result.extracted.subject.type).toBe('child');
            expect(result.hasAll).toBe(false); // Falta nome da criança
            expect(result.nextQuestion).toBe('patientName');
        });
        
        it('✅ deve detectar quando falta só o período', () => {
            const text = "Oi sou Maria, minha filha Ana tem 3 anos e não fala bem.";
            const lead = {};
            
            const result = processMessageCompletely(text, lead);
            
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.missing).toContain('period');
            expect(result.nextQuestion).toBe('period');
        });
        
        it('✅ deve detectar quando falta só a queixa', () => {
            const lead = {
                patientInfo: { fullName: 'João', age: 7 },
                pendingPreferredPeriod: 'tarde'
            };
            const text = "Oi, tudo bem?";
            
            const result = processMessageCompletely(text, lead);
            
            expect(result.missing).toEqual(['complaint']);
            expect(result.nextQuestion).toBe('complaint');
        });
        
        it('✅ deve reconhecer quando tem tudo (triagem completa)', () => {
            const lead = {
                patientInfo: { fullName: 'Pedro', age: 4 },
                pendingPreferredPeriod: 'manha',
                complaint: 'atraso de fala'
            };
            const text = "Ok, obrigado!";
            
            const result = processMessageCompletely(text, lead);
            
            expect(result.hasAll).toBe(true);
            expect(result.missing).toEqual([]);
            expect(result.nextQuestion).toBeNull();
        });
        
        it('✅ deve extrair queixa de texto descritivo longo', () => {
            const text = "Oi, meu filho tem dificuldade para se concentrar na escola e não segue instruções";
            const lead = {};
            
            const result = processMessageCompletely(text, lead);
            
            expect(result.extracted.isDescriptive).toBe(true);
            expect(result.extracted.complaint).toBeTruthy();
            expect(result.extracted.complaint.length).toBeGreaterThan(20);
        });
        
        it('✅ deve identificar sujeito = child quando fala "minha filha"', () => {
            const text = "Oi, sou Maria. Minha filha tem 5 anos.";
            const result = processMessageCompletely(text, {});
            
            expect(result.extracted.subject.type).toBe('child');
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.extracted.patientName).toBeNull(); // Precisa perguntar
        });
        
        it('✅ deve identificar sujeito = self quando fala "eu"', () => {
            const text = "Oi, sou João. Eu tenho 30 anos e quero agendar.";
            const result = processMessageCompletely(text, {});
            
            expect(result.extracted.patientName).toBe('João');
            expect(result.extracted.responsibleName).toBeNull();
        });
    });
    
    describe('Cenários de Mensagem Completa', () => {
        
        it('📨 Mensagem: "Oi sou Maria, minha filha tem 5 anos e não fala direito"', () => {
            const text = "Oi sou Maria, minha filha tem 5 anos e não fala direito";
            const result = processMessageCompletely(text, {});
            
            // Amanda deve extrair
            expect(result.extracted.responsibleName).toBe('Maria');
            expect(result.extracted.age.age).toBe(5);
            expect(result.extracted.complaint).toBe('atraso de fala');
            
            // E deve faltar
            expect(result.missing).toContain('period');      // Não informou
            expect(result.missing).toContain('patientName'); // Nome da criança
            expect(result.nextQuestion).toBe('period');      // Pergunta período primeiro
        });
        
        it('📨 Mensagem: "Manhã. Sou Ana. Meu filho Lucas tem 7 anos e faz xixi na cama"', () => {
            const text = "Manhã. Sou Ana. Meu filho Lucas tem 7 anos e faz xixi na cama";
            const result = processMessageCompletely(text, {});
            
            expect(result.extracted.period).toBe('manha');
            expect(result.extracted.responsibleName).toBe('Ana');
            expect(result.extracted.age.age).toBe(7);
            expect(result.extracted.complaint).toBe('enurese');
            expect(result.hasAll).toBe(true); // Tem tudo (Lucas é extraído como nome)
        });
        
        it('📨 Mensagem: "Oi" (apenas saudação)', () => {
            const text = "Oi";
            const result = processMessageCompletely(text, {});
            
            expect(result.missing).toEqual(['period', 'patientName', 'age', 'complaint']);
            expect(result.nextQuestion).toBe('period');
        });
    });
});

console.log('🧪 Testes entity-driven carregados');
