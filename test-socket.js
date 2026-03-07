// Script para testar emissão de socket
import { getIo } from './config/socket.js';

// Simula uma mensagem recebida
const testSocket = () => {
    try {
        const io = getIo();
        
        console.log('📡 Testando emissão de socket...');
        console.log('Socket conectado:', io.engine?.clientsCount || 'N/A');
        
        const testPayload = {
            id: `test-${Date.now()}`,
            from: '5511999999999',
            to: '5511888888888',
            direction: 'inbound',
            type: 'text',
            content: 'Mensagem de teste do socket',
            text: 'Mensagem de teste do socket',
            status: 'received',
            timestamp: Date.now(),
            leadId: 'test-lead-id',
            contactId: 'test-contact-id'
        };
        
        console.log('Emitindo message:new:', testPayload);
        io.emit('message:new', testPayload);
        console.log('✅ Socket emitido!');
        
        // Também emitir no formato alternativo
        io.emit('whatsapp:new_message', testPayload);
        console.log('✅ whatsapp:new_message emitido!');
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
    }
};

testSocket();
