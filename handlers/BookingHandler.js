import Leads from '../models/Leads.js';
import {
    buildSlotOptions,
    formatSlot
} from '../services/amandaBookingService.js';
import { buildResponse } from '../services/intelligence/naturalResponseBuilder.js';

/**
 * 🎯 BookingHandler SIMPLIFICADO
 * Responsabilidade ÚNICA: Gerenciar slots e confirmação de agendamento
 * NÃO faz coleta de dados (therapy, complaint, age, period) - isso é do DecisionEngine
 */
class BookingHandler {
    async execute({ decisionContext, services }) {
        const { message, lead, memory, missing, booking, analysis } = decisionContext;
        const text = message?.text || '';

        const patientName = memory?.patientName || lead?.patientInfo?.name || lead?.autoBookingContext?.patientName;
        const patientBirthDate = memory?.patientBirthDate || lead?.patientInfo?.birthDate;

        // ==========================================
        // 1) SLOT INDISPONÍVEL (FOI EMBORA)
        // ==========================================
        if (booking?.slotGone) {
            if (booking.alternatives?.primary) {
                const options = buildSlotOptions(booking.alternatives);
                const optionsText = options.map(o => o.text).join('\n');

                await Leads.findByIdAndUpdate(lead._id, {
                    $set: { pendingSchedulingSlots: booking.alternatives },
                    $unset: { pendingChosenSlot: 1 }
                });

                return {
                    text: `Poxa, esse horário acabou de ser reservado! 😅\n\nMas separei outras opções:\n\n${optionsText}\n\nAlguma funciona? 💚`
                };
            }

            await this.escalateToHuman(lead._id, memory, 'slot_indisponivel');
            return {
                text: `Esse horário acabou de ser preenchido 😔\n\nVou pedir pra nossa equipe te retornar ainda hoje com opções.`,
                extractedInfo: { awaitingHumanContact: true, reason: 'slot_gone' }
            };
        }

        // ==========================================
        // 2) SEM SLOTS DISPONÍVEIS
        // ==========================================
        if (booking?.noSlotsAvailable) {
            await this.escalateToHuman(lead._id, memory, 'sem_vagas');
            return {
                text: 'Nossa agenda está bem apertada esses dias 😔\n\nVou pedir pra nossa equipe te retornar ainda hoje com opções de encaixe. Tudo bem? 💚',
                extractedInfo: { awaitingHumanContact: true, reason: 'no_slots' }
            };
        }

        // ==========================================
        // 3) APRESENTAR SLOTS (TEM DADOS SUFICIENTES)
        // ==========================================
        if (missing.needsSlot && booking?.slots?.primary) {
            const options = buildSlotOptions(booking.slots);
            
            if (!options.length) {
                await this.escalateToHuman(lead._id, memory, 'slots_vazios');
                return {
                    text: 'Estou com dificuldade para buscar os horários no momento. Vou pedir para nossa equipe te retornar rapidinho 💚'
                };
            }

            const optionsText = options.map(o => o.text).join('\n');

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
                text: buildResponse('show_slots', { slotsText: optionsText, leadId: lead?._id }) ||
                      `Encontrei essas opções:\n\n${optionsText}\n\nQual funciona? 💚`
            };
        }

        // Aguardando usuário escolher slot
        if (missing.needsSlotSelection && booking?.slots?.primary) {
            const optionsText = buildSlotOptions(booking.slots).map(o => o.text).join('\n');
            return {
                text: `Opções disponíveis:\n\n${optionsText}\n\nQual funciona melhor? 💚`
            };
        }

        // ==========================================
        // 4) SLOT ESCOLHIDO → COLETAR DADOS DO PACIENTE
        // ==========================================
        if (missing.needsName) {
            // Verifica se slot é válido
            if (!booking?.chosenSlot?.doctorId) {
                return {
                    text: 'Desculpe, não consegui guardar o horário. Pode confirmar novamente qual opção prefere (A, B ou C)? 💚',
                    extractedInfo: { slotLost: true }
                };
            }

            const slotText = formatSlot(booking.chosenSlot);
            const possibleName = text?.trim();

            // Valida se é um nome válido
            const isGeneric = /^(sim|s|não|nao|n|ok|beleza|a|b|c|d|\d+)$/i.test(possibleName);
            const isValidName = possibleName && possibleName.length >= 3 && !isGeneric;

            if (isValidName) {
                const firstName = possibleName.split(' ')[0];

                await Leads.findByIdAndUpdate(lead._id, {
                    $set: {
                        'patientInfo.name': possibleName,
                        'qualificationData.extractedInfo.nome': possibleName,
                        'autoBookingContext.patientName': possibleName,
                        pendingSchedulingSlots: null,
                        pendingChosenSlot: booking?.chosenSlot || lead.pendingChosenSlot
                    }
                });

                return {
                    text: `Perfeito, ${firstName}! 💚 Agora a data de nascimento (dd/mm/aaaa):`,
                    extractedInfo: {
                        patientName: possibleName,
                        nomeColetado: true
                    }
                };
            }

            // Pede o nome
            return {
                text: `Confirmando: ${slotText}\n\nQual o nome completo do paciente? 💚`
            };
        }

        // ==========================================
        // 5) COLETAR DATA DE NASCIMENTO
        // ==========================================
        if (patientName && !patientBirthDate) {
            const birthMatch = text?.match(/(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/);

            if (birthMatch) {
                const birthDate = `${birthMatch[1]}/${birthMatch[2]}/${birthMatch[3]}`;

                await Leads.findByIdAndUpdate(lead._id, {
                    $set: {
                        'patientInfo.birthDate': birthDate,
                        'qualificationData.extractedInfo.dataNascimento': birthDate
                    }
                });

                return {
                    text: buildResponse('confirm_booking', { 
                        slotText: formatSlot(booking.chosenSlot), 
                        patientName,
                        leadId: lead?._id 
                    }) || `Show! 👏\n\n✅ ${patientName}\n✅ ${birthDate}\n✅ ${formatSlot(booking.chosenSlot)}\n\nTudo certo?`,
                    extractedInfo: { birthDateCollected: true, readyToConfirm: true }
                };
            }

            return {
                text: 'Por favor, a data de nascimento no formato dd/mm/aaaa 💚'
            };
        }

        // ==========================================
        // 6) CONFIRMAÇÃO FINAL
        // ==========================================
        if (patientName && patientBirthDate && booking?.chosenSlot) {
            return {
                text: `Perfeito! 🎉 Agendamento confirmado:\n\n📅 ${formatSlot(booking.chosenSlot)}\n👤 ${patientName}\n\nVocês vão adorar! Qualquer dúvida é só chamar 💚`,
                extractedInfo: { bookingConfirmed: true }
            };
        }

        // ==========================================
        // 7) FALLBACK
        // ==========================================
        console.warn('[BookingHandler] Fallback. Missing:', missing, 'Booking:', !!booking);
        return {
            text: 'Só um instante que já vou te ajudar 💚',
            fallback: true
        };
    }

    async escalateToHuman(leadId, memory, reason) {
        try {
            await Leads.findByIdAndUpdate(leadId, {
                $set: {
                    'manualControl.active': true,
                    'manualControl.takenOverAt': new Date(),
                    'manualControl.reason': reason,
                    'flags.needsHumanContact': true
                }
            });
        } catch (err) {
            console.error('[BookingHandler] Erro ao escalar:', err);
        }
    }
}

export default new BookingHandler();
