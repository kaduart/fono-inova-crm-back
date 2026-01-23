const BaseOrchestrator = require('./BaseOrchestrator');
const amandaBookingService = require('../amandaBookingService');
const Logger = require('../services/utils/Logger');

class BookingOrchestrator extends BaseOrchestrator {
    constructor() {
        super();
        this.logger = new Logger('BookingOrchestrator');
    }

    async process(bookingRequest) {
        try {
            this.logger.info('Iniciando processo de booking', {
                leadId: bookingRequest.leadId,
                therapy: bookingRequest.therapy
            });

            // 1. Validar dados
            const validation = this.validateBookingRequest(bookingRequest);
            if (!validation.isValid) {
                return this.buildValidationError(validation.errors);
            }

            // 2. Verificar disponibilidade em circuit breaker
            const availability = await this.executeWithCircuitBreaker(
                amandaBookingService.checkAvailability.bind(amandaBookingService),
                {
                    therapy: bookingRequest.therapy,
                    date: bookingRequest.preferredDate,
                    time: bookingRequest.preferredTime
                },
                'booking-availability'
            );

            if (!availability.isAvailable) {
                return this.buildNoAvailabilityResponse(availability.alternatives);
            }

            // 3. Criar reserva
            const booking = await this.executeWithCircuitBreaker(
                amandaBookingService.createBooking.bind(amandaBookingService),
                {
                    ...bookingRequest,
                    slot: availability.selectedSlot,
                    status: 'pending_confirmation'
                },
                'booking-create'
            );

            // 4. Agendar confirmação
            await this.scheduleConfirmation(booking);

            return this.buildSuccessResponse(booking);

        } catch (error) {
            this.logError('BookingOrchestrator.process', error, bookingRequest);
            return this.buildErrorResponse(error);
        }
    }

    validateBookingRequest(request) {
        const errors = [];

        if (!request.leadId) errors.push('leadId é obrigatório');
        if (!request.therapy) errors.push('therapy é obrigatório');

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    scheduleConfirmation(booking) {
        // Usar UrgencyScheduler para agendar reminder
        const UrgencyScheduler = require('../UrgencyScheduler');
        return UrgencyScheduler.schedule({
            type: 'booking_confirmation',
            bookingId: booking.id,
            executeAt: new Date(Date.now() + 30 * 60000) // 30 minutos
        });
    }

    buildSuccessResponse(booking) {
        return {
            type: 'booking_created',
            booking: booking,
            message: `✅ Agendamento criado! Data: ${booking.date} às ${booking.time}. Você receberá uma confirmação em 30 minutos.`
        };
    }

    buildNoAvailabilityResponse(alternatives) {
        return {
            type: 'no_availability',
            alternatives: alternatives,
            message: 'Não temos disponibilidade neste horário. Que tal um destes alternativos?'
        };
    }

    buildValidationError(errors) {
        return {
            type: 'validation_error',
            errors: errors,
            message: `Dados inválidos: ${errors.join(', ')}`
        };
    }

    buildErrorResponse(error) {
        return {
            type: 'booking_error',
            message: 'Erro ao processar agendamento. Nossa equipe foi notificada.',
            error: error.message
        };
    }
}

module.exports = new BookingOrchestrator();