import Leads from '../models/Leads.js';
import {
    buildSlotOptions,
    formatSlot
} from '../services/amandaBookingService.js';
import {
    DYNAMIC_MODULES,
    getManual
} from '../utils/amandaPrompt.js';
import { detectAllFlags } from '../utils/flagsDetector.js';

class BookingHandler {
    async execute({ decisionContext, services }) {
        const { message, lead, memory, missing, booking, analysis } = decisionContext;
        const text = message?.text || '';

        // Re-detecta flags locais para nuances específicas de booking
        const flags = detectAllFlags(text, lead, {
            stage: lead.stage,
            messageCount: memory?.conversationHistory?.length || 0
        });

        // ==========================================
        // 0) SEM SLOTS DISPONÍVEIS (PRIORIDADE MÁXIMA)
        // ==========================================
        if (booking?.noSlotsAvailable || booking?.flow === 'no_slots') {
            const period = analysis?.extractedInfo?.preferredPeriod || memory?.preferredTime;

            await this.escalateToHuman(lead._id, memory, 'sem_vagas_disponiveis');

            return {
                needsAIGeneration: true,
                promptContext: DYNAMIC_MODULES.noSlotsAvailable(period),
                fallbackText: 'Nossa equipe vai entrar em contato ainda hoje com opções de horário 💚',
                extractedInfo: {
                    awaitingHumanContact: true,
                    reason: 'no_slots_available',
                    preferredPeriod: period || 'flexivel'
                }
            };
        }

        // ==========================================
        // 1) COLETA PROGRESSIVA (ORDEM ESTRITA)
        // ==========================================

        // 1.1 Especialidade/Terapia
        if (missing.needsTherapy) {
            return {
                text: getManual('especialidades', 'fono') ||
                    'Qual especialidade você está procurando? Temos Fono, Psicologia, Fisio e Terapia Ocupacional 💚'
            };
        }

        // 1.2 Queixa/Contexto clínico
        if (missing.needsComplaint) {
            return {
                needsAIGeneration: true,
                promptContext: DYNAMIC_MODULES.triageAskComplaint ||
                    'Para indicarmos o profissional ideal, me conta um pouquinho: o que está te preocupando? (fala, comportamento, aprendizagem...) 💚',
                fallbackText: 'Para indicarmos o profissional ideal, me conta um pouquinho: o que está te preocupando? 💚'
            };
        }

        // 1.3 Idade do paciente
        if (missing.needsAge) {
            const therapy = analysis?.extractedInfo?.therapyArea || memory?.therapyArea;

            return {
                needsAIGeneration: true,
                promptContext: DYNAMIC_MODULES.triageAskAge ?
                    DYNAMIC_MODULES.triageAskAge(therapy) :
                    'Qual a idade do paciente? (Isso ajuda a encontrarmos o melhor horário e profissional) 💚',
                fallbackText: 'Qual a idade do paciente? 💚'
            };
        }

        // 1.4 Período preferido
        if (missing.needsPeriod) {
            return {
                text: this.extractDynamicText(DYNAMIC_MODULES.triageAskPeriod) ||
                    'Você tem preferência por algum período? Manhã ou tarde funcionam melhor pra você? 💚'
            };
        }

        // ==========================================
        // 2) APRESENTAR SLOTS (QUANDO TUDO PRONTO)
        // ==========================================
        if (missing.needsSlot && booking?.slots?.primary) {
            const options = buildSlotOptions(booking.slots);

            if (!options.length) {
                // Slots vieram vazios por algum motivo, escala
                await this.escalateToHuman(lead._id, memory, 'slots_vazios_inesperado');
                return {
                    text: 'Estou com dificuldade para buscar os horários no momento. Vou pedir para nossa equipe te retornar rapidinho 💚'
                };
            }

            const optionsText = options.map(o => o.text).join('\n');

            // Persiste os slots oferecidos no lead
            await Leads.findByIdAndUpdate(lead._id, {
                $set: {
                    pendingSchedulingSlots: {
                        primary: booking.slots.primary,
                        alternativesSamePeriod: booking.slots.alternativesSamePeriod || [],
                        alternativesOtherPeriod: booking.slots.alternativesOtherPeriod || [],
                        offeredAt: new Date()
                    }
                }
            });

            return {
                text: `Encontrei essas opções para você:\n\n${optionsText}\n\nQual delas fica melhor? (A, B, C...) 💚`
            };
        }

        // Se precisa de slot mas não temos slots ainda, busca (fallback de segurança)
        // ==========================================
        // 2.1) FALHA AO BUSCAR SLOTS (ANTI-LOOP)
        // ==========================================
        if (missing.needsSlot && !booking?.slots?.primary) {

            const attempts = memory?.slotFetchAttempts || 0;

            // Incrementa tentativa
            await Leads.findByIdAndUpdate(lead._id, {
                $set: { slotFetchAttempts: attempts + 1 }
            });

            // Se já tentou mais de 1 vez → escala humano
            if (attempts >= 1) {
                await this.escalateToHuman(lead._id, memory, 'falha_busca_slots');

                return {
                    text: 'Tive uma dificuldade técnica ao buscar os horários agora 😔\n\nVou pedir para nossa equipe te retornar rapidinho com opções, tudo bem? 💚',
                    extractedInfo: {
                        awaitingHumanContact: true,
                        reason: 'slot_fetch_failed'
                    }
                };
            }

            // Primeira tentativa: espera
            return {
                text: 'Só um minutinho que estou verificando os melhores horários para você... 💚'
            };
        }

        // ==========================================
        // 3) SLOT INDISPONÍVEL (FOI EMBORA)
        // ==========================================
        if (booking?.slotGone) {
            // Tem alternativas? Oferece direto
            if (booking.alternatives?.primary) {
                const options = buildSlotOptions(booking.alternatives);
                const optionsText = options.map(o => o.text).join('\n');

                // Atualiza no lead as novas opções
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { pendingSchedulingSlots: booking.alternatives },
                    $unset: {
                        pendingChosenSlot: 1,
                        slotFetchAttempts: 1
                    }
                });

                return {
                    text: `Poxa, esse horário acabou de ser reservado! 😅\n\nMas separei outras opções pra você:\n\n${optionsText}\n\nAlguma funciona? Se não, me fala que busco mais 💚`
                };
            }

            // Sem alternativas → escalonamento humano
            await this.escalateToHuman(lead._id, memory, 'slot_indisponivel');

            return {
                text: `Esse horário acabou de ser preenchido e estamos com agenda apertada esses dias 😔\n\nVou pedir pra nossa equipe te retornar ainda hoje com opções de encaixe.\n\nVocê prefere ligação ou continuar por aqui no WhatsApp?`,
                extractedInfo: {
                    awaitingHumanContact: true,
                    reason: 'slot_gone',
                    escalatedAt: new Date()
                }
            };
        }

        // ==========================================
        // 4) SLOT ESCOLHIDO → COLETAR NOME
        // ==========================================
        if (missing.needsName && booking?.chosenSlot?.doctorId) {
            const slotText = formatSlot(booking.chosenSlot);
            const possibleName = text?.trim();

            // Valida se é realmente um nome ou uma confirmação (Sim, A, ok, etc)
            const isGenericResponse = /^(sim|s|não|nao|n|ok|beleza|a|b|c|d|e|f|\d+|yes|no)$/i.test(possibleName);
            const isValidName =
                possibleName &&
                possibleName.length >= 4 &&
                possibleName.split(' ').length >= 1 &&
                !isGenericResponse;

            if (isValidName) {
                const firstName = possibleName.split(' ')[0];

                // Salva no lead e confirma o slot definitivamente
                await Leads.findByIdAndUpdate(lead._id, {
                    $set: {
                        'patientInfo.name': possibleName,
                        'qualificationData.extractedInfo.nome': possibleName,
                        'autoBookingContext.patientName': possibleName,
                        pendingChosenSlot: booking.chosenSlot // Fixa o slot escolhido
                    }
                });

                return {
                    text: `Perfeito, ${firstName}! 💚 Agora me informe a data de nascimento (dd/mm/aaaa) pra finalizarmos.`,
                    extractedInfo: {
                        nome: possibleName,
                        patientName: possibleName,
                        nomeColetado: true
                    }
                };
            }

            // Se não detectou nome válido ainda (ou veio "Sim", "A", etc), pergunta novamente
            return {
                needsAIGeneration: true,
                promptContext: DYNAMIC_MODULES.slotChosenAskName ?
                    DYNAMIC_MODULES.slotChosenAskName(slotText) :
                    `Confirmando: vou reservar ${slotText}. Qual o nome completo do paciente?`,
                fallbackText: `Perfeito! Vou reservar: ${slotText}.\n\nMe confirma o nome completo do paciente? 💚`
            };
        }

        // ==========================================
        // 5) NOME JÁ TEMOS, MAS FALTA NASCIMENTO (ETAPA EXTRA)
        // ==========================================
        // Se já temos nome mas estamos esperando nascimento (detectado via step ou contexto)
        const patientName =
            memory?.patientName ||
            lead?.patientInfo?.name ||
            memory?.nome;

        if (patientName && !memory?.patientBirthDate && !missing.needsName) {

            const birthDateMatch = text?.match(/(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/);

            if (birthDateMatch) {
                // Salvou nascimento, pode partir para finalização ou confirmação
                const birthDate = `${birthDateMatch[1]}/${birthDateMatch[2]}/${birthDateMatch[3]}`;

                await Leads.findByIdAndUpdate(lead._id, {
                    $set: {
                        'patientInfo.birthDate': birthDate,
                        'qualificationData.extractedInfo.dataNascimento': birthDate
                    }
                });

                return {
                    text: `Show! 👏 Agora é só confirmar:\n\n✅ Nome: ${memory.patientName}\n✅ Nascimento: ${birthDate}\n✅ Horário: ${formatSlot(booking.chosenSlot)}\n\nTudo certo?`,
                    extractedInfo: {
                        birthDateCollected: true,
                        readyToConfirm: true
                    }
                };
            } else {
                // Ainda não recebeu data válida
                return {
                    text: 'Por favor, me informe a data de nascimento no formato dd/mm/aaaa 💚'
                };
            }
        }

        // ==========================================
        // 6) FALLBACK DE SEGURANÇA (NUNCA RETORNA UNDEFINED)
        // ==========================================
        console.warn('[BookingHandler] Fluxo caiu em fallback. Missing:', missing, 'Booking:', !!booking);

        return {
            text: 'Só um instante que já vou te ajudar certinho 💚',
            fallback: true
        };
    }

    // Helper para extrair texto dos módulos dinâmicos
    extractDynamicText(moduleContent) {
        if (!moduleContent) return null;
        if (typeof moduleContent === 'function') {
            // Se for função (como slotChosenAskName), retorna null para usar fallback
            return null;
        }
        return moduleContent.trim();
    }

    // Escalação para atendimento humano
    async escalateToHuman(leadId, memory, reason) {
        try {
            await Leads.findByIdAndUpdate(leadId, {
                $set: {
                    'manualControl.active': true,
                    'manualControl.takenOverAt': new Date(),
                    'manualControl.reason': reason,
                    'flags.needsHumanContact': true,
                    'flags.preferredPeriod': memory?.preferredTime,
                    'flags.preferredTherapy': memory?.therapyArea,
                    'flags.primaryComplaint': memory?.primaryComplaint
                }
            });
        } catch (err) {
            console.error('[BookingHandler] Erro ao escalar:', err);
        }
    }
}

export default new BookingHandler();