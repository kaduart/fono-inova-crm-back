/**
 * 🧪 Teste do Novo WhatsAppOrchestrator
 * Simula conversas completas para validar o fluxo
 */

import { WhatsAppOrchestrator } from '../orchestrators/WhatsAppOrchestrator.js';
import Leads from '../models/Leads.js';
import ChatContext from '../models/ChatContext.js';
import mongoose from 'mongoose';
import 'dotenv/config';

// Simula services
const mockServices = {
    whatsapp: { sendMessage: async () => ({ success: true }) }
};

// Cria lead de teste
async function createTestLead(phone = '5562999999999') {
    const lead = await Leads.create({
        contact: { phone },
        name: 'Teste Lead',
        stage: 'novo',
        status: 'novo'
    });
    return lead;
}

// Simula mensagem do lead
function createMessage(text, from = '5562999999999') {
    return {
        content: text,
        text: text,
        from: from,
        to: '556293377726',
        type: 'text',
        timestamp: new Date()
    };
}

// Teste de cenário
async function runScenario(name, messages, phone = '5562999999999') {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎬 CENÁRIO: ${name}`);
    console.log('='.repeat(60));

    const orchestrator = new WhatsAppOrchestrator();
    
    let lead = await createTestLead(phone);
    
    for (const msg of messages) {
        console.log(`\n👤 LEAD: "${msg}"`);
        
        try {
            const result = await orchestrator.process({
                lead,
                message: createMessage(msg, phone),
                services: mockServices
            });
            
            console.log(`🤖 AMANDA: "${result?.payload?.text || result?.text || '(sem resposta)'}"`);
            
            lead = await Leads.findById(lead._id).lean();
            
        } catch (err) {
            console.error(`❌ ERRO:`, err.message);
        }
        
        await new Promise(r => setTimeout(r, 100));
    }
    
    await Leads.findByIdAndDelete(lead._id);
    await ChatContext.deleteOne({ lead: lead._id });
    
    console.log('\n✅ Cenário finalizado');
}

// Cenários
const SCENARIOS = {
    fluxoCompleto: [
        'Oi, queria agendar para meu filho',
        'Fonoaudiologia',
        'Ele fala poucas palavras',
        '5 anos',
        'Manhã',
        'João Silva',
        '15/03/2019'
    ],
    respostasCurtas: [
        'Oi',
        'Quero fono',
        'Gagueira',
        '7',
        'Tarde',
        'Maria',
        '10/05/2017'
    ],
    precoPrimeiro: [
        'Quanto custa?',
        'Fonoaudiologia',
        'Atraso na fala',
        '3 anos',
        'Tarde'
    ]
};

async function runAllTests() {
    console.log('🚀 TESTES DO NOVO ORQUESTRADOR\n');
    
    try {
        if (!mongoose.connection.readyState) {
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('✅ MongoDB conectado\n');
        }
        
        await runScenario('Fluxo Completo', SCENARIOS.fluxoCompleto, '5562811111111');
        await runScenario('Respostas Curtas', SCENARIOS.respostasCurtas, '5562822222222');
        await runScenario('Preço Primeiro', SCENARIOS.precoPrimeiro, '5562833333333');
        
        console.log('\n✅ TESTES CONCLUÍDOS');
        
    } catch (err) {
        console.error('\n❌ ERRO:', err);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests();
}

export { runScenario, SCENARIOS };
