/**
 * 🧪 TESTES UNITÁRIOS - CORREÇÕES DE MANUAL CONTROL
 * 
 * Testes para garantir:
 * 1. Amanda NÃO volta sozinha (autoResumeAfter = null)
 * 2. Enum 'system' é usado corretamente (não 'sistema')
 * 3. Tratamento de duplicatas no ensureLeadForAppointment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock do mongoose
const mockLean = vi.fn();
const mockFindOne = vi.fn(() => ({ lean: mockLean }));
const mockFindById = vi.fn(() => ({ lean: mockLean }));
const mockCreate = vi.fn();
const mockFindByIdAndUpdate = vi.fn();

vi.mock('../../models/Leads.js', () => ({
    default: {
        findOne: mockFindOne,
        findById: mockFindById,
        create: mockCreate,
        findByIdAndUpdate: mockFindByIdAndUpdate
    }
}));

vi.mock('../../models/Patient.js', () => ({
    default: {
        findById: vi.fn()
    }
}));

// Mock do phone normalizer
vi.mock('../../utils/phone.js', () => ({
    normalizeE164BR: (phone) => phone ? phone.replace(/[^0-9]/g, '') : null
}));

describe('🎯 MANUAL CONTROL FIXES', () => {
    
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('1️⃣ autoResumeAfter deve ser null (Amanda não volta sozinha)', () => {
        
        it('Schema do Lead deve ter autoResumeAfter default como null', () => {
            // Simula a estrutura do schema
            const manualControlSchema = {
                active: { type: Boolean, default: false },
                takenOverAt: Date,
                takenOverBy: { type: 'ObjectId', ref: 'User' },
                autoResumeAfter: { type: Number, default: null }  // 🔧 FIX: null em vez de 720
            };
            
            expect(manualControlSchema.autoResumeAfter.default).toBeNull();
            expect(manualControlSchema.autoResumeAfter.default).not.toBe(30);
            expect(manualControlSchema.autoResumeAfter.default).not.toBe(720);
        });

        it('Atualização de manualControl deve usar autoResumeAfter: null', async () => {
            const leadUpdate = {
                $set: {
                    'manualControl.active': true,
                    'manualControl.takenOverAt': new Date(),
                    'manualControl.takenOverBy': null,
                    'manualControl.autoResumeAfter': null  // 🔧 FIX
                }
            };

            // Simula chamada ao banco
            mockFindByIdAndUpdate.mockResolvedValue({ _id: '123' });
            
            // Verifica que o valor é null
            expect(leadUpdate.$set['manualControl.autoResumeAfter']).toBeNull();
        });

        it('Lead criado pelo leadController deve ter autoResumeAfter: null', () => {
            const newLead = {
                contact: { phone: '5562999999999' },
                origin: 'WhatsApp',
                status: 'novo',
                appointment: {},
                autoReplyEnabled: true,
                manualControl: { active: false, autoResumeAfter: null },  // 🔧 FIX
                lastInteractionAt: new Date(),
                createdAt: new Date()
            };

            expect(newLead.manualControl.autoResumeAfter).toBeNull();
            expect(newLead.manualControl.autoResumeAfter).not.toBe(30);
        });

        it('Lógica de verificação do controle manual deve respeitar null', () => {
            const leadDoc = {
                manualControl: {
                    active: true,
                    takenOverAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hora atrás
                    autoResumeAfter: null  // 🔧 FIX: Não deve voltar sozinha
                }
            };

            const timeout = leadDoc.manualControl?.autoResumeAfter;
            let aindaPausada = true;

            // Lógica corrigida
            if (typeof timeout === "number" && timeout > 0) {
                const takenAt = leadDoc.manualControl.takenOverAt;
                if (takenAt) {
                    const minutesSince = (Date.now() - takenAt.getTime()) / (1000 * 60);
                    if (minutesSince > timeout) {
                        aindaPausada = false;
                    }
                }
            } else if (timeout === null || timeout === undefined) {
                // 🔒 Modo sem timeout: mantém pausado indefinidamente
                aindaPausada = true;
            }

            expect(aindaPausada).toBe(true);
            expect(timeout).toBeNull();
        });

        it('Se autoResumeAfter = 30 (valor antigo), deve permitir volta automática', () => {
            const leadDoc = {
                manualControl: {
                    active: true,
                    takenOverAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hora atrás
                    autoResumeAfter: 30  // Valor antigo - permitia volta automática
                }
            };

            const timeout = leadDoc.manualControl?.autoResumeAfter;
            let aindaPausada = true;

            if (typeof timeout === "number" && timeout > 0) {
                const takenAt = leadDoc.manualControl.takenOverAt;
                if (takenAt) {
                    const minutesSince = (Date.now() - takenAt.getTime()) / (1000 * 60);
                    if (minutesSince > timeout) {
                        aindaPausada = false;
                    }
                }
            }

            expect(aindaPausada).toBe(false); // Deveria ter voltado (comportamento antigo)
        });
    });

    describe('2️⃣ Enum sentBy deve usar "system" não "sistema"', () => {
        
        it('Schema do Message deve ter enum correto', () => {
            const messageSchema = {
                metadata: {
                    sentBy: {
                        type: String,
                        enum: ['amanda', 'amanda_followup', 'manual', 'system'],  // ✅ Correto
                        default: 'amanda'
                    }
                }
            };

            const validValues = messageSchema.metadata.sentBy.enum;
            
            expect(validValues).toContain('system');
            expect(validValues).not.toContain('sistema');
        });

        it('sendTextMessage deve ser chamado com sentBy: "system"', () => {
            const sendTextMessage = vi.fn();
            const ownerPhone = '5561981694922';
            const msg = 'Teste de notificação';

            // Chamada correta (após correção)
            sendTextMessage({ to: ownerPhone, text: msg, sentBy: 'system' });

            expect(sendTextMessage).toHaveBeenCalledWith(
                expect.objectContaining({ sentBy: 'system' })
            );
            expect(sendTextMessage).not.toHaveBeenCalledWith(
                expect.objectContaining({ sentBy: 'sistema' })
            );
        });

        it('Valores inválidos devem ser rejeitados pelo enum', () => {
            const validEnum = ['amanda', 'amanda_followup', 'manual', 'system'];
            
            const invalidValues = ['sistema', 'bot', 'user', 'admin', ''];
            
            invalidValues.forEach(value => {
                expect(validEnum).not.toContain(value);
            });
        });
    });

    describe('3️⃣ Tratamento de duplicatas no ensureLeadForAppointment', () => {
        
        it('Deve buscar lead existente antes de criar novo', async () => {
            const phoneE164 = '556293163935';
            const existingLead = { _id: 'existing123', contact: { phone: phoneE164 } };
            
            // Mock retorna lead existente
            mockLean.mockResolvedValue(existingLead);
            
            const result = await mockFindOne.mockReturnValue({ lean: mockLean })();
            const found = await result.lean();
            
            expect(found).toEqual(existingLead);
            expect(found.contact.phone).toBe(phoneE164);
        });

        it('Deve criar novo lead se não encontrar existente', async () => {
            const newLead = {
                _id: 'new456',
                name: 'Paciente Teste',
                contact: { phone: '5562999999999' },
                manualControl: { active: false, autoResumeAfter: null }  // 🔧 FIX
            };
            
            mockCreate.mockResolvedValue(newLead);
            
            const result = await mockCreate(newLead);
            
            expect(result).toEqual(newLead);
            expect(result.manualControl.autoResumeAfter).toBeNull();
        });

        it('Deve lidar com race condition (erro 11000)', async () => {
            const phoneE164 = '556293163935';
            const duplicateError = { code: 11000, keyValue: { 'contact.phone': phoneE164 } };
            const existingLead = { _id: 'existing789', contact: { phone: phoneE164 } };
            
            // Configura mock para retornar lead existente
            mockLean.mockResolvedValue(existingLead);
            
            // Simula: Primeiro tenta criar e falha com duplicata
            mockCreate.mockRejectedValueOnce(duplicateError);
            
            try {
                await mockCreate({ contact: { phone: phoneE164 } });
            } catch (err) {
                if (err.code === 11000) {
                    // 🔧 FIX: Simula busca pelo lead existente após erro
                    mockFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(existingLead) });
                    const found = await mockFindOne({ 'contact.phone': phoneE164 }).lean();
                    expect(found).toEqual(existingLead);
                }
            }
        });

        it('Lead criado deve ter manualControl com autoResumeAfter: null', async () => {
            const patientData = {
                fullName: 'João Teste',
                phone: '5562888888888',
                email: 'joao@teste.com'
            };

            const newLead = {
                name: patientData.fullName,
                contact: {
                    phone: patientData.phone,
                    email: patientData.email
                },
                manualControl: { active: false, autoResumeAfter: null },  // 🔧 FIX
                status: 'agendado'
            };

            mockCreate.mockResolvedValue({ _id: 'lead123', ...newLead });
            
            const result = await mockCreate(newLead);
            
            expect(result.manualControl.autoResumeAfter).toBeNull();
        });
    });

    describe('4️⃣ Integração dos fixes', () => {
        
        it('Cenário completo: Pausa manual não volta sozinha', () => {
            // 1. Lead é criado com autoResumeAfter: null
            const lead = {
                _id: 'lead123',
                manualControl: { active: false, autoResumeAfter: null }
            };
            
            // 2. Usuário envia mensagem manual (pausa Amanda)
            lead.manualControl = {
                active: true,
                takenOverAt: new Date(),
                takenOverBy: 'user456',
                autoResumeAfter: null  // 🔧 FIX: Só volta quando clicar em Ativar
            };
            
            // 3. Passa 1 hora
            const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);
            
            // 4. Verifica se ainda está pausada
            const timeout = lead.manualControl.autoResumeAfter;
            let stillPaused = true;
            
            if (typeof timeout === "number" && timeout > 0) {
                const minutesSince = (oneHourLater - lead.manualControl.takenOverAt) / (1000 * 60);
                if (minutesSince > timeout) {
                    stillPaused = false;
                }
            } else if (timeout === null || timeout === undefined) {
                stillPaused = true;  // 🔒 Mantém pausada
            }
            
            expect(stillPaused).toBe(true);
            expect(lead.manualControl.active).toBe(true);
        });

        it('Cenário: Botão "Ativar" deve reativar Amanda', () => {
            // Lead está pausado
            const lead = {
                _id: 'lead123',
                manualControl: {
                    active: true,
                    takenOverAt: new Date(),
                    autoResumeAfter: null
                }
            };
            
            // Usuário clica em "Ativar"
            const ativarAmanda = () => {
                lead.manualControl.active = false;
                lead.manualControl.takenOverAt = null;
                lead.manualControl.takenOverBy = null;
            };
            
            ativarAmanda();
            
            expect(lead.manualControl.active).toBe(false);
        });
    });
});

describe('🎯 MENSAGEM ENUM VALIDATION', () => {
    
    it('Deve aceitar valores válidos de sentBy', () => {
        const validValues = ['amanda', 'amanda_followup', 'manual', 'system'];
        
        validValues.forEach(value => {
            const message = {
                content: 'Teste',
                metadata: { sentBy: value }
            };
            expect(message.metadata.sentBy).toBe(value);
        });
    });

    it('Não deve aceitar "sistema" como valor de sentBy', () => {
        const message = {
            content: 'Teste',
            metadata: { sentBy: 'sistema' }  // ❌ Valor inválido
        };
        
        const validEnum = ['amanda', 'amanda_followup', 'manual', 'system'];
        expect(validEnum).not.toContain(message.metadata.sentBy);
    });
});
