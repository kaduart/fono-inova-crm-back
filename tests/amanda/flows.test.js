#!/usr/bin/env node
/**
 * 🧪 AMANDA FLOW TESTS - Enterprise Test Suite
 * 
 * Esta suite de testes valida que a Amanda funciona corretamente
 * em MÚLTIPLOS caminhos e ordens de conversa, não engessando em
 * uma única sequência.
 * 
 * FILOSOFIA: Testar BEHAVIOR (comportamento) não SEQUENCE (sequência)
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { WhatsAppOrchestrator } from '../../orchestrators/WhatsAppOrchestrator.js';
import Leads from '../../models/Leads.js';
import ChatContext from '../../models/ChatContext.js';
import { redisConnection } from '../../config/redisConnection.js';

const orchestrator = new WhatsAppOrchestrator();

// Cores
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function log(color, message) {
    console.log(`${color}${message}${c.reset}`);
}

// ============================================
// 🎯 TEST FRAMEWORK ENTERPRISE
// ============================================

class AmandaTestFramework {
    constructor() {
        this.results = [];
        this.currentLead = null;
    }

    async createLead(phone) {
        await Leads.findOneAndDelete({ phone });
        await ChatContext.deleteOne({ lead: { $in: await Leads.find({ phone }).distinct('_id') } });
        
        this.currentLead = await Leads.create({
            name: `Teste ${phone}`,
            phone: phone,
            source: 'test_script',
            stage: 'novo',
            autoReplyEnabled: true,
            qualificationData: { extractedInfo: {} }
        });
        return this.currentLead;
    }

    async sendMessage(text) {
        const result = await orchestrator.process({
            lead: this.currentLead,
            message: { content: text },
            context: { source: 'whatsapp-inbound' },
            services: {}
        });
        return result?.payload?.text || result?.text || '';
    }

    async cleanup() {
        if (this.currentLead) {
            await Leads.findByIdAndDelete(this.currentLead._id);
            await ChatContext.deleteOne({ lead: this.currentLead._id });
        }
    }

    // 🎯 BEHAVIOR VALIDATION - Não depende de sequência específica
    assertBehavior(response, expectations) {
        const errors = [];
        
        // Deve conter pelo menos um dos textos esperados
        if (expectations.shouldContainOneOf) {
            const found = expectations.shouldContainOneOf.some(phrase => 
                response.toLowerCase().includes(phrase.toLowerCase())
            );
            if (!found) {
                errors.push(`❌ Nenhum dos textos esperados encontrado: [${expectations.shouldContainOneOf.join(', ')}]`);
            }
        }
        
        // NÃO deve conter nenhum dos textos proibidos
        if (expectations.shouldNotContain) {
            for (const phrase of expectations.shouldNotContain) {
                if (response.toLowerCase().includes(phrase.toLowerCase())) {
                    errors.push(`🚫 Texto proibido encontrado: "${phrase}"`);
                }
            }
        }
        
        // Deve corresponder ao padrão regex
        if (expectations.shouldMatch) {
            if (!expectations.shouldMatch.test(response)) {
                errors.push(`❌ Não corresponde ao padrão esperado: ${expectations.shouldMatch}`);
            }
        }
        
        return { pass: errors.length === 0, errors };
    }
}

// ============================================
// 🎭 CENÁRIOS DE TESTE ENTERPRISE
// ============================================

const BEHAVIORAL_TESTS = [
    {
        id: 'FIRST_CONTACT_PRICE',
        name: '💰 Primeiro Contato - Pergunta Preço',
        description: 'Lead pergunta preço na primeira mensagem',
        phone: '556299991111',
        // 🔥 MÚLTIPLOS CAMINHOS possíveis - não engessado
        variations: [
            {
                name: 'Pergunta direta preço',
                messages: ['Quanto custa?'],
            },
            {
                name: 'Pergunta com contexto',
                messages: ['Tá quanto uma consulta com a fono?'],
            },
            {
                name: 'Pergunta valor avaliação',
                messages: ['Qual o valor da avaliação?'],
            }
        ],
        // 🎯 COMPORTAMENTO ESPERADO (independente da sequência)
        expectations: {
            firstResponse: {
                shouldContainOneOf: [
                    'situação', 'queixa', 'o que te preocupa',
                    'fono', 'fonoaudiologia', 'R$ 220'
                ],
                shouldNotContain: [
                    'qual a idade', 'idade do paciente'
                ]
            }
        }
    },
    {
        id: 'FIRST_CONTACT_GREETING',
        name: '👋 Primeiro Contato - Saudação',
        description: 'Lead apenas cumprimenta',
        phone: '556299992222',
        variations: [
            { name: 'Oi simples', messages: ['Oi'] },
            { name: 'Bom dia', messages: ['Bom dia'] },
            { name: 'Olá formal', messages: ['Olá, tudo bem?'] }
        ],
        expectations: {
            firstResponse: {
                shouldContainOneOf: ['situação', 'queixa', 'o que te preocupa'],
                shouldNotContain: ['qual a idade']
            }
        }
    },
    {
        id: 'CONTEXT_PRESERVATION',
        name: '🔄 Preservação de Contexto',
        description: 'Dados informados devem ser lembrados',
        phone: '556299993333',
        variations: [
            {
                name: 'Queixa → Idade → Período',
                messages: [
                    { text: 'Oi', validate: 'first' },
                    { text: 'Meu filho não fala direito', validate: 'therapy_or_age' },
                    { text: '5 anos', validate: 'age_acknowledged' },
                    { text: 'Quanto custa?', validate: 'no_repeat_age' }
                ]
            }
        ],
        expectations: {
            // Validação por etapa, não por posição fixa
            validations: {
                first: {
                    shouldContainOneOf: ['situação', 'queixa']
                },
                therapy_or_age: {
                    shouldContainOneOf: ['fono', 'idade', 'anos'],
                    shouldNotContain: ['situação']
                },
                age_acknowledged: {
                    shouldContainOneOf: ['manhã', 'tarde', 'período'],
                    shouldNotContain: ['qual a idade', 'idade do paciente']
                },
                no_repeat_age: {
                    shouldContainOneOf: ['R$', 'valor', 'investimento', 'avaliação'],
                    shouldNotContain: ['qual a idade', 'idade do paciente']
                }
            }
        }
    },
    {
        id: 'MULTIPLE_THERAPIES',
        name: '🎯 Detecção de Múltiplas Terapias',
        description: 'Quando menciona várias especialidades, deve reconhecer e direcionar',
        phone: '556299994444',
        variations: [
            {
                name: 'Fono e psico',
                messages: ['Preciso de fono e psico'],
            },
            {
                name: 'Todas as áreas',
                messages: ['Vocês atendem todas as áreas?'],
            }
        ],
        expectations: {
            firstResponse: {
                // 🔥 FLEXÍVEL: Amanda pode perguntar especialidade OU já identificar uma
                shouldContainOneOf: [
                    'qual especialidade', 'qual área', 
                    'fono', 'psicologia', 'fonoaudiologia',
                    'terapia', 'atendemos', 'situação', 'queixa'
                ],
                shouldNotContain: ['erro', 'desculpe', 'tive um problema']
            }
        }
    },
    {
        id: 'ADDRESS_QUESTION',
        name: '📍 Pergunta Endereço',
        description: 'Lead pergunta onde fica a clínica',
        phone: '556299995555',
        variations: [
            { name: 'Onde fica', messages: ['Onde fica a clínica?'] },
            { name: 'Endereço', messages: ['Qual o endereço?'] },
            { name: 'Como chegar', messages: ['Como chego aí?'] }
        ],
        expectations: {
            firstResponse: {
                shouldContainOneOf: [
                    'Av. Minas Gerais', 'Anápolis', 
                    'Jundiaí', 'endereço'
                ]
            }
        }
    },
    {
        id: 'INSURANCE_QUESTION',
        name: '🏥 Pergunta Convênio',
        description: 'Lead pergunta sobre plano de saúde',
        phone: '556299996666',
        variations: [
            { name: 'Unimed', messages: ['Vocês aceitam Unimed?'] },
            { name: 'Plano', messages: ['Atende por convênio?'] }
        ],
        expectations: {
            firstResponse: {
                shouldContainOneOf: [
                    'particular', 'convênio', 'plano',
                    'não somos credenciados', 'privado'
                ]
            }
        }
    },
    {
        id: 'NO_REPEAT_QUESTIONS',
        name: '🔥 NUNCA Repetir Perguntas',
        description: 'Se já respondeu, NÃO pergunta de novo',
        phone: '556299997777',
        critical: true,
        variations: [
            {
                name: 'Não repetir idade',
                messages: [
                    { text: 'Oi meu filho tem 7 anos', validate: 'skip_age_check' },
                    { text: 'Quanto custa?', validate: 'no_age_repeat' }
                ]
            },
            {
                name: 'Não repetir período',
                messages: [
                    { text: 'Oi', validate: 'any' },
                    { text: 'Meu filho não fala', validate: 'any' },
                    { text: '5 anos', validate: 'any' },
                    { text: 'Manhã', validate: 'period_acknowledged' },
                    { text: 'Quais horários?', validate: 'no_period_repeat' }
                ]
            }
        ],
        expectations: {
            validations: {
                skip_age_check: {
                    shouldContainOneOf: ['fono', 'psico', 'situação', 'anos']
                },
                no_age_repeat: {
                    shouldNotContain: ['qual a idade', 'idade do paciente', 'quantos anos'],
                    shouldContainOneOf: ['R$', 'valor', 'custa', 'preço']
                },
                period_acknowledged: {
                    shouldNotContain: ['manhã ou tarde', 'qual período']
                },
                no_period_repeat: {
                    shouldNotContain: ['manhã ou tarde', 'qual período', 'prefere']
                }
            }
        }
    }
];

// ============================================
// 🚀 EXECUÇÃO DOS TESTES
// ============================================

async function runBehavioralTest(test, framework) {
    log(c.magenta, `\n🎭 ${test.name}`);
    log(c.cyan, `📱 ${test.phone}`);
    log(c.yellow, `📝 ${test.description}`);
    log(c.magenta, `══════════════════════════════════════════════════════════════════════`);

    let allPassed = true;
    let allErrors = [];

    for (const variation of test.variations) {
        log(c.reset, `\n  📦 Variação: ${variation.name}`);
        
        try {
            await framework.createLead(test.phone + '_' + Math.random().toString(36).substr(2, 5));
            
            const responses = [];
            
            for (let i = 0; i < variation.messages.length; i++) {
                const msg = variation.messages[i];
                const text = typeof msg === 'string' ? msg : msg.text;
                const validationKey = typeof msg === 'object' ? msg.validate : null;
                
                log(c.blue, `  👤 Cliente: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
                
                const response = await framework.sendMessage(text);
                responses.push({ text, response });
                
                log(c.green, `  🤖 Amanda: "${response.substring(0, 80)}${response.length > 80 ? '...' : ''}"`);
                
                // Validação por etapa se definida
                if (validationKey && test.expectations?.validations?.[validationKey]) {
                    const result = framework.assertBehavior(response, test.expectations.validations[validationKey]);
                    if (!result.pass) {
                        log(c.red, `  ❌ Falha na validação '${validationKey}':`);
                        result.errors.forEach(e => log(c.red, `     ${e}`));
                        allErrors.push(...result.errors.map(e => `${variation.name}: ${e}`));
                        allPassed = false;
                    } else {
                        log(c.green, `  ✅ Validação '${validationKey}' passou`);
                    }
                }
            }
            
            // Validação geral da primeira resposta
            if (test.expectations?.firstResponse && variation.messages.length > 0) {
                const firstResponse = responses[0].response;
                const result = framework.assertBehavior(firstResponse, test.expectations.firstResponse);
                
                if (!result.pass) {
                    log(c.red, `  ❌ Falha na validação geral:`);
                    result.errors.forEach(e => log(c.red, `     ${e}`));
                    allErrors.push(...result.errors.map(e => `${variation.name}: ${e}`));
                    allPassed = false;
                } else {
                    log(c.green, `  ✅ Validação geral passou`);
                }
            }
            
        } catch (error) {
            log(c.red, `  💥 Erro: ${error.message}`);
            allErrors.push(`${variation.name}: ${error.message}`);
            allPassed = false;
        } finally {
            await framework.cleanup();
        }
    }

    return { passed: allPassed, errors: allErrors };
}

// ============================================
// 🎬 MAIN EXECUTION
// ============================================

async function main() {
    console.log(`${c.cyan} 
╔══════════════════════════════════════════════════════════════════════╗
║         🧪 AMANDA ENTERPRISE TEST SUITE                              ║
║         Validação de Comportamento (NÃO Sequência)                   ║
╚══════════════════════════════════════════════════════════════════════╝
 ${c.reset}`);

    // Conecta ao MongoDB
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/fono-inova');
        log(c.green, '✅ MongoDB conectado');
    } catch (err) {
        log(c.red, `❌ MongoDB erro: ${err.message}`);
        process.exit(1);
    }

    const framework = new AmandaTestFramework();
    const results = [];

    for (const test of BEHAVIORAL_TESTS) {
        const result = await runBehavioralTest(test, framework);
        results.push({ name: test.name, id: test.id, ...result });
    }

    // Relatório final
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`\n${c.cyan} ══════════════════════════════════════════════════════════════════════ ${c.reset}`);
    console.log(`${c.cyan} 📊 RESULTADO FINAL ${c.reset}`);
    console.log(`${c.cyan} ══════════════════════════════════════════════════════════════════════ ${c.reset}`);
    console.log(`${c.green} ✅ Passaram: ${passed}/${results.length} ${c.reset}`);
    console.log(`${c.red} ❌ Falharam: ${failed}/${results.length} ${c.reset}`);

    if (failed === 0) {
        console.log(`${c.green} 
🎉 TODOS OS TESTES PASSARAM! ${c.reset}`);
        console.log(`${c.green} 🚀 Amanda está pronta para produção! ${c.reset}\n`);
    } else {
        console.log(`${c.red} 
⚠️ ${failed} TESTE(S) COM PROBLEMA! ${c.reset}`);
        console.log(`${c.yellow} 🔧 Corrija antes de subir para produção. ${c.reset}\n`);
        
        results.filter(r => !r.passed).forEach(r => {
            console.log(`${c.red} ❌ ${r.name} ${c.reset}`);
            r.errors.forEach(e => console.log(`${c.red}    • ${e} ${c.reset}`));
        });
        console.log();
    }

    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

main();
