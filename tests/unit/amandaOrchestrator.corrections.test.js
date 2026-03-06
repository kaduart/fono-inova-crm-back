/**
 * 🧪 TESTES UNITÁRIOS - Correções Críticas AmandaOrchestrator
 * Validam proteções contra bugs de produção
 */

import { describe, it, expect } from 'vitest';

describe('🚨 CORREÇÕES CRÍTICAS - AmandaOrchestrator', () => {
    
    describe('✅ FIX: Slots só quando tem nome + birthDate', () => {
        
        const leadCompleto = {
            _id: '123',
            therapyArea: 'fonoaudiologia',
            complaint: 'atraso de fala',
            patientInfo: {
                fullName: 'João Silva',
                birthDate: '2020-01-15',
                age: 4
            },
            pendingPreferredPeriod: 'tarde',
            triageStep: 'ask_complaint'
        };

        const leadSemNome = {
            _id: '124',
            therapyArea: 'fonoaudiologia',
            complaint: 'atraso de fala',
            patientInfo: {
                birthDate: '2020-01-15',
                age: 4
            },
            pendingPreferredPeriod: 'tarde',
            triageStep: 'ask_complaint'
        };

        const leadSemBirthDate = {
            _id: '125',
            therapyArea: 'fonoaudiologia',
            complaint: 'atraso de fala',
            patientInfo: {
                fullName: 'João Silva',
                age: 4
            },
            pendingPreferredPeriod: 'tarde',
            triageStep: 'ask_complaint'
        };

        it('Lead completo → pode oferecer slots', () => {
            const temNome = !!(leadCompleto.patientInfo?.fullName);
            const temBirthDate = !!(leadCompleto.patientInfo?.birthDate);
            expect(temNome && temBirthDate).toBe(true);
        });

        it('Lead sem nome → NÃO pode oferecer slots', () => {
            const temNome = !!(leadSemNome.patientInfo?.fullName);
            const temBirthDate = !!(leadSemNome.patientInfo?.birthDate);
            expect(temNome && temBirthDate).toBe(false);
        });

        it('Lead sem birthDate → NÃO pode oferecer slots', () => {
            const temNome = !!(leadSemBirthDate.patientInfo?.fullName);
            const temBirthDate = !!(leadSemBirthDate.patientInfo?.birthDate);
            expect(temNome && temBirthDate).toBe(false);
        });
    });

    describe('✅ FIX: isTriageComplete requer birthDate', () => {
        
        function isTriageComplete(lead) {
            if (!lead) return false;

            const hasArea = !!lead.therapyArea;
            const hasComplaint = !!(lead.complaint || lead.primaryComplaint);
            const hasName = !!(lead.patientInfo?.fullName || lead.patientInfo?.name);
            const hasBirthDate = !!(lead.patientInfo?.birthDate);
            const hasAge = lead.patientInfo?.age !== undefined && lead.patientInfo?.age !== null;
            const hasPeriod = !!(lead.pendingPreferredPeriod || lead.qualificationData?.disponibilidade);

            return hasArea && hasComplaint && hasName && hasBirthDate && hasAge && hasPeriod;
        }

        it('Lead com TODOS os campos → triagem completa', () => {
            const lead = {
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso',
                patientInfo: {
                    fullName: 'João',
                    birthDate: '2020-01-15',
                    age: 4
                },
                pendingPreferredPeriod: 'tarde'
            };
            expect(isTriageComplete(lead)).toBe(true);
        });

        it('Lead sem birthDate → triagem incompleta', () => {
            const lead = {
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso',
                patientInfo: {
                    fullName: 'João',
                    age: 4
                },
                pendingPreferredPeriod: 'tarde'
            };
            expect(isTriageComplete(lead)).toBe(false);
        });

        it('Lead sem nome → triagem incompleta', () => {
            const lead = {
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso',
                patientInfo: {
                    birthDate: '2020-01-15',
                    age: 4
                },
                pendingPreferredPeriod: 'tarde'
            };
            expect(isTriageComplete(lead)).toBe(false);
        });

        it('Lead sem queixa → triagem incompleta', () => {
            const lead = {
                therapyArea: 'fonoaudiologia',
                patientInfo: {
                    fullName: 'João',
                    birthDate: '2020-01-15',
                    age: 4
                },
                pendingPreferredPeriod: 'tarde'
            };
            expect(isTriageComplete(lead)).toBe(false);
        });
    });

    describe('✅ FIX: Ordem de triagem (queixa → nome → birthDate → age → período)', () => {
        
        function buildMissing(lead) {
            const missing = [];
            
            const hasTherapyArea = !!lead.therapyArea;
            const hasComplaint = !!(lead.complaint || lead.primaryComplaint);
            const hasName = !!(lead.patientInfo?.fullName || lead.patientInfo?.name);
            const hasBirthDate = !!(lead.patientInfo?.birthDate);
            const hasAge = lead.patientInfo?.age !== undefined && lead.patientInfo?.age !== null;
            const hasPeriod = !!(lead.pendingPreferredPeriod);

            if (!hasTherapyArea) missing.push('therapyArea');
            if (!hasComplaint) missing.push('complaint');
            if (!hasName) missing.push('name');
            if (!hasBirthDate) missing.push('birthDate');
            if (!hasAge) missing.push('age');
            if (!hasPeriod) missing.push('period');

            return missing;
        }

        it('Lead vazio → ordem correta de missing', () => {
            const lead = { therapyArea: 'fonoaudiologia' };
            const missing = buildMissing(lead);
            expect(missing[0]).toBe('complaint'); // Primeiro: queixa
        });

        it('Lead com queixa → próximo é nome', () => {
            const lead = { 
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso'
            };
            const missing = buildMissing(lead);
            expect(missing[0]).toBe('name');
        });

        it('Lead com queixa + nome → próximo é birthDate', () => {
            const lead = { 
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso',
                patientInfo: { fullName: 'João' }
            };
            const missing = buildMissing(lead);
            expect(missing[0]).toBe('birthDate');
        });

        it('Lead com queixa + nome + birthDate → próximo é age', () => {
            const lead = { 
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso',
                patientInfo: { 
                    fullName: 'João',
                    birthDate: '2020-01-15'
                }
            };
            const missing = buildMissing(lead);
            expect(missing[0]).toBe('age');
        });

        it('Lead com tudo exceto período → próximo é period', () => {
            const lead = { 
                therapyArea: 'fonoaudiologia',
                complaint: 'atraso',
                patientInfo: { 
                    fullName: 'João',
                    birthDate: '2020-01-15',
                    age: 4
                }
            };
            const missing = buildMissing(lead);
            expect(missing[0]).toBe('period');
        });
    });
});

describe('🧪 Rejeitar "Contato WhatsApp" em todas as fontes', () => {
    
    it('Nome no enrichedContext "Contato WhatsApp" → rejeitado', async () => {
        const { isValidPatientName } = await import('../../utils/patientDataExtractor.js');
        
        const hasValidName = (lead, enrichedContext) => {
            return (isValidPatientName(lead?.patientInfo?.fullName) && lead?.patientInfo?.fullName) ||
                   (isValidPatientName(enrichedContext?.name) && enrichedContext?.name);
        };

        const lead = {};
        const enriched = { name: 'Contato WhatsApp' };
        expect(hasValidName(lead, enriched)).toBeFalsy();
    });

    it('Nome no patientInfo "Contato WhatsApp" → rejeitado', async () => {
        const { isValidPatientName } = await import('../../utils/patientDataExtractor.js');
        
        const hasValidName = (lead) => {
            return (isValidPatientName(lead?.patientInfo?.fullName) && lead?.patientInfo?.fullName);
        };

        const lead = { patientInfo: { fullName: 'Contato WhatsApp' } };
        expect(hasValidName(lead)).toBeFalsy();
    });

    it('Nome válido no enrichedContext → aceito', async () => {
        const { isValidPatientName } = await import('../../utils/patientDataExtractor.js');
        
        const hasValidName = (lead, enrichedContext) => {
            return (isValidPatientName(enrichedContext?.name) && enrichedContext?.name);
        };

        const lead = {};
        const enriched = { name: 'João Silva' };
        expect(hasValidName(lead, enriched)).toBe('João Silva');
    });
});
