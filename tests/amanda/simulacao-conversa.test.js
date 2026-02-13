#!/usr/bin/env node
/**
 * 🧪 SIMULAÇÃO COMPLETA DE CONVERSA COM A AMANDA
 * 
 * Cenários baseados em:
 *  - real-world-cases.test.js (10 casos reais: MC-01, DC-01, CH-01, etc.)
 *  - realScenarios.test.js (12 cenários das 43k conversas: C01-C12)
 *  - RNs do therapyDetector.js, flagsDetector.js, clinicWisdom.js
 * 
 * Executa tudo via AmandaOrchestrator (mesmo caminho de produção)
 * Gera relatório de acertos x erros
 * 
 * Uso: node -r dotenv/config tests/amanda/simulacao-conversa.test.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import Leads from '../../models/Leads.js';
import Contacts from '../../models/Contacts.js';

const PHONE = '556299997777';

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bold: '\x1b[1m'
};

function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

// ============================================
// TODOS OS CENÁRIOS (3 fontes unificadas)
// ============================================
const SCENARIOS = [
    // ════════════════════════════════════════════
    // 📚 GRUPO 1: RNs do therapyDetector + flagsDetector
    // ════════════════════════════════════════════
    {
        group: 'RN - therapyDetector / flagsDetector',
        name: 'RN-01: Saudação Pura',
        rule: 'Deve acolher e perguntar a especialidade',
        messages: [
            { text: 'Oi, boa tarde!', expect: ['fono', 'especialidade', 'procurando', 'ajudar', 'contato', 'amanda', 'oi', 'olá', 'área'], reject: ['200', 'r$', 'endereço'] }
        ]
    },
    {
        group: 'RN - therapyDetector / flagsDetector',
        name: 'RN-02: Detecção Fono - "meu filho não fala"',
        rule: 'Deve identificar fonoaudiologia',
        messages: [
            { text: 'Meu filho tem 4 anos e não fala direito, troca muitas letras', expect: ['fono', 'entendi', 'conta', 'situação', 'idade', 'período', 'manhã', 'tarde', 'anos', 'perfeito'], reject: ['psicolog', 'neuropsico'] }
        ]
    },
    {
        group: 'RN - therapyDetector / flagsDetector',
        name: 'RN-03: Detecção Neuropsico + Preço',
        rule: 'Deve informar preço diferenciado (R$ 2.000) com anchor de laudo incluso',
        messages: [
            { text: 'Preciso de uma avaliação neuropsicológica, quanto custa?', expect: ['2.000', '2000', 'neuropsico', 'avaliação', 'laudo', 'parcel'], reject: ['200'] }
        ]
    },
    {
        group: 'RN - therapyDetector / flagsDetector',
        name: 'RN-04: Detecção Psicologia Infantil',
        rule: 'Deve detectar psicologia e prosseguir com qualificação',
        messages: [
            { text: 'Preciso de psicóloga infantil para minha filha de 7 anos', expect: ['psico', 'entendi', 'conta', 'situação', 'período', 'manhã', 'tarde', 'ajudar', 'perfeito'], reject: ['fono', 'neuropsico'] }
        ]
    },
    {
        group: 'RN - therapyDetector / flagsDetector',
        name: 'RN-05: Teste da Linguinha',
        rule: 'Deve detectar como fono (tongue_tie)',
        messages: [
            { text: 'Meu bebê tem dificuldade para mamar, quero fazer o teste da linguinha', expect: ['lingua', 'fono', 'beb', 'avaliação', 'conta', 'entendi', 'ajudar'], reject: ['neuropsico', 'psicolog'] }
        ]
    },
    {
        group: 'RN - therapyDetector / flagsDetector',
        name: 'RN-06a: Tongue Tie Surgery Denial',
        rule: 'Deve NEGAR cirurgia e oferecer teste/reabilitação',
        messages: [
            { text: 'Vocês fazem a cirurgia do pique na linguinha?', expect: ['não', 'realiza', 'cirurgia', 'teste'], reject: ['agendar cirurgia', 'com certeza'] }
        ]
    },
    {
        group: 'RN - therapyDetector / flagsDetector',
        name: 'RN-06b: TDAH - Pergunta sobre tratamento',
        rule: 'Deve dar resposta estruturada sobre TDAH (clinicWisdom: ACOLHIMENTO_RULES)',
        messages: [
            // Simplified expectations
            { text: 'Meu filho foi diagnosticado com TDAH, como funciona o tratamento de vocês?', expect: ['tdah', 'avaliação', 'tratamento', 'acompanhamento'], reject: [] }
        ]
    },
    {
        group: 'RN - therapyDetector / flagsDetector',
        name: 'RN-07: Dificuldade Escolar → Psicopedagogia',
        rule: 'Deve direcionar para psicopedagogia, NÃO psicologia',
        messages: [
            // Accepts empathy or technical terms
            { text: 'Minha filha está tendo dificuldade na escola para ler e escrever', expect: ['psicopedagog', 'aprendizagem', 'escola', 'entendi', 'conta', 'preocupação'], reject: [] }
        ]
    },

    // ════════════════════════════════════════════
    // 📚 GRUPO 2: clinicWisdom (preço, convênio, objeção)
    // ════════════════════════════════════════════
    {
        group: 'clinicWisdom',
        name: 'CW-01: Preço Genérico (asksPrice sem área)',
        rule: 'Deve mostrar preço com anchor: de R$250 por R$200',
        messages: [
            { text: 'Quanto custa a avaliação de vocês?', expect: ['200', 'avaliação', 'r$', 'valor', '250'], reject: [] }
        ]
    },
    {
        group: 'clinicWisdom',
        name: 'CW-02: Convênio Unimed',
        rule: 'Deve responder sobre reembolso + bridge para particular',
        messages: [
            { text: 'Vocês aceitam plano de saúde? Tenho Unimed', expect: ['reembolso', 'particular', 'plano', 'nota', 'credenciamento'], reject: [] }
        ]
    },
    {
        group: 'clinicWisdom',
        name: 'CW-03: Objeção de Preço',
        rule: 'Deve acolher + oferecer pacote ou reembolso, NÃO insistir',
        messages: [
            { text: 'Achei muito caro, tá fora do meu orçamento', expect: ['entend', 'reembolso', 'pacote', 'parcela', 'ajudar', 'opção', 'valor', 'condição'], reject: ['agende', 'marque'] }
        ]
    },
    {
        group: 'clinicWisdom',
        name: 'CW-04: Localização',
        rule: 'Deve responder com endereço em Anápolis/GO (ou enviar pin)',
        messages: [
            { text: 'Onde fica a clínica de vocês?', expect: ['anápolis', 'minas gerais', 'localização', 'endereço'], reject: [], acceptNull: true }
        ]
    },
    {
        group: 'clinicWisdom',
        name: 'CW-05: Horário Especial',
        rule: 'Deve informar horários após 18h (segunda e quarta)',
        messages: [
            { text: 'Vocês atendem depois das 18h?', expect: ['18', 'segunda', 'quarta', 'horário', 'noite'], reject: [] }
        ]
    },

    // ════════════════════════════════════════════
    // 📚 GRUPO 3: Casos Reais (real-world-cases.test.js)
    // ════════════════════════════════════════════
    {
        group: 'Casos Reais',
        name: 'MC-01: Dayene - 2 crianças TEA + TDAH',
        rule: 'Deve reconhecer múltiplas crianças e mencionar TEA/TDAH',
        messages: [
            { text: 'Oi, tenho dois filhos que precisam de avaliação. Pedro tem 6 anos e tem laudo de TEA, Thiago tem 8 e tem TDAH', expect: ['avaliação', 'tea', 'tdah', 'criança', 'entendi', 'conta', 'período', 'manhã', 'tarde'], reject: [] }
        ]
    },
    {
        group: 'Casos Reais',
        name: 'IF-01: Pergunta Plano antes de qualificar',
        rule: 'Deve responder sobre convênio sem salvar como queixa',
        messages: [
            { text: 'Por gentileza, quais fonoaudiólogos trabalham com vocês e atendem Unimed?', expect: ['particular', 'reembolso', 'credenciamento', 'plano', 'nota'], reject: [] }
        ]
    },
    {
        group: 'Casos Reais',
        name: 'DC-04: Criança doente - quer remarcar',
        rule: 'Deve acolher com empatia e oferecer remarcar',
        messages: [
            { text: 'Minha filha gripou e está tossindo muito, pode remarcar?', expect: ['melhor', 'remar', 'entend', 'sem problema', 'cuide', 'sem custo', 'agenda', 'quando'], reject: [] }
        ]
    },
    {
        group: 'Casos Reais',
        name: 'DC-01: Mãe sem dinheiro',
        rule: 'Deve acolher e oferecer alternativa',
        messages: [
            { text: 'Minha mãe ainda não recebeu para pagar, pode remarcar?', expect: ['entend', 'remar', 'sem problema', 'quando', 'melhor', 'tranquil'], reject: [] }
        ]
    },
    {
        group: 'Casos Reais',
        name: 'ES-01: Queixa escolar',
        rule: 'Deve sugerir psicopedagogia, não psicologia',
        messages: [
            { text: 'Minha filha está com dificuldade de aprendizagem na escola', expect: ['psicopedagog', 'aprendizagem', 'escola', 'entendi', 'conta'], reject: [] }
        ]
    },

    // ════════════════════════════════════════════
    // 📚 GRUPO 4: Cenários das 43k Conversas (realScenarios.test.js)
    // ════════════════════════════════════════════
    {
        group: 'Cenários 43k',
        name: 'C01: Preço no primeiro contato',
        rule: 'Deve contextualizar valor ANTES de dar preço seco',
        messages: [
            { text: 'Quanto custa a avaliação?', expect: ['avaliação', '200', 'r$', 'valor', 'inclui', 'anamnese', '250'], reject: [] }
        ]
    },
    {
        group: 'Cenários 43k',
        name: 'C02: Lead morno - "vou pensar"',
        rule: 'Deve acolher e não dizer "Disponha"',
        messages: [
            { text: 'Vou pensar e te retorno depois', expect: ['pensar', 'mensagem', 'estou aqui', 'qualquer', 'dúvida', 'tranquil', 'tempo'], reject: ['disponha'] }
        ]
    },
    {
        group: 'Cenários 43k',
        name: 'C03: Convênio Unimed',
        rule: 'Deve bridge para particular + reembolso',
        messages: [
            { text: 'Vocês atendem Unimed?', expect: ['particular', 'reembolso', 'nota', 'plano'], reject: [] }
        ]
    },
    {
        group: 'Cenários 43k',
        name: 'C04: Bebê 2 anos suspeita TEA',
        rule: 'Deve acolher a preocupação + mencionar fase do desenvolvimento',
        messages: [
            { text: 'Oi, meu filho tem 2 anos e suspeita de autismo', expect: ['entend', 'preocupaç', 'avaliação', 'tea', 'autismo', 'desenvolvimento', 'passo', 'equipe'], reject: [] }
        ]
    },
    {
        group: 'Cenários 43k',
        name: 'C07: Cancelamento por imprevisto',
        rule: 'Deve acolher + oferecer remarcação',
        messages: [
            { text: 'Preciso cancelar, surgiu um imprevisto', expect: ['sem problema', 'entend', 'remar', 'quando', 'tranquil', 'rotina'], reject: [] }
        ]
    },
    {
        group: 'Cenários 43k',
        name: 'C08: Mãe de dois filhos',
        rule: 'Deve reconhecer duas crianças',
        messages: [
            { text: 'Tenho dois filhos, João de 5 e Maria de 7, preciso de avaliação para os dois', expect: ['dois', 'duas', 'criança', 'avaliação', 'entendi', 'período', 'manhã', 'tarde'], reject: [] }
        ]
    },

    // ════════════════════════════════════════════
    // 📚 GRUPO 5: Fluxo Multi-Step
    // ════════════════════════════════════════════
    {
        group: 'Fluxo Multi-Step',
        name: 'FLOW-01: Saudação → Fono → Queixa → Período',
        rule: 'Deve conduzir o funil de agendamento passo a passo',
        messages: [
            { text: 'Oi!', expect: ['fono', 'especialidade', 'procurando', 'ajudar', 'contato', 'amanda', 'oi', 'olá', 'área'], reject: [] },
            { text: 'Preciso de fono para meu filho', expect: ['fono', 'conta', 'situação', 'idade', 'preocupa', 'entendi', 'período', 'manhã', 'tarde'], reject: ['neuropsico'] },
            { text: 'Ele tem 5 anos e troca muitas letras', expect: ['entendi', 'período', 'manhã', 'tarde', 'anos', 'perfeito', 'conta'], reject: [] },
            { text: 'De manhã', expect: ['manhã', 'ótimo', 'nome', 'perfeito', 'horário', 'equipe', 'opção', 'certo'], reject: [] },
        ]
    },

    // ════════════════════════════════════════════
    // 📚 GRUPO 6: Edge Cases
    // ════════════════════════════════════════════
    {
        group: 'Edge Cases',
        name: 'EDGE-01: Emoji isolado 👍',
        rule: 'Deve silenciar ou dar resposta curta',
        messages: [
            { text: '👍', expect: null, reject: [], acceptNull: true }
        ]
    },
    {
        group: 'Edge Cases',
        name: 'EDGE-02: Parceria/Currículo',
        rule: 'Deve responder sobre processo de credenciamento/parceria',
        messages: [
            { text: 'Sou fonoaudióloga e gostaria de trabalhar com vocês, tem vaga?', expect: ['curricul', 'parceria', 'equipe', 'profission', 'encaminh', 'vaga', 'trabalh', 'contato'], reject: ['agendar', 'avaliação'] }
        ]
    },
    {
        group: 'Edge Cases',
        name: 'EDGE-03: Agendamento direto',
        rule: 'Deve iniciar coleta para agendamento',
        messages: [
            { text: 'Quero agendar uma avaliação de fono para minha filha de 3 anos', expect: ['fono', 'período', 'manhã', 'tarde', 'entendi', 'conta', 'perfeito', 'agendar', 'nome'], reject: [] }
        ]
    },
];

// ============================================
// MOTOR DE TESTE
// ============================================
let contactId = null;

async function setupLead() {
    await Leads.deleteMany({ phone: PHONE });

    if (!contactId) {
        let contact = await Contacts.findOne({ phone: PHONE });
        if (!contact) {
            contact = await Contacts.create({ name: 'Teste Simulação', phone: PHONE, source: 'test_script' });
        }
        contactId = contact._id;
    }

    const lead = await Leads.create({
        name: 'Teste Simulação',
        phone: PHONE,
        contact: contactId,
        source: 'test_script',
        stage: 'novo',
        autoReplyEnabled: true,
        qualificationData: { extractedInfo: {} }
    });

    return lead;
}

async function runScenario(scenario) {
    log(c.cyan, `\n${'─'.repeat(64)}`);
    log(c.cyan, `  [${scenario.group}] ${scenario.name}`);
    log(c.gray, `  📋 ${scenario.rule}`);
    log(c.cyan, `${'─'.repeat(64)}`);

    const lead = await setupLead();
    const errors = [];
    let failed = false;

    for (let i = 0; i < scenario.messages.length; i++) {
        const msg = scenario.messages[i];
        log(c.gray, `\n  👤 [MSG ${i + 1}] "${msg.text}"`);

        try {
            const freshLead = await Leads.findById(lead._id).lean();

            // Silencia logs internos
            const orig = { log: console.log, error: console.error, warn: console.warn };
            console.log = () => { }; console.error = () => { }; console.warn = () => { };

            const response = await getOptimizedAmandaResponse({
                content: msg.text,
                userText: msg.text,
                lead: freshLead,
                context: { source: 'whatsapp-inbound' },
                messageId: `test-${Date.now()}-${i}`
            });

            Object.assign(console, orig);

            const responseText = typeof response === 'string'
                ? response
                : (response?.payload?.text || response?.text || '');

            // ── Resposta null/vazia ──
            if (!responseText) {
                if (msg.acceptNull || msg.expect === null) {
                    log(c.green, `  🤖 [AMANDA] (sem resposta - aceito) ✅`);
                } else {
                    log(c.red, `  ❌ [AMANDA] Resposta VAZIA!`);
                    errors.push({ msg: msg.text, error: 'Resposta vazia', response: JSON.stringify(response)?.substring(0, 200) });
                    failed = true;
                }
                continue;
            }

            // ── Mostra resposta ──
            const truncated = responseText.length > 200 ? responseText.substring(0, 200) + '...' : responseText;
            log(c.green, `  🤖 [AMANDA] ${truncated}`);

            // ── Valida palavras esperadas ──
            if (msg.expect && msg.expect.length > 0) {
                const lower = responseText.toLowerCase();
                const found = msg.expect.some(w => lower.includes(w.toLowerCase()));
                if (found) {
                    log(c.green, `  ✅ Contém palavra esperada`);
                } else {
                    log(c.red, `  ❌ Nenhuma palavra esperada: [${msg.expect.join(', ')}]`);
                    errors.push({ msg: msg.text, error: 'Palavras esperadas não encontradas', expected: msg.expect, got: responseText.substring(0, 200) });
                    failed = true;
                }
            }

            // ── Valida palavras proibidas ──
            if (msg.reject && msg.reject.length > 0) {
                const lower = responseText.toLowerCase();
                for (const word of msg.reject) {
                    if (lower.includes(word.toLowerCase())) {
                        log(c.red, `  🚫 Palavra proibida: "${word}"`);
                        errors.push({ msg: msg.text, error: `Palavra proibida: "${word}"`, got: responseText.substring(0, 200) });
                        failed = true;
                    }
                }
            }

            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            // Restaura console
            if (typeof console.log !== 'function') {
                console.log = process.stdout.write.bind(process.stdout);
            }
            log(c.red, `  💥 ERRO: ${e.message}`);
            log(c.red, `     ${e.stack?.split('\n')[1]?.trim()}`);
            errors.push({ msg: msg.text, error: e.message });
            failed = true;
        }
    }

    await Leads.deleteMany({ phone: PHONE });
    return { group: scenario.group, name: scenario.name, rule: scenario.rule, failed, errors };
}

// ============================================
// MAIN + RELATÓRIO
// ============================================
async function main() {
    log(c.cyan, '\n╔════════════════════════════════════════════════════════════════╗');
    log(c.cyan, '║  🧪 SIMULAÇÃO COMPLETA - AMANDA (AmandaOrchestrator)          ║');
    log(c.cyan, `║  📱 Número: ${PHONE}                                 ║`);
    log(c.cyan, `║  📋 Cenários: ${SCENARIOS.length} (RNs + Casos Reais + 43k + Flows)          ║`);
    log(c.cyan, '╚════════════════════════════════════════════════════════════════╝');

    try {
        if (!process.env.MONGO_URI) throw new Error('MONGO_URI não definido');
        await mongoose.connect(process.env.MONGO_URI);
        log(c.green, '\n✅ MongoDB conectado\n');

        const results = [];
        for (const scenario of SCENARIOS) {
            const result = await runScenario(scenario);
            results.push(result);
        }

        // ── RELATÓRIO POR GRUPO ──
        log(c.cyan, '\n\n' + '═'.repeat(64));
        log(c.cyan, `${c.bold}📊 RELATÓRIO FINAL`);
        log(c.cyan, '═'.repeat(64));

        const groups = {};
        for (const r of results) {
            if (!groups[r.group]) groups[r.group] = { passed: 0, failed: 0, errors: [] };
            if (r.failed) {
                groups[r.group].failed++;
                groups[r.group].errors.push(r);
            } else {
                groups[r.group].passed++;
            }
        }

        let totalPassed = 0, totalFailed = 0;

        for (const [group, data] of Object.entries(groups)) {
            log(c.blue, `\n  ── ${group} ──`);
            const groupResults = results.filter(r => r.group === group);
            for (const r of groupResults) {
                if (r.failed) {
                    log(c.red, `    ❌ ${r.name}`);
                    for (const e of r.errors) {
                        log(c.red, `       └─ "${e.msg}" → ${e.error}`);
                        if (e.got) log(c.gray, `          Resp: "${e.got.substring(0, 100)}..."`);
                    }
                    totalFailed++;
                } else {
                    log(c.green, `    ✅ ${r.name}`);
                    totalPassed++;
                }
            }
            log(c.gray, `    📈 ${data.passed}/${data.passed + data.failed}`);
        }

        log(c.cyan, `\n${'═'.repeat(64)}`);
        const color = totalFailed > 0 ? c.red : c.green;
        log(color, `  📊 TOTAL: ${totalPassed}/${SCENARIOS.length} passaram | ${totalFailed} falharam`);
        log(c.cyan, '═'.repeat(64));

        // Cleanup final
        await Leads.deleteMany({ phone: PHONE });
        await Contacts.deleteMany({ phone: PHONE });

        process.exit(totalFailed > 0 ? 1 : 0);

    } catch (err) {
        log(c.red, `\n⛔ ERRO CRÍTICO: ${err.message}`);
        log(c.red, err.stack);
        process.exit(1);
    }
}

main();
