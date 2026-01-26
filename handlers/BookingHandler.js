import {
    pickSlotFromUserReply,
    validateSlotStillAvailable,
    findAvailableSlots,
    buildSlotOptions
} from '../services/amandaBookingService.js';

class BookingHandler {
    async execute({ decisionContext, services }) {
        const { message, lead, memory, missing, booking, analysis } = decisionContext;
        const text = message?.text || '';

        // =========================
        // 1) MISSING: COLETA PROGRESSIVA
        // =========================
        if (missing.needsTherapy) {
            return { text: 'Para qual área você gostaria de agendar? (fono, psicologia, fisio, TO) 💚' };
        }

        if (missing.needsComplaint) {
            return { text: 'Me conta um pouquinho sobre o que está acontecendo? Qual a queixa principal? 💚' };
        }

        if (missing.needsAge) {
            return { text: 'Qual a idade do paciente? 💚' };
        }

        if (missing.needsPeriod) {
            return { text: 'Prefere período da manhã ou da tarde? 💚' };
        }

        // =========================
        // 2) SLOT JÁ ESCOLHIDO (confirmar agendamento)
        // =========================
        if (booking?.chosenSlot) {
            // Slot já foi validado no Orchestrator, só confirmar
            if (missing.needsName) {
                return { text: 'Qual o nome completo do paciente? 💚' };
            }

            // Aqui você pode pedir mais dados (nascimento, etc) ou confirmar direto
            return {
                text: `Perfeito! Vou agendar a avaliação para ${booking.chosenSlot.date} às ${booking.chosenSlot.time} com ${booking.chosenSlot.doctorName}. 💚`,
                extractedInfo: { confirmedSlot: booking.chosenSlot }
            };
        }

        // =========================
        // 3) SLOT FOI EMBORA (slotGone)
        // =========================
        if (booking?.slotGone) {
            if (booking.alternatives?.primary) {
                const options = buildSlotOptions(booking.alternatives);
                const optionsText = options.map(o => o.text).join('\n');

                return {
                    text: `Esse horário acabou de ser preenchido 😔\n\nMas encontrei outras opções:\n\n${optionsText}\n\nQual prefere? 💚`
                };
            }

            return {
                text: 'Esse horário não está mais disponível e não encontrei alternativas próximas 😔 Quer tentar outro período? (manhã/tarde) 💚'
            };
        }

        // =========================
        // 4) SLOTS DISPONÍVEIS (apresentar opções)
        // =========================
        if (booking?.slots?.primary) {
            const options = buildSlotOptions(booking.slots);
            const optionsText = options.map(o => o.text).join('\n');

            return {
                text: `Encontrei esses horários:\n\n${optionsText}\n\nQual prefere? (pode responder com a letra) 💚`
            };
        }

        // =========================
        // 5) SEM SLOTS (Orchestrator não encontrou)
        // =========================
        // Se chegou aqui, o Orchestrator tentou buscar mas não achou nada
        const period = analysis?.extractedInfo?.preferredPeriod || memory?.preferredTime;

        return {
            text: `Não encontrei horários ${period ? `no período da ${period}` : 'disponíveis'} 😔 Quer tentar outro período? (manhã/tarde) 💚`
        };
    }
}

export default new BookingHandler();