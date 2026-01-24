import {
    pickSlotFromUserReply,
    validateSlotStillAvailable,
    findAvailableSlots
} from '../services/amandaBookingService.js';


class BookingHandler {
    async execute({ decisionContext, services }) {
        const { message, lead, memory, missing } = decisionContext;
        const text = message?.text || '';

        if (missing.needsTherapy) {
            return { text: 'Para qual área você gostaria de agendar? (fono, psicologia, fisio, TO) 💚' };
        }

        if (missing.needsAge) {
            return { text: 'Qual a idade do paciente? 💚' };
        }

        if (missing.needsPeriod) {
            return { text: 'Prefere período da manhã ou da tarde? 💚' };
        }

        // =========================
        // SLOT JÁ OFERECIDO
        // =========================
        if (memory.pendingSlots?.length) {
            const chosenSlot = pickSlotFromUserReply(text, memory.pendingSlots);

            if (chosenSlot) {
                const stillAvailable = await validateSlotStillAvailable(chosenSlot);

                if (!stillAvailable) {
                    const freshSlots = await findAvailableSlots({
                        therapyArea: memory.therapyArea,
                        preferredPeriod: memory.preferredTime,
                        maxOptions: 3
                    });

                    if (!freshSlots) {
                        return {
                            text: 'Não encontrei horários no outro período também 😔 Quer tentar outro dia? 💚'
                        };
                    }

                    const altText = freshSlots.alternativesOtherPeriod
                        .map((s, i) => `${String.fromCharCode(65 + i)}) ${s.date} às ${s.time}`)
                        .join('\n');

                    return {
                        text: `Esse horário acabou de ser preenchido 😔\n\nPosso te oferecer estas outras opções:\n\n${altText}`,
                        extractedInfo: { pendingSlots: freshSlots }
                    };

                }

                await services.bookingService.confirmBooking({
                    leadId: lead._id,
                    slot: chosenSlot,
                    therapy: memory.therapyArea
                });

                return {
                    text: `Perfeito! Agendei a avaliação para ${chosenSlot.date} às ${chosenSlot.time}. 💚`,
                    extractedInfo: { chosenSlot }
                };
            }

            return {
                text: 'Não consegui identificar qual horário você escolheu 😅 Você pode responder com a letra (A, B ou C) ou dizendo o dia e horário, por exemplo: "terça às 14h"? 💚'
            };
        }

        // =========================
        // BUSCAR NOVOS SLOTS
        // =========================
        const slots = await services.bookingService.findAvailableSlots({
            therapy: memory.therapyArea,
            period: memory.preferredTime
        });

        if (!slots?.length) {
            return { text: 'Não encontrei horários nesse período 😔 Quer tentar outro? (manhã/tarde) 💚' };
        }

        await services.leadService.savePendingSlots(lead._id, slots);

        const slotsText = slots
            .map((s, i) => `${String.fromCharCode(65 + i)}) ${s.date} às ${s.time}`)
            .join('\n');

        return {
            text: `Encontrei esses horários:\n\n${slotsText}\n\nQual prefere? (A, B ou C) 💚`,
            extractedInfo: { pendingSlots: slots }
        };
    }
}

export default new BookingHandler();
