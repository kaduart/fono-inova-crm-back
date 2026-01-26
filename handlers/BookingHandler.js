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
                // Usa o slotChosenAskName do amandaPrompt
                const slotText = formatSlot(booking.chosenSlot);
                return {
                    text: this.extractDynamicText(DYNAMIC_MODULES.slotChosenAskName(slotText)) ||
                        `Perfeito — vou reservar a opção escolhida. Só confirma o nome completo do paciente? 💚`
                };
            }

            // Confirmação final usando tom premium do amandaPrompt
            return {
                text: `Agendamento confirmado! ✨\n\n${formatSlot(booking.chosenSlot)}\n\n${getManual('duvidas_frequentes', 'pagamento') || 'Vou te enviar todos os detalhes por aqui. Estamos ansiosos para cuidar de vocês! 💚'}`,
                extractedInfo: { confirmedSlot: booking.chosenSlot }
            };
        }

        // =========================
        // 3) SLOT FOI EMBORA (indisponível) - usa OBJECTION_SCRIPTS
        // =========================
        if (booking?.slotGone) {
            if (booking.alternatives?.primary) {
                const options = buildSlotOptions(booking.alternatives);
                const optionsText = options.map(o => o.text).join('\n');

                // Tom de objeção "otherClinic" adaptado para slot indisponível
                return {
                    text: `Ah, que pena! Esse horário acabou de ser reservado 😔\n\nMas consegui outras opções pra você:\n\n${optionsText}\n\nAlguma dessas funciona? 💚`
                };
            }

            // Escalonamento usando lógica do coldLeadContext
            await this.escalateToHuman(lead._id, memory, 'slot_indisponivel');

            return {
                text: `Esse horário não está mais disponível e estamos com alta demanda no momento 💚\n\nPara não deixar você esperando, vou pedir para nossa equipe de agendamento entrar em contato ainda hoje com as melhores opções.\n\nVocê prefere que liguem ou mandem mensagem no WhatsApp?`,
                extractedInfo: { awaitingHumanContact: true }
            };
        }

        // =========================
        // 4) APRESENTAR SLOTS 
        // =========================
        if (booking?.slots?.primary) {
            const options = buildSlotOptions(booking.slots);
            const optionsText = options.map(o => o.text).join('\n');

            // Usa schedulingContext do amandaPrompt
            return {
                text: `Encontrei essas opções para você:\n\n${optionsText}\n\nQual delas fica melhor? É só responder com a letra (A, B...) 💚`
            };
        }

        // =========================
        // 5) SEM SLOTS (Escalonamento humano elegante)
        // =========================
        const period = analysis?.extractedInfo?.preferredPeriod || memory?.preferredTime;

        // Marca para atenção humana (modo coldLead do amandaPrompt)
        await this.escalateToHuman(lead._id, memory, 'sem_vagas_disponiveis');

        // Usa o tom de "coldLeadContext" para não parecer robótico
        return {
            text: `Nossos horários ${period ? `para ${period === 'manha' ? 'manhã' : period}` : ''} estão em alta demanda no momento 💚\n\nPara garantir seu atendimento, vou pedir para nossa equipe de agendamento entrar em contato ainda hoje com as melhores opções disponíveis.\n\nVocê prefere que liguem ou mandem mensagem no WhatsApp?`,
            extractedInfo: {
                awaitingHumanContact: true,
                reason: 'no_slots_available',
                escalatedAt: new Date()
            }
        };
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