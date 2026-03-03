/**
 * 🎮 Conversation Playback - Simulador de Conversas Reais
 * 
 * Usa as 40k+ mensagens do MongoDB para:
 * 1. Reproduzir conversas reais
 * 2. Comparar respostas da Amanda (nova vs original)
 * 3. Identificar regressões
 * 4. Gerar relatórios de qualidade
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

// Models
import Message from '../models/Message.js';
import Lead from '../models/Leads.js';
import Contacts from '../models/Contacts.js';

// Orchestrator
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import { enrichLeadContext } from '../services/leadContext.js';

// Utils
import { deriveFlagsFromText } from '../utils/flagsDetector.js';
import { normalizeE164BR } from '../utils/phone.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// 📊 CONFIGURAÇÃO
// ============================================
const CONFIG = {
    // Limites de execução
    maxConversations: parseInt(process.env.TEST_MAX_CONVERSATIONS) || 100,
    maxMessagesPerConversation: parseInt(process.env.TEST_MAX_MESSAGES) || 20,
    
    // Filtros
    dateRange: {
        from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Últimos 30 dias
        to: new Date()
    },
    
    // Tipos de teste
    testModes: {
        REGRESSION: 'regression',    // Compara nova vs antiga
        SANDBOX: 'sandbox',          // Testa nova implementação
        BENCHMARK: 'benchmark'       // Performance
    },
    
    // Thresholds de qualidade
    qualityThresholds: {
        responseTime: 3000,          // Max 3s
        contextRecovery: 0.95,       // 95% deve recuperar contexto
        nameExtraction: 0.80,        // 80% precisão em nomes
        areaDetection: 0.90          // 90% precisão em área
    }
};

// ============================================
// 🗄️ REPOSITÓRIO DE CONVERSAS
// ============================================
class ConversationRepository {
    async fetchRealConversations(filters = {}) {
        console.log('🔍 Buscando conversas reais...');
        
        const pipeline = [
            // Filtra mensagens de texto dos últimos 30 dias
            {
                $match: {
                    type: 'text',
                    timestamp: { 
                        $gte: filters.dateFrom || CONFIG.dateRange.from,
                        $lte: filters.dateTo || CONFIG.dateRange.to
                    },
                    direction: 'inbound',
                    content: { $exists: true, $ne: '', $not: /^\[/ }
                }
            },
            // Agrupa por lead
            {
                $group: {
                    _id: '$lead',
                    messageCount: { $sum: 1 },
                    firstMessage: { $min: '$timestamp' },
                    lastMessage: { $max: '$timestamp' },
                    messages: {
                        $push: {
                            content: '$content',
                            timestamp: '$timestamp',
                            direction: '$direction',
                            from: '$from'
                        }
                    }
                }
            },
            // Só conversas com múltiplas mensagens
            {
                $match: {
                    messageCount: { $gte: 3 }
                }
            },
            // Ordena por quantidade de mensagens (mais ricas primeiro)
            {
                $sort: { messageCount: -1 }
            },
            {
                $limit: CONFIG.maxConversations
            }
        ];
        
        const conversations = await Message.aggregate(pipeline);
        console.log(`✅ ${conversations.length} conversas encontradas`);
        
        return conversations;
    }
    
    async fetchConversationByLeadId(leadId) {
        const messages = await Message.find({
            lead: leadId,
            type: 'text'
        })
        .sort({ timestamp: 1 })
        .limit(CONFIG.maxMessagesPerConversation)
        .lean();
        
        return messages;
    }
    
    async fetchLeadStateAtTime(leadId, timestamp) {
        // Busca estado do lead em um momento específico
        const lead = await Lead.findById(leadId).lean();
        
        // Busca mensagens até aquele timestamp
        const messagesUntil = await Message.find({
            lead: leadId,
            timestamp: { $lte: timestamp }
        })
        .sort({ timestamp: 1 })
        .lean();
        
        return {
            lead,
            messageHistory: messagesUntil,
            messageCount: messagesUntil.length
        };
    }
}

// ============================================
// 🎮 SIMULADOR DE MENSAGENS
// ============================================
class MessageSimulator {
    constructor() {
        this.results = [];
        this.metrics = {
            total: 0,
            success: 0,
            failed: 0,
            contextRecovered: 0,
            avgResponseTime: 0,
            errors: []
        };
    }
    
    async simulateMessage(userText, lead, context = {}) {
        const startTime = Date.now();
        
        try {
            // Simula o enriquecimento de contexto
            let enrichedContext = null;
            if (lead?._id) {
                try {
                    enrichedContext = await enrichLeadContext(lead._id);
                } catch (e) {
                    console.warn('⚠️ Erro ao enriquecer contexto:', e.message);
                }
            }
            
            // Chama o orquestrador
            const response = await getOptimizedAmandaResponse({
                content: userText,
                userText,
                lead,
                context: {
                    ...context,
                    ...enrichedContext,
                    source: 'test-playback'
                }
            });
            
            const responseTime = Date.now() - startTime;
            
            return {
                success: true,
                response,
                responseTime,
                contextRecovered: this.detectContextRecovery(userText, lead, enrichedContext)
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message,
                responseTime: Date.now() - startTime
            };
        }
    }
    
    detectContextRecovery(userText, lead, enrichedContext) {
        // Detecta se conseguiu recuperar contexto
        const flags = deriveFlagsFromText(userText);
        
        const hasTherapyArea = lead?.therapyArea || enrichedContext?.therapyArea;
        const hasName = lead?.patientInfo?.fullName || enrichedContext?.name;
        const hasAge = lead?.patientInfo?.age || enrichedContext?.patientAge;
        
        // Se a mensagem atual não tem esses dados, mas o contexto recuperou = sucesso
        const recoveredTherapy = !flags.therapyArea && hasTherapyArea;
        const recoveredName = !flags.name && hasName;
        const recoveredAge = !flags.age && hasAge;
        
        return {
            therapyArea: recoveredTherapy,
            name: recoveredName,
            age: recoveredAge,
            any: recoveredTherapy || recoveredName || recoveredAge
        };
    }
    
    async runConversationPlayback(conversation, options = {}) {
        console.log(`\n🎮 Playback: Lead ${conversation._id} (${conversation.messageCount} msgs)`);
        
        const results = [];
        const messages = conversation.messages.slice(0, CONFIG.maxMessagesPerConversation);
        
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            
            // Pula mensagens da Amanda (outbound)
            if (msg.direction === 'outbound') continue;
            
            // Busca estado do lead até esta mensagem
            const state = await new ConversationRepository()
                .fetchLeadStateAtTime(conversation._id, msg.timestamp);
            
            console.log(`  📨 Msg ${i + 1}: "${msg.content.substring(0, 50)}..."`);
            
            // Simula
            const result = await this.simulateMessage(
                msg.content,
                state.lead,
                { messageCount: state.messageCount }
            );
            
            results.push({
                messageIndex: i,
                userText: msg.content,
                ...result
            });
            
            // Atualiza métricas
            this.metrics.total++;
            if (result.success) {
                this.metrics.success++;
                if (result.contextRecovered?.any) {
                    this.metrics.contextRecovered++;
                }
            } else {
                this.metrics.failed++;
                this.metrics.errors.push({
                    msg: msg.content,
                    error: result.error
                });
            }
            
            // Delay entre mensagens para não sobrecarregar
            if (options.delay) {
                await new Promise(r => setTimeout(r, options.delay));
            }
        }
        
        return results;
    }
    
    generateReport() {
        const successRate = (this.metrics.success / this.metrics.total * 100).toFixed(2);
        const contextRecoveryRate = (this.metrics.contextRecovered / this.metrics.total * 100).toFixed(2);
        
        return {
            summary: {
                totalMessages: this.metrics.total,
                successRate: `${successRate}%`,
                contextRecoveryRate: `${contextRecoveryRate}%`,
                failed: this.metrics.failed
            },
            quality: {
                contextRecovery: contextRecoveryRate >= CONFIG.qualityThresholds.contextRecovery * 100 ? 'PASS' : 'FAIL',
                errors: this.metrics.errors.slice(0, 10) // Primeiros 10 erros
            }
        };
    }
}

// ============================================
// 🎯 CASOS DE TESTE ESPECÍFICOS
// ============================================
const TEST_CASES = {
    // Teste 1: Recuperação de contexto (o bug que estamos corrigindo)
    contextRecovery: [
        {
            name: 'Área terapêutica perdida',
            setup: {
                lead: {
                    therapyArea: 'psicologia',
                    patientInfo: { fullName: null }
                }
            },
            messages: [
                { text: 'Gabriel', expectedContext: ['therapyArea'] }
            ]
        },
        {
            name: 'Nome já coletado',
            setup: {
                lead: {
                    therapyArea: 'fonoaudiologia',
                    patientInfo: { fullName: 'Maria Silva' }
                }
            },
            messages: [
                { text: 'ela tem 5 anos', expectedContext: ['name', 'therapyArea'] }
            ]
        }
    ],
    
    // Teste 2: Fluxos completos
    completeFlows: [
        {
            name: 'Agendamento fono',
            messages: [
                'Oi, quero agendar fonoaudiologia',
                'Meu filho se chama Pedro',
                'Ele tem 4 anos',
                'De tarde é melhor'
            ]
        }
    ]
};

// ============================================
// 🚀 EXECUÇÃO PRINCIPAL
// ============================================
async function main() {
    console.log('🎮 Conversation Playback - Simulador de Conversas Reais');
    console.log('========================================================\n');
    
    // Conecta ao MongoDB
    console.log('🔌 Conectando ao MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica');
    console.log('✅ Conectado\n');
    
    const repository = new ConversationRepository();
    const simulator = new MessageSimulator();
    
    try {
        // Modo 1: Playback de conversas reais
        if (process.env.TEST_MODE === 'real') {
            console.log('📊 Modo: Conversas Reais\n');
            
            const conversations = await repository.fetchRealConversations({
                minMessages: 5
            });
            
            for (const conv of conversations.slice(0, 10)) {
                await simulator.runConversationPlayback(conv, { delay: 100 });
            }
            
        // Modo 2: Casos de teste específicos
        } else if (process.env.TEST_MODE === 'cases') {
            console.log('🎯 Modo: Casos de Teste\n');
            
            for (const testCase of TEST_CASES.contextRecovery) {
                console.log(`\n🧪 Teste: ${testCase.name}`);
                
                // Cria lead mock
                const mockLead = {
                    _id: new mongoose.Types.ObjectId(),
                    ...testCase.setup.lead,
                    contact: { phone: '5561999999999' }
                };
                
                for (const msg of testCase.messages) {
                    const result = await simulator.simulateMessage(msg.text, mockLead);
                    
                    console.log(`  📨 "${msg.text}"`);
                    console.log(`  🤖 Resposta: "${result.response?.substring(0, 80)}..."`);
                    console.log(`  ⏱️  ${result.responseTime}ms`);
                    console.log(`  🔄 Contexto recuperado:`, result.contextRecovered);
                }
            }
            
        // Modo 3: Teste único interativo
        } else {
            console.log('💬 Modo: Teste Único\n');
            
            const testLead = await Lead.findOne({
                'contact.phone': { $exists: true }
            }).limit(1);
            
            if (testLead) {
                const result = await simulator.simulateMessage(
                    'Oi, quero agendar psicologia para meu filho Gabriel de 5 anos',
                    testLead
                );
                
                console.log('📨 Entrada:', 'Oi, quero agendar psicologia para meu filho Gabriel de 5 anos');
                console.log('🤖 Resposta:', result.response);
                console.log('⏱️  Tempo:', result.responseTime + 'ms');
            }
        }
        
        // Gera relatório
        const report = simulator.generateReport();
        console.log('\n📊 RELATÓRIO FINAL:');
        console.log(JSON.stringify(report, null, 2));
        
        // Salva relatório
        const reportPath = join(__dirname, 'reports', `playback-${Date.now()}.json`);
        await fs.mkdir(dirname(reportPath), { recursive: true });
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
        console.log(`\n💾 Relatório salvo em: ${reportPath}`);
        
    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

// Exporta para uso como módulo
export {
    ConversationRepository,
    MessageSimulator,
    TEST_CASES,
    main
};

// Roda se chamado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
