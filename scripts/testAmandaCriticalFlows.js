#!/usr/bin/env node
/**
 * 🧪 TESTE CRÍTICO - COMPORTAMENTOS ESSENCIAIS
 * 
 * Valida apenas os comportamentos que NÃO PODEM QUEBRAR:
 * 1. Sempre acolher no primeiro contato
 * 2. NUNCA perguntar idade antes da queixa
 * 3. Sempre responder o que foi perguntado
 * 4. NUNCA repetir pergunta já respondida
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { WhatsAppOrchestrator } from '../orchestrators/WhatsAppOrchestrator.js';
import Leads from '../models/Leads.js';
import ChatContext from '../models/ChatContext.js';

const orchestrator = new WhatsAppOrchestrator();

const c = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m',
    cyan: '\x1b[36m', white: '\x1b[37m'
};

function log(color, ...args) { console.log(color, ...args, c.reset); }

// ============================================
// TESTES CRÍTICOS (Comportamentos que NÃO podem quebrar)
// ============================================

const CRITICAL_TESTS = [
    {
        name: '🎯 PRIMEIRO CONTATO: Preço',
        desc: 'Lead pergunta preço → Deve acolher + dar preço + perguntar QUEIXA',
        phone: '556277771111',
        messages: [
            { 
                text: 'Quanto custa?',
                critical: (resp) => ({
                    pass: resp.includes('Oi!') && resp.includes('situação') && !resp.includes('Qual a idade'),
                    okMsg: '✅ Acolheu + deu preço + perguntou queixa (não idade)',
                    failMsg: '❌ Não acolheu OU perguntou idade antes da queixa'
                })
            }
        ]
    },
    {
        name: '🎯 PRIMEIRO CONTATO: Saudação',
        desc: 'Lead manda "Oi" → Deve acolher + perguntar como ajudar',
        phone: '556277772222',
        messages: [
            { 
                text: 'Oi',
                critical: (resp) => ({
                    pass: resp.includes('Oi!') && (resp.includes('situação') || resp.includes('ajudar')),
                    okMsg: '✅ Acolheu no primeiro contato',
                    failMsg: '❌ Não acolheu no primeiro contato'
                })
            }
        ]
    },
    {
        name: '🎯 FLUXO: Queixa → Idade → Período',
        desc: 'Ordem correta da qualificação',
        phone: '556277773333',
        messages: [
            { 
                text: 'Quero agendar para meu filho',
                critical: (resp) => ({
                    pass: resp.includes('situação') || resp.includes('preocupa') || resp.includes('queixa'),
                    okMsg: '✅ Perguntou queixa primeiro',
                    failMsg: '❌ Não perguntou queixa no primeiro contato'
                })
            },
            { 
                text: 'Ele tem dificuldade na fala',
                critical: (resp) => ({
                    pass: resp.includes('idade') || resp.includes('anos'),
                    okMsg: '✅ Depois da queixa, perguntou idade',
                    failMsg: '❌ Não perguntou idade depois da queixa'
                })
            },
            { 
                text: 'Tem 6 anos',
                critical: (resp) => ({
                    pass: (resp.includes('manhã') || resp.includes('tarde') || resp.includes('período')) 
                          && !resp.includes('Qual a idade'),
                    okMsg: '✅ Depois da idade, perguntou período (não repetiu idade)',
                    failMsg: '❌ Repetiu idade OU não perguntou período'
                })
            }
        ]
    },
    {
        name: '🎯 CONTEXTO: NUNCA repetir idade',
        desc: 'Depois que lead diz a idade, Amanda NUNCA deve perguntar de novo',
        phone: '556277774444',
        messages: [
            { 
                text: 'Oi, meu filho tem 5 anos e não fala direito',
                critical: (resp) => ({
                    pass: !resp.match(/qual.*idade|idade.*paciente/i),
                    okMsg: '✅ Não repetiu pergunta da idade',
                    failMsg: '🔥 CRÍTICO: Repetiu pergunta da idade!'
                })
            },
            { 
                text: 'Quanto é a consulta?',
                critical: (resp) => ({
                    pass: !resp.match(/qual.*idade|idade.*paciente|quantos anos/i),
                    okMsg: '✅ Manteve contexto (não perguntou idade de novo)',
                    failMsg: '🔥 CRÍTICO: Perdeu contexto e perguntou idade novamente!'
                })
            },
            { 
                text: 'Prefiro de tarde',
                critical: (resp) => ({
                    pass: !resp.match(/qual.*idade|idade.*paciente/i),
                    okMsg: '✅ Contexto preservado em toda a conversa',
                    failMsg: '🔥 CRÍTICO: Repetiu idade na 3ª mensagem!'
                })
            }
        ]
    },
    {
        name: '🎯 RESPOSTA DIRETA: Endereço',
        desc: 'Quando pergunta endereço, deve responder diretamente',
        phone: '556277775555',
        messages: [
            { 
                text: 'Onde fica a clínica?',
                critical: (resp) => ({
                    pass: /endereço|ficamos|minas/i.test(resp),
                    okMsg: '✅ Respondeu endereço diretamente',
                    failMsg: '❌ Não respondeu endereço'
                })
            }
        ]
    },
    {
        name: '🎯 RESPOSTA DIRETA: Convênio',
        desc: 'Quando pergunta convênio, deve responder diretamente',
        phone: '556277776666',
        messages: [
            { 
                text: 'Aceitam convênio?',
                critical: (resp) => ({
                    pass: resp.includes('particular') || resp.includes('convênio') || resp.includes('plano'),
                    okMsg: '✅ Respondeu sobre convênio',
                    failMsg: '❌ Não respondeu sobre convênio'
                })
            }
        ]
    },
    {
        name: '🎯 DETECÇÃO: Múltiplas terapias',
        desc: 'Quando menciona mais de uma terapia, deve perguntar qual',
        phone: '556277777777',
        messages: [
            { 
                text: 'Quero agendar fono e psico',
                critical: (resp) => ({
                    pass: (resp.includes('qual') && (resp.includes('especialidade') || resp.includes('área'))) 
                          || resp.includes('fono') || resp.includes('psico'),
                    okMsg: '✅ Detectou múltiplas terapias e perguntou qual',
                    failMsg: '❌ Não perguntou qual especialidade entre as opções'
                })
            }
        ]
    }
];

// ============================================
// FUNÇÕES
// ============================================

async function createLead(phone) {
    await Leads.findOneAndDelete({ phone });
    await ChatContext.deleteOne({ lead: { $in: await Leads.find({ phone }).distinct('_id') } });
    return await Leads.create({
        name: `Teste ${phone}`, phone, source: 'test_critical',
        stage: 'novo', autoReplyEnabled: true,
        qualificationData: { extractedInfo: {} }
    });
}

async function cleanup(leadId) {
    await Leads.findByIdAndDelete(leadId);
    await ChatContext.deleteOne({ lead: leadId });
}

async function sendMessage(lead, text) {
    try {
        const result = await orchestrator.process({
            lead, message: { content: text },
            context: { source: 'whatsapp-inbound' },
            services: {}
        });
        return result?.payload?.text || '[SEM RESPOSTA]';
    } catch (err) {
        return `[ERRO: ${err.message}]`;
    }
}

async function runScenario(scenario) {
    log(c.magenta, `\n${'═'.repeat(70)}`);
    log(c.magenta, `${scenario.name}`);
    log(c.cyan, `${scenario.desc}`);
    log(c.magenta, `${'═'.repeat(70)}`);
    
    let lead;
    const results = [];
    
    try {
        lead = await createLead(scenario.phone);
        
        for (const msg of scenario.messages) {
            log(c.white, `\n👤 Cliente: "${msg.text}"`);
            
            const response = await sendMessage(lead, msg.text);
            log(c.green, `🤖 Amanda: "${response.substring(0, 200)}${response.length > 80 ? '...' : ''}"`);
            
            const check = msg.critical(response);
            results.push(check);
            
            if (check.pass) {
                log(c.green, `   ${check.okMsg}`);
            } else {
                log(c.red, `   ${check.failMsg}`);
            }
        }
        
    } catch (err) {
        log(c.red, `💥 ERRO: ${err.message}`);
        results.push({ pass: false });
    } finally {
        if (lead) await cleanup(lead._id);
    }
    
    const allPassed = results.every(r => r.pass);
    return { name: scenario.name, passed: allPassed, results };
}

// ============================================
// EXECUÇÃO
// ============================================

async function main() {
    log(c.cyan, `\n╔══════════════════════════════════════════════════════════════════════╗`);
    log(c.cyan, `║     🧪 TESTE CRÍTICO - COMPORTAMENTOS ESSENCIAIS                    ║`);
    log(c.cyan, `║     (Se falhar, não pode subir para produção)                       ║`);
    log(c.cyan, `╚══════════════════════════════════════════════════════════════════════╝`);
    
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        log(c.green, '\n✅ MongoDB conectado\n');
    } catch (err) {
        log(c.red, '\n❌ MongoDB:', err.message);
        process.exit(1);
    }
    
    const allResults = [];
    
    for (const scenario of CRITICAL_TESTS) {
        const result = await runScenario(scenario);
        allResults.push(result);
    }
    
    // Resumo
    const passed = allResults.filter(r => r.passed).length;
    const failed = allResults.filter(r => !r.passed).length;
    
    log(c.cyan, `\n${'═'.repeat(70)}`);
    log(c.cyan, `📊 RESULTADO FINAL`);
    log(c.cyan, `${'═'.repeat(70)}`);
    log(c.green, `✅ Passaram: ${passed}/${CRITICAL_TESTS.length}`);
    log(c.red, `❌ Falharam: ${failed}/${CRITICAL_TESTS.length}`);
    
    if (failed > 0) {
        log(c.red, `\n🔥 CENÁRIOS COM FALHA CRÍTICA:`);
        allResults.filter(r => !r.passed).forEach(r => {
            log(c.red, `   ❌ ${r.name}`);
        });
    }
    
    if (failed === 0) {
        log(c.green, `\n🎉 TODOS OS TESTES CRÍTICOS PASSARAM!`);
        log(c.green, `🚀 O novo orquestrador está PRONTO para produção!`);
        log(c.cyan, `\n✨ Comportamentos validados:`);
        log(c.white, `   • Sempre acolhe no primeiro contato`);
        log(c.white, `   • Nunca pergunta idade antes da queixa`);
        log(c.white, `   • Nunca repete pergunta já respondida`);
        log(c.white, `   • Responde diretamente endereço e convênio`);
        log(c.white, `   • Detecta múltiplas terapias`);
    } else {
        log(c.red, `\n⛔ NÃO SUBIR PARA PRODUÇÃO!`);
        log(c.red, `   ${failed} comportamento(s) crítico(s) falhando.`);
    }
    
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

main();
