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
                extractedInfo: { awaitingHumanContact: true }
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
            const optionsText = options.map(o => o.text).join('\n');

            // Usa schedulingContext do amandaPrompt
            return {
                text: `Encontrei essas opções para você:\n\n${optionsText}\n\nQual delas fica melhor? É só responder com a letra (A, B...) 💚`
            };
        }
        // =========================
        // 5) SEM SLOTS - Escalonamento humano
        // =========================
        const period = analysis?.extractedInfo?.preferredPeriod || memory?.preferredTime;

        await this.escalateToHuman(lead._id, memory, 'sem_vagas_disponiveis');

        const periodMessages = {
            manha: `Entendi que você prefere de manhã! 😊\n\nNo momento a agenda da manhã está bem cheia, mas não quero te deixar esperando.\n\nVou pedir pra nossa equipe te retornar ainda hoje com as melhores opções.\n\nVocê prefere ligação ou WhatsApp?`,

            tarde: `Anotado que prefere à tarde! 😊\n\nEsse período está com poucas vagas agora, mas vou pedir pra equipe te retornar ainda hoje com as opções disponíveis.\n\nPrefere ligação ou continuar por aqui?`,

            default: `No momento os horários estão bem apertados 😔\n\nPra não te deixar esperando, vou pedir pra nossa equipe te retornar ainda hoje com as melhores opções.\n\nVocê prefere ligação ou WhatsApp? 💚`
        };

        const responseText = periodMessages[period] || periodMessages.default;

        return {
            text: responseText.endsWith('💚') ? responseText : responseText + ' 💚',
            extractedInfo: {
                awaitingHumanContact: true,
                reason: 'no_slots_available',
                escalatedAt: new Date(),
                preferredPeriod: period || 'flexivel'
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