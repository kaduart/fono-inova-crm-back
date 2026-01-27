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

        // =========================
        // 0) SEM SLOTS (PRIORIDADE MÁXIMA)
        // =========================
        if (booking?.noSlotsAvailable || booking?.flow === 'no_slots') {
            const period = analysis?.extractedInfo?.preferredPeriod || memory?.preferredTime;

            await this.escalateToHuman(lead._id, memory, 'sem_vagas_disponiveis');

            return {
                needsAIGeneration: true,
                promptContext: DYNAMIC_MODULES.noSlotsAvailable(period),
                fallbackText: 'Nossa equipe vai entrar em contato ainda hoje 💚',
                extractedInfo: {
                    awaitingHumanContact: true,
                    reason: 'no_slots_available',
                    preferredPeriod: period || 'flexivel'
                }
            };
        }

        // =========================
        // 1) COLETA PROGRESSIVA (usa flagsDetector + MANUAL_AMANDA)
        // =========================
        if (missing.needsTherapy) {
            return {
                text: getManual('especialidades', 'fono') ||
                    'Qual especialidade você está procurando? Temos Fono, Psicologia, Fisio e Terapia Ocupacional 💚'
            };
        }

        if (missing.needsComplaint) {
            // Usa o módulo de triagem do amandaPrompt
            return {
                text: this.extractDynamicText(DYNAMIC_MODULES.triageAskComplaint) ||
                    'Para indicarmos o profissional ideal, me conta um pouquinho: o que está te preocupando? (fala, comportamento, aprendizagem...) 💚'
            };
        }

        if (missing.needsAge) {
            return {
                text: this.extractDynamicText(DYNAMIC_MODULES.triageAskAge(analysis?.extractedInfo?.therapyArea)) ||
                    'Qual a idade do paciente? (Isso ajuda a encontrarmos o melhor horário e profissional) 💚'
            };
        }

        if (missing.needsPeriod) {
            return {
                text: this.extractDynamicText(DYNAMIC_MODULES.triageAskPeriod) ||
                    'Você tem preferência por algum período? Manhã ou tarde funcionam melhor pra você? 💚'
            };
        }

        // =========================
        // 2) SLOT JÁ ESCOLHIDO → Confirmação final
        // =========================
        if (booking?.chosenSlot) {
            if (missing.needsName) {
                const slotText = formatSlot(booking.chosenSlot);

                return {
                    needsAIGeneration: true,
                    promptContext: DYNAMIC_MODULES.slotChosenAskName(slotText),
                    fallbackText: `Perfeito! Vou reservar: ${slotText}. Me confirma o nome completo do paciente? 💚`
                };
            }

            if (missing.needsBirthDate) {
                return {
                    needsAIGeneration: true,
                    promptContext: DYNAMIC_MODULES.slotChosenAskBirth,
                    fallbackText: `Obrigada! Agora me passa a data de nascimento (dd/mm/aaaa) 💚`,
                    extractedInfo: { pendingStep: 'awaiting_birthdate' }
                };
            }

            // Confirmação final
            const slotText = formatSlot(booking.chosenSlot);
            return {
                text: `Agendamento confirmado! ✨\n\n📅 ${slotText}\n\nVou te enviar os detalhes por aqui. Estamos ansiosos pra cuidar de vocês! 💚`,
                extractedInfo: { confirmedSlot: booking.chosenSlot }
            };
        }

        // =========================
        // 3) SLOT FOI EMBORA (indisponível)
        // =========================
        if (booking?.slotGone) {
            // Tem alternativas? Oferece direto
            if (booking.alternatives?.primary) {
                const options = buildSlotOptions(booking.alternatives);
                const optionsText = options.map(o => o.text).join('\n');

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
        console.log('🔍 [BOOKING-DEBUG] Tentando buscar slots:', {
            therapyArea: analysis?.extractedInfo?.therapyArea,
            preferredPeriod: analysis?.extractedInfo?.preferredPeriod,
            preferredDate: analysis?.extractedInfo?.preferredDate
        });


        // =========================
        // 4) APRESENTAR SLOTS 
        // =========================
        if (booking?.slots?.primary) {
            const options = buildSlotOptions(booking.slots);

            if (!options.length) {
                return {
                    needsAIGeneration: true,
                    promptContext: DYNAMIC_MODULES.noSlotsAvailable(
                        analysis?.extractedInfo?.preferredPeriod || memory?.preferredTime
                    ),
                    fallbackText: 'Nossa equipe vai entrar em contato ainda hoje 💚'
                };
            }

            const optionsText = options.map(o => o.text).join('\n');
            return {
                text: `Encontrei essas opções para você:\n\n${optionsText}\n\nQual delas fica melhor? (A, B, C...) 💚`
            };
        }


    }

    // Helper para extrair texto dos módulos dinâmicos (que podem ser strings ou funções)
    extractDynamicText(moduleContent) {
        if (!moduleContent) return null;
        if (typeof moduleContent === 'function') {
            // Se for função (como slotChosenAskName), retorna null para usar fallback
            return null;
        }
        return moduleContent.trim();
    }

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