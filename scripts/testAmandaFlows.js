#!/usr/bin/env node
/**
 * 🧪 TESTE COMPLETO DOS FLOWS DA AMANDA
 * 
 * Simula conversas reais e valida se o comportamento está correto
 * Uso: node scripts/testAmandaFlows.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { WhatsAppOrchestrator } from '../orchestrators/WhatsAppOrchestrator.js';
import Leads from '../models/Leads.js';
import ChatContext from '../models/ChatContext.js';
import { redisConnection } from '../config/redisConnection.js';

const orchestrator = new WhatsAppOrchestrator();

// Cores
const c = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

function log(color, ...args) {
    console.log(color, ...args, c.reset);
}

// ============================================
// CENÁRIOS DE TESTE
// ============================================

const SCENARIOS = [
    {
        name: '💰 PRIMEIRO CONTATO - Pergunta preço',
        phone: '556299991111',
        description: 'Lead pergunta preço na 1ª msg. Deve: acolher + dar preço + perguntar QUEIXA (não idade!)',
        criticalChecks: ['acolhimentoPrimeiro', 'perguntaQueixaAntesIdade'],
        messages: [
            { 
                text: 'Tá quanto uma consulta com a fono?',
                validate: (text) => ({
                    pass: text.includes('Oi!') && text.includes('situação') && !text.includes('Qual a idade'),
                    error: !text.includes('situação') ? 'Não perguntou a queixa' : 
                           text.includes('Qual a idade') ? 'Perguntou idade antes da queixa' : null
                })
            }
        ]
    },
    {
        name: '👋 PRIMEIRO CONTATO - Só "Oi"',
        phone: '556299992222',
        description: 'Saudação simples deve acolher e perguntar queixa',
        criticalChecks: ['acolhimentoPrimeiro'],
        messages: [
            {
                text: 'Oi',
                validate: (text) => ({
                    pass: text.includes('Oi!') && text.includes('situação'),
                    error: !text.includes('Oi!') ? 'Não acolheu' : 
                           !text.includes('situação') ? 'Não perguntou queixa' : null
                })
            }
        ]
    },
    {
        name: '🔥 TESTE CRÍTICO - NUNCA repetir idade',
        phone: '556299994444',
        description: 'Depois que lead diz idade, NUNCA repetir a pergunta',
        criticalChecks: ['contextoPreservado'],
        messages: [
            {
                text: 'Oi, meu filho tem 7 anos',
                validate: (text) => ({
                    pass: text.includes('Oi!') && !text.includes('Qual a idade'),
                    error: text.includes('Qual a idade') ? 'Repetiu pergunta da idade!' : null
                })
            },
            {
                text: 'Quanto custa?',
                validate: (text) => ({
                    pass: !text.match(/qual.*idade|idade.*paciente/i),
                    error: text.match(/qual.*idade|idade.*paciente/i) ? '🔥 CRÍTICO: Repetiu idade na 2ª mensagem!' : null
                })
            }
        ]
    },
    {
        name: '📅 FLUXO COMPLETO - Agendamento',
        phone: '556299995555',
        description: 'Fluxo completo: Queixa → Terapia → Idade → Período',
        messages: [
            {
                text: 'Quero agendar',
                validate: (text) => ({
                    pass: text.includes('situação') || text.includes('queixa'),
                    error: 'Não perguntou queixa no primeiro contato'
                })
            }
        ]
    },
    {
        name: '🔄 FLUXO MULTI-PASSOS - Contexto preservado',
        phone: '556299996666',
        description: 'Fluxo completo: Queixa → (Terapia inferida) → Idade → Período',
        criticalChecks: ['contextoPreservado'],
        messages: [
            // Passo 1: Lead inicia com saudação
            {
                text: 'Oi',
                validate: (text) => ({
                    pass: text.includes('situação') || text.includes('queixa'),
                    error: 'Não perguntou queixa no primeiro contato'
                })
            },
            // Passo 2: Lead diz queixa (que já indica terapia - "não fala" = fono)
            {
                text: 'Meu filho não fala direito',
                validate: (text) => ({
                    // A queixa "não fala" já indica fonoaudiologia, então pula direto para idade
                    pass: text.includes('idade') || text.includes('anos'),
                    error: 'Não perguntou idade após receber queixa (terapia inferida automaticamente)'
                })
            },
            // Passo 3: Diz idade
            {
                text: '5 anos',
                validate: (text) => ({
                    pass: text.includes('manhã') || text.includes('tarde') || text.includes('período'),
                    error: 'Não perguntou período após receber idade'
                })
            }
        ]
    }
];

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

async function createTestLead(phone) {
    await Leads.findOneAndDelete({ phone });
    await ChatContext.deleteOne({ lead: { $in: await Leads.find({ phone }).distinct('_id') } });
    
    return await Leads.create({
        name: `Teste ${phone}`,
        phone: phone,
        source: 'test_script',
        stage: 'novo',
        autoReplyEnabled: true,
        qualificationData: { extractedInfo: {} }
    });
}

async function cleanupTestLead(leadId) {
    await Leads.findByIdAndDelete(leadId);
    await ChatContext.deleteOne({ lead: leadId });
}

async function sendMessage(lead, text) {
    const result = await orchestrator.process({
        lead,
        message: { content: text },
        context: { source: 'whatsapp-inbound' },
        services: {}
    });
    return result;
}

function validateResponse(text, expectations) {
    const errors = [];
    
    // 🔥 NOVO: Validação customizada por função
    if (expectations.validate) {
        const result = expectations.validate(text);
        if (!result.pass && result.error) {
            errors.push(`🔥 ${result.error}`);
        }
        return errors; // Se tem validate, só usa ele
    }
    
    // Checks tradicionais (fallback)
    if (expectations.shouldContain) {
        for (const word of expectations.shouldContain) {
            if (!text.toLowerCase().includes(word.toLowerCase())) {
                errors.push(`❌ Deveria conter: "${word}"`);
            }
        }
    }
    
    if (expectations.shouldNotContain) {
        for (const word of expectations.shouldNotContain) {
            if (text.toLowerCase().includes(word.toLowerCase())) {
                errors.push(`🚫 NÃO deveria conter: "${word}"`);
            }
        }
    }
    
    return errors;
}

async function checkContext(leadId, expected) {
    const chatCtx = await ChatContext.findOne({ lead: leadId }).lean();
    const info = chatCtx?.lastExtractedInfo || {};
    const errors = [];
    
    if (!expected) return { errors, info };
    
    if (expected.contextShouldHave) {
        for (const field of expected.contextShouldHave) {
            if (!info[field] && !info[field === 'complaint' ? 'queixa' : field]) {
                errors.push(`💾 Contexto deveria ter: "${field}"`);
            }
        }
    }
    
    return { errors, info };
}

async function runScenario(scenario) {
    log(c.magenta, `\n${'═'.repeat(70)}`);
    log(c.magenta, `🧪 ${scenario.name}`);
    log(c.cyan, `📱 ${scenario.phone}`);
    log(c.magenta, `${'═'.repeat(70)}\n`);
    
    let lead;
    let allPassed = true;
    const conversation = [];
    
    try {
        lead = await createTestLead(scenario.phone);
        log(c.blue, `✅ Lead criado: ${lead._id}\n`);
        
        for (let i = 0; i < scenario.messages.length; i++) {
            const msg = scenario.messages[i];
            
            log(c.white, `👤 Cliente: "${msg.text}"`);
            
            const result = await sendMessage(lead, msg.text);
            const responseText = result?.payload?.text || '[SEM RESPOSTA]';
            
            log(c.green, `🤖 Amanda:  "${responseText}"\n`);
            
            conversation.push({ user: msg.text, amanda: responseText });
            
            // Valida resposta
            const validationErrors = validateResponse(responseText, msg);
            
            // Valida contexto
            const { errors: contextErrors, info } = await checkContext(lead._id, msg.expects);
            
            const allErrors = [...validationErrors, ...contextErrors];
            
            if (allErrors.length > 0) {
                log(c.red, `❌ FALHAS:`);
                allErrors.forEach(e => log(c.red, `   ${e}`));
                allPassed = false;
            } else {
                log(c.green, `✅ Passou!`);
            }
            
            // Debug do contexto
            log(c.yellow, `💾 Contexto:`, JSON.stringify(info, null, 0).substring(0, 100) + '...\n');
        }
        
    } catch (error) {
        log(c.red, `💥 ERRO: ${error.message}`);
        console.error(error);
        allPassed = false;
    } finally {
        if (lead) {
            await cleanupTestLead(lead._id);
        }
    }
    
    return { passed: allPassed, conversation };
}

// ============================================
// EXECUÇÃO
// ============================================

async function main() {
    log(c.cyan, `
╔══════════════════════════════════════════════════════════════════════╗
║         🧪 TESTE AUTOMÁTICO - FLOWS DA AMANDA                        ║
╚══════════════════════════════════════════════════════════════════════╝
`);
    
    // Conexão
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        log(c.green, '✅ MongoDB conectado');
    } catch (err) {
        log(c.red, '❌ MongoDB:', err.message);
        process.exit(1);
    }
    
    // Testa Redis (ignora erro)
    try {
        await redisConnection.connect();
        log(c.green, '✅ Redis conectado\n');
    } catch {
        log(c.yellow, '⚠️ Redis indisponível (ok para testes)\n');
    }
    
    let passed = 0;
    let failed = 0;
    const results = [];
    
    for (const scenario of SCENARIOS) {
        const result = await runScenario(scenario);
        results.push({ name: scenario.name, ...result });
        
        if (result.passed) {
            passed++;
            log(c.green, `✅ ${scenario.name} - PASSOU\n`);
        } else {
            failed++;
            log(c.red, `❌ ${scenario.name} - FALHOU\n`);
        }
    }
    
    // Resumo
    log(c.cyan, `${'═'.repeat(70)}`);
    log(c.cyan, `📊 RESULTADO FINAL`);
    log(c.cyan, `${'═'.repeat(70)}`);
    log(c.green, `✅ Passaram: ${passed}/${SCENARIOS.length}`);
    log(c.red, `❌ Falharam: ${failed}/${SCENARIOS.length}`);
    
    if (failed === 0) {
        log(c.green, `\n🎉 TODOS OS FLOWS ESTÃO CORRETOS!`);
        log(c.green, `🚀 Pronto para subir em produção!`);
    } else {
        log(c.red, `\n⚠️ ${failed} CENÁRIO(S) COM PROBLEMA!`);
        log(c.yellow, `🔧 Corrija antes de subir para produção.`);
        
        // Mostra falhas
        log(c.red, `\n❌ Falhas:`);
        results.filter(r => !r.passed).forEach(r => {
            log(c.red, `   • ${r.name}`);
        });
    }
    
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

main();
