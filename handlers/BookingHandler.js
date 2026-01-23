export class BookingHandler {
    async execute({ lead, message, context, services }) {
        // Validação defensiva
        if (!services?.bookingService) {
            throw new Error('bookingService não fornecido');
        }

        const { bookingService } = services;

        // 1. Extrair preferências (se existirem)
        const period = context?.preferredPeriod ?? null;
        const date = context?.preferredDate ?? null;

        // 2. Buscar slots — FONTE ÚNICA
        const availability = await bookingService.findAvailableSlots({
            therapy: context.therapy,
            leadId: lead?._id,
            preferredDate: date,
            preferredPeriod: period
        });

        // 3. Nunca escolher slot aqui
        return {
            data: {
                therapy: context.therapy,
                slots: availability?.slots || [],
                period: availability?.period,
                doctorId: availability?.doctorId
            },
            events: ['SLOTS_AVAILABLE']
        };
    }
}