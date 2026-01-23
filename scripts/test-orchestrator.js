import { WhatsAppOrchestrator } from '../orchestrators/WhatsAppOrchestrator.js';

const orch = new WhatsAppOrchestrator();

// Mock services
const services = {
    bookingService: {
        findAvailableSlots: async () => ({
            slots: [{ date: '2026-01-25', time: '14:00' }],
            period: 'afternoon',
            doctorId: 'doc123'
        })
    },
    productService: {
        resolve: async () => ({
            name: 'Consulta Psicologia',
            price: 150,
            duration: '50 min'
        })
    }
};

// Teste
const result = await orch.process({
    lead: { _id: '123', name: 'Test' },
    message: { content: 'quero agendar' },
    context: {},
    services
});

// Teste 2: Pergunta sobre terapia
const result2 = await orch.process({
    lead: { _id: '124', name: 'Maria' },
    message: { content: 'tenho ansiedade, qual terapia preciso?' },
    context: {},
    services
});
console.log('Terapia:', result2.command);

// Teste 3: Pergunta sobre preço
const result3 = await orch.process({
    lead: { _id: '125', name: 'João' },
    message: { content: 'quanto custa a consulta?' },
    context: {},
    services: {
        productService: { resolve: async () => ({ name: 'Consulta', price: 150 }) }
    }
});
console.log('Preço:', result3.command);

// Teste 4: Fallback (não entendeu)
const result4 = await orch.process({
    lead: { _id: '126', name: 'Ana' },
    message: { content: 'asdfgh' },
    context: {},
    services
});
console.log('Fallback:', result4.command);



console.log('Resultado:', JSON.stringify(result, null, 2));