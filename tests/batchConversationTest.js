/**
 * 🎯 Batch Conversation Test - Teste em Lote com Conversas Reais
 * 
 * Carrega conversas do MongoDB e testa a Amanda sem persistência
 * para evitar timeouts e corrida de conexões.
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import Message from '../models/Message.js';
import Lead from '../models/Leads.js';

const C = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

// Configurações
const CONFIG = {
    maxConversations: parseInt(process.env.MAX_CONVERSATIONS) || 5,
    messagesPerConversation: parseInt(process.env.MESSAGES_PER_CONV) || 10,
    skipDbWrites: true // Não escreve no DB durante testes
};

async function loadRealConversations() {
    console.log(`${C.cyan}🔍 Carregando conversas reais do MongoDB...${C.reset}`);
    
    // Busca leads com mensagens recentes
    const pipeline = [
        {
            $match: {
                type: 'text',
                direction: 'inbound',
                timestamp: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
            }
        },
        {
            $group: {
                _id: '$lead',
                messageCount: { $sum: 1 },
                messages: {
                    $push: {
                        content: '$content',
                        direction: '$direction',
                        timestamp: '$timestamp'
                    }
                }
            }
        },
        { $match: { messageCount: { $gte: 3 } } },
        { $sort: { messageCount: -1 } },
        { $limit: CONFIG.maxConversations }
    ];
    
    const conversations = await Message.aggregate(pipeline);
    console.log(`${C.green}✅ ${conversations.length} conversas carregadas${C.reset}\n`);
    
    return conversations;
}

async function simulateConversation(conv, index) {
    const leadId = conv._id;
    console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);
    console.log(`${C.cyan}🎮 Conversa ${index + 1}/${CONFIG.maxConversations} - Lead: ${leadId}${C.reset}`);
    console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);
    
    // Busca dados do lead
    const leadData = await Lead.findById(leadId).lean() || {
        _id: leadId,
        name: 'Lead Teste',
        contact: { phone: '5561999999999' },
        therapyArea: null,
        patientInfo: {}
    };
    
    // Pega apenas as primeiras mensagens
    const messages = conv.messages
        .filter(m => m.direction === 'inbound')
        .slice(0, CONFIG.messagesPerConversation);
    
    const results = [];
    let simulatedLead = { ...leadData };
    
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        console.log(`\n${C.blue}📨 [${i + 1}] Usuário: "${msg.content.substring(0, 60)}${msg.content.length > 60 ? '...' : ''}"${C.reset}`);
        
        try {
            // Desativa persistência durante teste
            const originalEnv = process.env.DISABLE_PERSISTENCE;
            process.env.DISABLE_PERSISTENCE = 'true';
            
            const response = await getOptimizedAmandaResponse({
                content: msg.content,
                userText: msg.content,
                lead: simulatedLead,
                context: { testMode: true, skipDbWrites: true }
            });
            
            process.env.DISABLE_PERSISTENCE = originalEnv;
            
            console.log(`${C.green}🤖 Amanda: "${response?.substring(0, 80)}${response?.length > 80 ? '...' : ''}"${C.reset}`);
            
            // Avalia qualidade da resposta
            const quality = evaluateResponseQuality(response, msg.content);
            console.log(`   ⭐ Qualidade: ${quality.score}/10 - ${quality.rating}`);
            
            results.push({
                turn: i + 1,
                input: msg.content,
                response: response?.substring(0, 100),
                quality
            });
            
        } catch (error) {
            console.error(`${C.red}❌ Erro: ${error.message}${C.reset}`);
            results.push({ turn: i + 1, input: msg.content, error: error.message });
        }
        
        // Delay entre mensagens
        await new Promise(r => setTimeout(r, 500));
    }
    
    return {
        leadId,
        totalMessages: messages.length,
        avgQuality: results.filter(r => r.quality).reduce((a, r) => a + r.quality.score, 0) / results.filter(r => r.quality).length || 0,
        results
    };
}

function evaluateResponseQuality(response, input) {
    if (!response) return { score: 0, rating: 'Sem resposta' };
    
    let score = 5; // Base
    
    // Critérios positivos
    if (/\b(entendo|compreendo|sei|imagino)\b/i.test(response)) score += 2;
    if (/\b(pode ser|se quiser|gostaria|quer)\b/i.test(response)) score += 1;
    if (/\b(nome|idade|área|período|manhã|tarde)\b/i.test(response)) score += 1;
    if (response.includes('💚') || response.includes('😊')) score += 1;
    
    // Critérios negativos
    if (/\b(erro|desculpe|não sei|não posso)\b/i.test(response)) score -= 2;
    if (response.length < 20) score -= 2;
    if (/\b(corre|urgente|só hoje|última chance)\b/i.test(response)) score -= 3;
    
    return {
        score: Math.max(0, Math.min(10, score)),
        rating: score >= 8 ? 'Excelente' : score >= 6 ? 'Boa' : score >= 4 ? 'Regular' : 'Ruim'
    };
}

async function main() {
    console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);
    console.log(`${C.cyan}🎯 BATCH CONVERSATION TEST - Amanda AI${C.reset}`);
    console.log(`${C.cyan}Testando com conversas reais do MongoDB${C.reset}`);
    console.log(`${C.cyan}${'='.repeat(70)}${C.reset}\n`);
    
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
        console.log(`${C.green}✅ Conectado ao MongoDB${C.reset}\n`);
        
        const conversations = await loadRealConversations();
        const allResults = [];
        
        for (let i = 0; i < conversations.length; i++) {
            const result = await simulateConversation(conversations[i], i);
            allResults.push(result);
        }
        
        // Relatório final
        console.log(`\n${C.cyan}${'='.repeat(70)}${C.reset}`);
        console.log(`${C.cyan}📊 RELATÓRIO FINAL${C.reset}`);
        console.log(`${C.cyan}${'='.repeat(70)}${C.reset}`);
        
        const avgQuality = allResults.reduce((a, r) => a + r.avgQuality, 0) / allResults.length;
        console.log(`\n📈 Qualidade Média: ${avgQuality.toFixed(1)}/10`);
        console.log(`📊 Conversas Testadas: ${allResults.length}`);
        
        // Salva relatório
        const fs = await import('fs/promises');
        const reportPath = `./test-reports/batch-test-${Date.now()}.json`;
        await fs.mkdir('./test-reports', { recursive: true });
        await fs.writeFile(reportPath, JSON.stringify(allResults, null, 2));
        console.log(`\n💾 Relatório: ${reportPath}`);
        
    } catch (error) {
        console.error(`${C.red}❌ Erro: ${error.message}${C.reset}`);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(console.error);
