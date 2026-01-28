/**
 * Abstrai o acesso aos campos de estado de agendamento do Lead
 * Centraliza toda lógica de pending* e autoBookingContext
 */

import Leads from '../models/Leads.js';

export class BookingStateService {
    constructor(leadId) {
        this.leadId = leadId;
    }

    /**
     * Determina se existe agendamento pendente (checkpoint ativo)
     */
    hasActiveBookingState(memory) {
        return !!(
            memory?.pendingSchedulingSlots?.primary ||
            memory?.pendingChosenSlot?.doctorId ||
            memory?.autoBookingContext?.schedulingIntentActive
        );
    }

    /**
     * Atualiza o "passo atual" no campo existente pendingPatientInfoStep
     */
    async updateCurrentStep(step) {
        await Leads.findByIdAndUpdate(this.leadId, {
            $set: { pendingPatientInfoStep: step }
        });
    }

    /**
     * Limpa estado de agendamento (quando completa ou cancela)
     */
    async clearBookingState() {
        await Leads.findByIdAndUpdate(this.leadId, {
            $set: {
                pendingSchedulingSlots: null,
                pendingChosenSlot: null,
                pendingPatientInfoStep: null
            },
            $unset: {
                'autoBookingContext.schedulingIntentActive': 1
            }
        });
    }

    /**
     * Salva slots oferecidos
     */
    async saveOfferedSlots(slots) {
        await Leads.findByIdAndUpdate(this.leadId, {
            $set: {
                pendingSchedulingSlots: {
                    primary: slots.primary,
                    alternativesSamePeriod: slots.alternativesSamePeriod || [],
                    alternativesOtherPeriod: slots.alternativesOtherPeriod || [],
                    offeredAt: new Date()
                },
                'autoBookingContext.schedulingIntentActive': true
            }
        });
    }

    /**
     * Salva slot escolhido
     */
    async saveChosenSlot(slot) {
        await Leads.findByIdAndUpdate(this.leadId, {
            $set: { pendingChosenSlot: slot },
            $unset: { pendingSchedulingSlots: 1 }
        });
    }
}