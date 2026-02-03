#!/usr/bin/env node
/**
 * 🧪 TESTE COMPLETO - TODOS OS TIPOS DE MENSAGEM
 * 
 * Valida se o novo orquestrador responde corretamente a QUALQUER tipo de mensagem
 * baseado nas regras do TherapyDetector e flags existentes
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
    cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m'
};

function log(color, ...args) { console.log(color, ...args, c.reset); }

// ============================================
// 🎯 TODOS OS TIPOS DE MENSAGEM (TherapyDetector + Flags)
// ============================================

const TEST_CASES = [
    // 🔥 INTENÇÕES DE AGENDAMENTO
    { category: 'AGENDAMENTO', text: 'Quero agendar', expected: ['acolhimento', 'queixa', 'situação'] },
    { category: 'AGENDAMENTO', text: 'Tem vaga para essa semana?', expected: ['acolhimento', 'queixa'] },
    { category: 'AGENDAMENTO', text: 'Quero marcar para meu filho', expected: ['acolhimento', 'situação'] },
    { category: 'AGENDAMENTO', text: 'Preciso de uma consulta urgente', expected: ['acolhimento', 'queixa'] },
    
    // 💰 PREÇO
    { category: 'PREÇO', text: 'Quanto custa?', expected: ['preço', 'valor', 'acolhimento'] },
    { category: 'PREÇO', text: 'Tá quanto a consulta?', expected: ['preço', 'acolhimento'] },
    { category: 'PREÇO', text: 'Qual o valor da avaliação?', expected: ['investimento', 'acolhimento'] },
    { category: 'PREÇO', text: 'É caro?', expected: ['preço', 'valor'] },
    { category: 'PREÇO', text: 'Tabela de preços', expected: ['preço', 'valor'] },
    
    // 📍 LOCALIZAÇÃO
    { category: 'LOCAL', text: 'Onde fica?', expected: ['endereço', 'ficamos', 'minas gerais'] },
    { category: 'LOCAL', text: 'Qual o endereço?', expected: ['endereço', 'ficamos'] },
    { category: 'LOCAL', text: 'Vocês são de Anápolis?', expected: ['anápolis', 'endereço'] },
    
    // 🏥 CONVÊNIOS/PLANOS
    { category: 'CONVÊNIO', text: 'Aceitam convênio?', expected: ['particular', 'convênio', 'plano'] },
    { category: 'CONVÊNIO', text: 'Tem convênio com o Hapvida?', expected: ['particular', 'convênio'] },
    { category: 'CONVÊNIO', text: 'Atendem pelo plano de saúde?', expected: ['particular', 'plano'] },
    
    // 👋 SAUDAÇÕES
    { category: 'SAUDAÇÃO', text: 'Oi', expected: ['acolhimento', 'bem-vindo', 'ajudar'] },
    { category: 'SAUDAÇÃO', text: 'Olá', expected: ['acolhimento', 'bem-vindo'] },
    { category: 'SAUDAÇÃO', text: 'Bom dia', expected: ['acolhimento', 'bom dia'] },
    { category: 'SAUDAÇÃO', text: 'Boa tarde', expected: ['acolhimento', 'boa tarde'] },
    
    // 🧠 ESPECIALIDADES ESPECÍFICAS
    { category: 'FONO', text: 'Preciso de fonoaudiólogo', expected: ['fono', 'avaliação'] },
    { category: 'FONO', text: 'Meu filho não fala direito', expected: ['fono', 'fala'] },
    { category: 'PSICO', text: 'Quero psicólogo', expected: ['psico', 'psicologia'] },
    { category: 'PSICO', text: 'Tenho ansiedade', expected: ['psico', 'ansiedade'] },
    { category: 'TO', text: 'Preciso de terapia ocupacional', expected: ['to', 'terapia ocupacional'] },
    { category: 'NEURO', text: 'Avaliação neuropsicológica', expected: ['neuro', 'avaliação'] },
    { category: 'MULTI', text: 'Quero fono e psico', expected: ['qual', 'especialidade', 'área'] },
    
    // 👶 IDADE/QUEIXA (fluxo completo)
    { category: 'FLUXO', text: 'Meu filho tem 5 anos', expected: ['acolhimento', 'situação'] },
    { category: 'FLUXO', text: 'Ela tem autismo', expected: ['acolhimento', 'entendi'] },
    { category: 'FLUXO', text: 'Tem TDAH', expected: ['acolhimento', 'neuro'] },
    { category: 'FLUXO', text: 'Não fala ainda', expected: ['acolhimento', 'fono'] },
    
    // ⏰ HORÁRIO
    { category: 'HORÁRIO', text: 'Qual horário de funcionamento?', expected: ['horário', 'funcionamento', 'segunda'] },
    { category: 'HORÁRIO', text: 'Atendem de manhã?', expected: ['manhã', 'tarde'] },
    
    // 👤 HUMANO
    { category: 'HUMANO', text: 'Quero falar com atendente', expected: ['humano', 'atendente', 'equipe'] },
    { category: 'HUMANO', text: 'Tem alguém online?', expected: ['equipe', 'atendimento'] },
];

// ============================================
// FUNÇÕES
// ============================================

async function createLead(phone) {
    await Leads.findOneAndDelete({ phone });
    await ChatContext.deleteOne({ lead: { $in: await Leads.find({ phone }).distinct('_id') } });
    return await Leads.create({
        name: `Teste ${phone}`, phone, source: 'test_all',
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

function validate(text, expected) {
    const errors = [];
    const lower = text.toLowerCase();
    
    for (const exp of expected) {
        // Regex para match parcial
        const patterns = {
            'acolhimento': /oi!|bem-vindo|que bom|seja bem/i,
            'queixa': /situação|preocupa|queixa|dificuldade/i,
            'preço': /preço|valor|investimento|custa/i,
            'fono': /fono|fala|comunicação/i,
            'psico': /psico|emocional|comportamento/i,
            'neuro': /neuro|tdah|autismo|avaliação/i,
            'endereço': /endereço|ficamos|minas gerais|anápolis/i,
            'particular': /particular|convênio|plano/i,
            'manhã': /manhã|tarde|horário/i,
            'humano': /equipe|atendente|humano/i,
        };
        
        const pattern = patterns[exp.toLowerCase()] || new RegExp(exp, 'i');
        if (!pattern.test(lower)) {
            errors.push(`faltou: "${exp}"`);
        }
    }
    
    return errors;
}

async function runTest(testCase, index) {
    const phone = `55628888${String(index).padStart(4, '0')}`;
    let lead;
    
    try {
        lead = await createLead(phone);
        const response = await sendMessage(lead, testCase.text);
        const errors = validate(response, testCase.expected);
        
        return {
            passed: errors.length === 0,
            text: testCase.text,
            response: response.substring(0, 100) + (response.length > 100 ? '...' : ''),
            category: testCase.category,
            errors
        };
    } finally {
        if (lead) await cleanup(lead._id);
    }
}

// ============================================
// EXECUÇÃO
// ============================================

async function main() {
    log(c.cyan, `\n╔══════════════════════════════════════════════════════════════════════╗`);
    log(c.cyan, `║     🧪 TESTE COMPLETO - TODOS OS TIPOS DE MENSAGEM                  ║`);
    log(c.cyan, `╚══════════════════════════════════════════════════════════════════════╝\n`);
    
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        log(c.green, '✅ MongoDB conectado\n');
    } catch (err) {
        log(c.red, '❌ MongoDB:', err.message);
        process.exit(1);
    }
    
    const results = [];
    let passed = 0, failed = 0;
    
    for (let i = 0; i < TEST_CASES.length; i++) {
        const test = TEST_CASES[i];
        const result = await runTest(test, i);
        results.push(result);
        
        const color = result.passed ? c.green : c.red;
        const icon = result.passed ? '✅' : '❌';
        
        log(color, `${icon} [${test.category}] "${test.text}"`);
        log(c.gray, `   → ${result.response}`);
        
        if (!result.passed) {
            log(c.red, `   ⚠️ ${result.errors.join(', ')}`);
            failed++;
        } else {
            passed++;
        }
        console.log('');
    }
    
    // Resumo
    log(c.cyan, `${'═'.repeat(70)}`);
    log(c.cyan, `📊 RESUMO FINAL`);
    log(c.cyan, `${'═'.repeat(70)}`);
    log(c.green, `✅ Passaram: ${passed}/${TEST_CASES.length}`);
    log(c.red, `❌ Falharam: ${failed}/${TEST_CASES.length}`);
    
    // Agrupa falhas por categoria
    if (failed > 0) {
        const byCategory = {};
        results.filter(r => !r.passed).forEach(r => {
            byCategory[r.category] = (byCategory[r.category] || 0) + 1;
        });
        
        log(c.red, `\n📋 Falhas por categoria:`);
        Object.entries(byCategory).forEach(([cat, count]) => {
            log(c.red, `   • ${cat}: ${count} falha(s)`);
        });
    }
    
    // Lista falhas detalhadas
    const criticalFails = results.filter(r => !r.passed && 
        ['PREÇO', 'AGENDAMENTO', 'FLUXO'].includes(r.category)
    );
    
    if (criticalFails.length > 0) {
        log(c.red, `\n🔥 FALHAS CRÍTICAS (precisam de atenção):`);
        criticalFails.forEach(f => {
            log(c.red, `   ❌ "${f.text}"`);
            log(c.red, `      → ${f.errors.join(', ')}`);
        });
    }
    
    if (failed === 0) {
        log(c.green, `\n🎉 TODOS OS ${TEST_CASES.length} TESTES PASSARAM!`);
        log(c.green, `🚀 O novo orquestrador está pronto!`);
    } else {
        log(c.yellow, `\n⚠️ ${failed} teste(s) falharam.`);
        log(c.yellow, `🔧 Revise as falhas antes de subir.`);
    }
    
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

main();
