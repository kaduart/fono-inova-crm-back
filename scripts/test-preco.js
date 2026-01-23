import { WhatsAppOrchestrator } from '../orchestrators/WhatsAppOrchestrator.js';

const orch = new WhatsAppOrchestrator();

const services = {
    bookingService: {
        findAvailableSlots: async () => ({
            slots: [{ date: '2026-01-25', time: '14:00' }],
            period: 'afternoon',
            doctorId: 'doc123'
        })
    }
};

const result = await orch.process({
    lead: { _id: '125', name: 'João' },
    message: { content: 'quanto custa a consulta?' },
    context: {},
    services
});

console.log('🔥 RESULTADO DO PREÇO:');
console.log(JSON.stringify(result, null, 2));