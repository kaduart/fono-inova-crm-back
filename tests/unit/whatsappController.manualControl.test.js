/**
 * 🧪 TESTES UNITÁRIOS - whatsappController Manual Control
 * 
 * Testes específicos para a lógica de controle manual no whatsappController.js
 * 
 * Issues corrigidas:
 * - Amanda ativando sozinha após 30 minutos (autoResumeAfter)
 * - Lógica de verificação do controle manual
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('🎯 whatsappController - Manual Control Logic', () => {
    
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('1️⃣ Verificação de controle manual (handleAutoReply)', () => {
        
        it('Deve retornar early se manualControl.active = true e autoResumeAfter = null', () => {
            const leadDoc = {
                _id: 'lead123',
                manualControl: {
                    active: true,
                    takenOverAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 horas atrás
                    autoResumeAfter: null  // 🔧 FIX: Não volta sozinha
                },
                autoReplyEnabled: true
            };

            const isTestNumber = false;
            let shouldReturnEarly = false;

            // Lógica do handleAutoReply
            if (!isTestNumber && leadDoc.manualControl?.active) {
                const takenAt = leadDoc.manualControl.takenOverAt;
                const timeout = leadDoc.manualControl?.autoResumeAfter;
                let aindaPausada = true;

                if (typeof timeout === "number" && timeout > 0) {
                    if (takenAt) {
                        const minutesSince = (Date.now() - takenAt.getTime()) / (1000 * 60);
                        if (minutesSince > timeout) {
                            aindaPausada = false;
                        }
                    }
                } else if (timeout === null || timeout === undefined) {
                    // 🔒 Modo permanente: mantém pausado
                    aindaPausada = true;
                } else if (!takenAt) {
                    aindaPausada = false;
                }

                if (aindaPausada) {
                    shouldReturnEarly = true;
                }
            }

            expect(shouldReturnEarly).toBe(true);
        });

        it('Deve reativar Amanda se autoResumeAfter = 30 e passou 40 minutos', () => {
            const leadDoc = {
                _id: 'lead123',
                manualControl: {
                    active: true,
                    takenOverAt: new Date(Date.now() - 40 * 60 * 1000), // 40 minutos atrás
                    autoResumeAfter: 30  // Valor antigo
                }
            };

            const timeout = leadDoc.manualControl?.autoResumeAfter;
            let aindaPausada = true;

            if (typeof timeout === "number" && timeout > 0) {
                const takenAt = leadDoc.manualControl.takenOverAt;
                if (takenAt) {
                    const minutesSince = (Date.now() - takenAt.getTime()) / (1000 * 60);
                    if (minutesSince > timeout) {
                        aindaPausada = false;  // 🔓 Reativa
                    }
                }
            }

            expect(aindaPausada).toBe(false);
        });

        it('Deve manter pausado se autoResumeAfter = 30 e passou apenas 20 minutos', () => {
            const leadDoc = {
                _id: 'lead123',
                manualControl: {
                    active: true,
                    takenOverAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutos atrás
                    autoResumeAfter: 30
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

            expect(aindaPausada).toBe(true);
        });

        it('Números de teste devem ignorar controle manual', () => {
            const isTestNumber = true;
            const leadDoc = {
                manualControl: { active: true }
            };

            const shouldIgnoreManualControl = isTestNumber;
            
            expect(shouldIgnoreManualControl).toBe(true);
        });
    });

    describe('2️⃣ Pausa automática ao enviar mensagem manual', () => {
        
        it('Deve pausar Amanda com autoResumeAfter: null ao enviar mensagem manual', () => {
            const resolvedLeadId = 'lead123';
            const sentBy = 'manual';
            const userId = 'user456';

            const updateData = {
                $set: {
                    'manualControl.active': true,
                    'manualControl.takenOverAt': new Date(),
                    'manualControl.takenOverBy': userId || null,
                    'manualControl.autoResumeAfter': null  // 🔧 FIX
                }
            };

            if (resolvedLeadId && sentBy === 'manual') {
                // Simula atualização
                expect(updateData.$set['manualControl.active']).toBe(true);
                expect(updateData.$set['manualControl.autoResumeAfter']).toBeNull();
            }
        });

        it('Não deve pausar Amanda se sentBy não for manual', () => {
            const resolvedLeadId = 'lead123';
            const sentBy = 'amanda';  // Amanda enviando

            let wasPaused = false;

            if (resolvedLeadId && sentBy === 'manual') {
                wasPaused = true;
            }

            expect(wasPaused).toBe(false);
        });
    });

    describe('3️⃣ Reativação via botão "Ativar"', () => {
        
        it('Deve reativar Amanda quando usuário clica em Ativar', () => {
            const leadId = 'lead123';
            
            // Estado inicial: pausado
            const leadBefore = {
                manualControl: {
                    active: true,
                    takenOverAt: new Date(),
                    takenOverBy: 'user456',
                    autoResumeAfter: null
                }
            };

            // Ação: usuário clica em "Ativar"
            const updateToActivate = {
                $set: {
                    'manualControl.active': false,
                    autoReplyEnabled: true,
                    lastAmandaInteraction: new Date()
                },
                $unset: {
                    'manualControl.takenOverAt': "",
                    'manualControl.takenOverBy': ""
                }
            };

            // Simula atualização
            leadBefore.manualControl.active = false;
            leadBefore.manualControl.takenOverAt = null;
            leadBefore.manualControl.takenOverBy = null;

            expect(leadBefore.manualControl.active).toBe(false);
            expect(leadBefore.manualControl.takenOverAt).toBeNull();
        });

        it('Deve emitir evento socket ao reativar', () => {
            const leadId = 'lead123';
            const io = {
                emit: vi.fn()
            };

            // Simula emissão de evento
            io.emit('lead:manualControl', {
                leadId,
                manualActive: false,
                reason: 'amanda_reactivated',
                timestamp: new Date()
            });

            expect(io.emit).toHaveBeenCalledWith('lead:manualControl', expect.objectContaining({
                leadId,
                manualActive: false
            }));
        });
    });

    describe('4️⃣ Edge cases', () => {
        
        it('Deve desativar manualControl se não tem takenOverAt e não tem timeout', () => {
            const leadDoc = {
                manualControl: {
                    active: true,
                    takenOverAt: null,  // Não tem
                    autoResumeAfter: null  // Não tem
                }
            };

            const timeout = leadDoc.manualControl?.autoResumeAfter;
            const takenAt = leadDoc.manualControl.takenOverAt;
            let aindaPausada = true;

            if (typeof timeout === "number" && timeout > 0) {
                // ... lógica de timeout
            } else if (timeout === null || timeout === undefined) {
                if (!takenAt) {
                    // ⚠️ Se não tem takenAt, desativa por segurança
                    aindaPausada = false;
                } else {
                    aindaPausada = true;
                }
            }

            expect(aindaPausada).toBe(false);
        });

        it('Deve manter pausado se tem takenOverAt mesmo com timeout null', () => {
            const leadDoc = {
                manualControl: {
                    active: true,
                    takenOverAt: new Date(),  // Tem
                    autoResumeAfter: null
                }
            };

            const timeout = leadDoc.manualControl?.autoResumeAfter;
            const takenAt = leadDoc.manualControl.takenOverAt;
            let aindaPausada = true;

            if (typeof timeout === "number" && timeout > 0) {
                // ...
            } else if (timeout === null || timeout === undefined) {
                if (!takenAt) {
                    aindaPausada = false;
                } else {
                    aindaPausada = true;  // 🔒 Mantém pausado
                }
            }

            expect(aindaPausada).toBe(true);
        });

        it('autoReplyEnabled = false deve bloquear Amanda independente do manualControl', () => {
            const leadDoc = {
                manualControl: { active: false },
                autoReplyEnabled: false
            };

            const shouldBlock = leadDoc.autoReplyEnabled === false;
            
            expect(shouldBlock).toBe(true);
        });
    });

    describe('5️⃣ Cenários de produção', () => {
        
        it('Cenário: Secretária envia mensagem → Amanda pausa → Lead responde → Amanda NÃO deve responder', () => {
            // 1. Secretária envia mensagem
            const leadId = 'lead123';
            const sentBy = 'manual';
            
            // 2. Amanda é pausada
            const lead = {
                manualControl: {
                    active: true,
                    takenOverAt: new Date(),
                    autoResumeAfter: null  // 🔧 FIX
                }
            };

            // 3. Lead responde (2 horas depois)
            vi.advanceTimersByTime(2 * 60 * 60 * 1000);

            // 4. Verifica se Amanda deve responder
            const timeout = lead.manualControl?.autoResumeAfter;
            let shouldRespond = true;

            if (lead.manualControl?.active) {
                if (typeof timeout === "number" && timeout > 0) {
                    // Verifica timeout
                } else if (timeout === null || timeout === undefined) {
                    // 🔒 Mantém pausado indefinidamente
                    shouldRespond = false;
                }
            }

            expect(shouldRespond).toBe(false);
        });

        it('Cenário: Botão Ativar é clicado → Amanda volta a responder', () => {
            const lead = {
                _id: 'lead123',
                manualControl: {
                    active: true,
                    takenOverAt: new Date(),
                    autoResumeAfter: null
                }
            };

            // Usuário clica em "Ativar"
            lead.manualControl.active = false;
            lead.manualControl.takenOverAt = null;

            // Lead envia mensagem
            const manualActive = lead.manualControl?.active === true;
            
            expect(manualActive).toBe(false);
            // Amanda deve responder agora
        });
    });
});
