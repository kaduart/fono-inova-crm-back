#!/usr/bin/env node
/**
 * 🧪 TESTE AUTOMÁTICO DO WHATSAPP ORQUESTRADOR
 * 
 * Testa cenários completos de conversa para garantir que:
 * 1. Primeiro contato: Acolhimento + entender queixa (NÃO pular pra idade!)
 * 2. Fluxo de agendamento: Só depois de entender a queixa
 * 3. Fluxo de preço: Responder preço com acolhimento
 */

import 'dotenv/config';
import { WhatsAppOrchestrator } from '../orchestrators/WhatsAppOrchestrator.js';
import Leads from '../models/Leads.js';
import ChatContext from '../models/ChatContext.js';
import mongoose from 'mongoose';

const orchestrator = new WhatsAppOrchestrator();

// Cores para output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function log(color, ...args) {
    console.log(color, ...args, colors.reset);
}

// ============================================
// CENÁRIOS DE TESTE
// ============================================

const SCENARIOS = [
    {
        name: '🔥 PRIMEIRO CONTATO - Preço + Acolhimento',
        description: 'Lead pergunta preço na primeira mensagem. Deve acolher, dar preço e perguntar queixa (NÃO IDADE!)',
        messages: [
            { 
                text: 'Tá quanto uma consulta com a fono?',
                expectedIntent: 'price_inquiry',
                forbiddenWords: ['idade', 'anos', 'qual a idade'],
                requiredWords: ['acolhimento', 'queixa', 'dificuldade', 'situação', 'preço', 'valor']
            }
        ]
    },
    {
        name: '🔥 FLUXO COMPLETO - Agendamento',
        description: 'Conversa completa desde o primeiro contato até agendamento',
        messages: [
            { 
                text: 'Oi, gostaria de agendar para meu filho',
                expectedIntent: 'first_contact',
                requiredWords: ['acolhimento', 'bem-vindo', 'queixa', 'dificuldade']
            },
            { 
                text: 'Ele tem dificuldade para falar direito',
                expectedIntent: 'complaint_collection',
                contextCheck: { hasComplaint: true }
            },
            { 
                text: 'Tem 5 anos',
                expectedIntent: 'age_collection',
                contextCheck: { hasAge: true, hasComplaint: true }
            },
            { 
                text: 'Tarde',
                expectedIntent: 'period_collection',
                contextCheck: { hasPeriod: true, hasAge: true, hasComplaint: true }
            }
        ]
    },
    {
        name: '🔥 PRIMEIRO CONTATO - "Oi" simples',
        description: 'Lead manda apenas "Oi". Deve acolher e perguntar como pode ajudar',
        messages: [
            { 
                text: 'Oi',
                expectedIntent: 'greeting',
                forbiddenWords: ['idade', 'anos', 'preço', 'valor'],
                requiredWords: ['acolhimento', 'bem-vindo', 'ajudar', 'clínica']
            }
        ]
    },
    {
        name: '🔥 CONTEXTO PRESERVADO - Idade lembrada',
        description: 'Depois de dizer a idade, na próxima mensagem NÃO deve perguntar idade de novo',
        messages: [
            { 
                text: 'Oi, quero agendar',
                saveContext: true
            },
            { 
                text: 'Meu filho tem 7 anos e não fala direito',
                saveContext: true,
                contextCheck: { hasAge: true, hasComplaint: true }
            },
            { 
                text: 'Tarde',
                // 🔥 AQUI O BUG: Ele pergunta "Qual a idade?" de novo!
                forbiddenWords: ['qual a idade', 'quantos anos', 'idade do paciente'],
                requiredWords: ['manhã', 'tarde', 'horário', 'período']
            }
        ]
    },
    {
        name: '🔥 RECUPERAÇÃO DE CONTEXTO - Múltiplas terapias',
        description: 'Lead menciona fono e psico, deve perguntar qual especialidade',
        messages: [
            { 
                text: 'Quero agendar fono e psico para meu filho',
                requiredWords: ['qual', 'especialidade', 'área', 'fono', 'psico'],
                forbiddenWords: ['idade']
            }
        ]
    }
];

// ============================================
// FUNÇÕES DE TESTE
// ============================================

async function createTestLead(phone) {
    const lead = await Leads.create({
        name: `Teste ${phone}`,
        phone: phone,
        source: 'test',
        stage: 'novo',
        autoReplyEnabled: true,
        qualificationData: {
            extractedInfo: {}
        }
    });
    return lead;
}

async function cleanupTestLead(leadId) {
    await Leads.findByIdAndDelete(leadId);
    await ChatContext.deleteOne({ lead: leadId });
}

async function sendMessage(lead, text, previousContext = null) {
    const result = await orchestrator.process({
        lead,
        message: { content: text },
        context: {
            source: 'whatsapp-inbound',
            ...previousContext
        },
        services: {}
    });
    
    return result;
}

function checkResponse(response, expectations) {
    const text = response?.payload?.text?.toLowerCase() || '';
    const errors = [];
    
    // Verifica palavras proibidas
    if (expectations.forbiddenWords) {
        for (const word of expectations.forbiddenWords) {
            if (text.includes(word.toLowerCase())) {
                errors.push(`❌ Palavra proibida encontrada: "${word}"`);
            }
        }
    }
    
    // Verifica palavras obrigatórias
    if (expectations.requiredWords) {
        for (const word of expectations.requiredWords) {
            if (!text.includes(word.toLowerCase())) {
                errors.push(`❌ Palavra obrigatória não encontrada: "${word}"`);
            }
        }
    }
    
    return errors;
}

async function runScenario(scenario) {
    log(colors.magenta, `\n${'='.repeat(60)}`);
    log(colors.magenta, `🧪 CENÁRIO: ${scenario.name}`);
    log(colors.cyan, `📝 ${scenario.description}`);
    log(colors.magenta, `${'='.repeat(60)}\n`);
    
    const phone = `55629999${Math.floor(Math.random() * 8999 + 1000)}`;
    let lead;
    let allPassed = true;
    
    try {
        lead = await createTestLead(phone);
        log(colors.blue, `👤 Lead criado: ${phone} (${lead._id})\n`);
        
        for (let i = 0; i < scenario.messages.length; i++) {
            const msg = scenario.messages[i];
            
            log(colors.yellow, `📩 Mensagem ${i + 1}: "${msg.text}"`);
            
            const response = await sendMessage(lead, msg.text);
            const responseText = response?.payload?.text || '[SEM RESPOSTA]';
            
            log(colors.green, `📤 Resposta: "${responseText.substring(0, 100)}${responseText.length > 100 ? '...' : ''}"\n`);
            
            // Verifica expectativas
            const errors = checkResponse(response, msg);
            
            if (errors.length > 0) {
                log(colors.red, `❌ FALHAS:`);
                errors.forEach(e => log(colors.red, `   ${e}`));
                allPassed = false;
            } else {
                log(colors.green, `✅ Validações passaram!`);
            }
            
            // Verifica contexto se necessário
            if (msg.contextCheck) {
                const chatContext = await ChatContext.findOne({ lead: lead._id }).lean();
                const lastInfo = chatContext?.lastExtractedInfo || {};
                
                if (msg.contextCheck.hasAge && !lastInfo.age) {
                    log(colors.red, `❌ Contexto não salvou a idade!`);
                    allPassed = false;
                }
                if (msg.contextCheck.hasComplaint && !lastInfo.complaint) {
                    log(colors.red, `❌ Contexto não salvou a queixa!`);
                    allPassed = false;
                }
                if (msg.contextCheck.hasPeriod && !lastInfo.period) {
                    log(colors.red, `❌ Contexto não salvou o período!`);
                    allPassed = false;
                }
            }
            
            console.log('');
        }
        
    } catch (error) {
        log(colors.red, `❌ ERRO NO CENÁRIO: ${error.message}`);
        console.error(error);
        allPassed = false;
    } finally {
        if (lead) {
            await cleanupTestLead(lead._id);
            log(colors.blue, `🗑️ Lead de teste removido\n`);
        }
    }
    
    return allPassed;
}

// ============================================
// EXECUÇÃO PRINCIPAL
// ============================================

async function main() {
    log(colors.cyan, `
🚀 INICIANDO TESTES DO WHATSAPP ORQUESTRADOR
${'='.repeat(60)}
`);
    
    // Conecta ao Mongo
    try {
        const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (!mongoUri) {
            throw new Error('MONGODB_URI ou MONGO_URI não definido no .env');
        }
        await mongoose.connect(mongoUri);
        log(colors.green, '✅ Conectado ao MongoDB\n');
    } catch (err) {
        log(colors.red, '❌ Erro ao conectar MongoDB:', err.message);
        process.exit(1);
    }
    
    let passed = 0;
    let failed = 0;
    
    for (const scenario of SCENARIOS) {
        const result = await runScenario(scenario);
        if (result) {
            passed++;
            log(colors.green, `✅ CENÁRIO PASSOU: ${scenario.name}\n`);
        } else {
            failed++;
            log(colors.red, `❌ CENÁRIO FALHOU: ${scenario.name}\n`);
        }
    }
    
    // Resumo
    log(colors.cyan, `${'='.repeat(60)}`);
    log(colors.cyan, '📊 RESUMO DOS TESTES');
    log(colors.cyan, `${'='.repeat(60)}`);
    log(colors.green, `✅ Passaram: ${passed}/${SCENARIOS.length}`);
    log(colors.red, `❌ Falharam: ${failed}/${SCENARIOS.length}`);
    
    if (failed === 0) {
        log(colors.green, `\n🎉 TODOS OS TESTES PASSARAM!`);
    } else {
        log(colors.red, `\n⚠️ ${failed} CENÁRIO(S) COM FALHA!`);
    }
    
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

main();
