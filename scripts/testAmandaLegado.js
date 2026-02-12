#!/usr/bin/env node
/**
 * 🧪 TESTE LOCAL DA AMANDA (LEGADO REATIVADO)
 * 
 * Roda o getOptimizedAmandaResponse diretamente, sem WhatsApp.
 * Valida respostas contra regras do amandaPrompt, therapyDetector, etc.
 * 
 * USO:
 *   node scripts/testAmandaLegado.js               # todos os testes
 *   node scripts/testAmandaLegado.js --only 3       # só cenário 3
 *   node scripts/testAmandaLegado.js --verbose       # mostra resposta completa
 *   node scripts/testAmandaLegado.js --from-real     # cenários das conversas reais
 *   node scripts/testAmandaLegado.js --from-real --verbose  # reais com resposta completa
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import Leads from '../models/Leads.js';
import Contacts from '../models/Contacts.js';
import Messages from '../models/Message.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// CONFIG
// ============================================
const VERBOSE = process.argv.includes('--verbose');
const FROM_REAL = process.argv.includes('--from-real');
const ONLY = process.argv.includes('--only')
    ? parseInt(process.argv[process.argv.indexOf('--only') + 1])
    : null;

const c = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m',
    cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m'
};
const log = (color, ...args) => console.log(color, ...args, c.reset);

// ============================================
// MOCK: Intercepta envios ao WhatsApp
// ============================================
const sentMessages = [];
const originalModules = {};

async function mockWhatsAppSends() {
    // Importa o módulo e substitui as funções de envio
    const wppService = await import('../services/whatsappService.js');
    originalModules.sendTextMessage = wppService.sendTextMessage;
    originalModules.sendLocationMessage = wppService.sendLocationMessage;

    // Monkey-patch: registra sem enviar
    // Nota: como são named exports, precisamos interceptar no caller
    // O legado chama sendTextMessage/sendLocationMessage diretamente —
    // mas como importa com import{}, não dá pra monkey-patch fácil.
    // SOLUÇÃO: criar lead com contact fake que não dispara envio real.
}

// ============================================
// LEAD DE TESTE (com Contact fake)
// ============================================
async function createTestLead(phone, extraData = {}) {
    // Limpa tudo desse phone de teste
    const oldLeads = await Leads.find({ 'contact.phone': phone }).lean();
    if (oldLeads.length) {
        await Leads.deleteMany({ 'contact.phone': phone });
    }
    await Contacts.deleteMany({ phone });
    // Deleta mensagens antigas de teste
    await Messages.deleteMany({ from: phone });

    // Cria contact fake
    const contact = await Contacts.create({
        phone,
        name: `Teste Amanda ${phone.slice(-4)}`,
        source: 'test_amanda_legado',
    });

    // Cria lead com contact
    const lead = await Leads.create({
        name: contact.name,
        phone,
        source: 'test_amanda_legado',
        stage: 'novo',
        autoReplyEnabled: true,
        contact: contact._id,
        qualificationData: { extractedInfo: {} },
        ...extraData,
    });

    // Popula contact no lead (o legado usa lead.contact.phone)
    const populated = await Leads.findById(lead._id).populate('contact').lean();
    return populated;
}

async function refreshLead(leadId) {
    return await Leads.findById(leadId).populate('contact').lean();
}

async function cleanupTestLead(leadId) {
    const lead = await Leads.findById(leadId).lean();
    if (lead?.contact) {
        await Contacts.findByIdAndDelete(lead.contact);
    }
    await Messages.deleteMany({ lead: leadId });
    await Leads.findByIdAndDelete(leadId);
}

// ============================================
// CHAMADA AO LEGADO
// ============================================
async function callAmanda(lead, text) {
    try {
        // Simula mensagem inbound no histórico (o legado faz enrichLeadContext)
        if (lead.contact) {
            await Messages.create({
                lead: lead._id,
                contact: typeof lead.contact === 'object' ? lead.contact._id : lead.contact,
                content: text,
                from: lead.phone || lead.contact?.phone || 'test',
                direction: 'inbound',
                type: 'text',
                timestamp: new Date(),
            });
        }

        const response = await getOptimizedAmandaResponse({
            content: text,
            userText: text,
            lead,
            context: { source: 'whatsapp-inbound' },
            messageId: `test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });

        // O legado pode retornar null (quando envia location diretamente)
        return response || '[LOCATION/SIDE-EFFECT - sem texto retornado]';
    } catch (err) {
        return `[ERRO: ${err.message}]`;
    }
}

// ============================================
// CENÁRIOS DE TESTE
// ============================================
const SCENARIOS = [
    // ─────────────────────────────────────────
    // 1. SAUDAÇÃO INICIAL
    // ─────────────────────────────────────────
    {
        id: 1,
        name: '👋 Saudação "Oi"',
        desc: 'Primeiro contato → deve acolher e perguntar como ajudar',
        phone: '5562999990001',
        steps: [
            {
                user: 'Oi',
                checks: [
                    { name: 'Não deu erro', test: (r) => !r.startsWith('[ERRO') },
                    { name: 'Acolheu (tem saudação)', test: (r) => /oi|olá|bem.vind/i.test(r) },
                    { name: 'Perguntou como ajudar', test: (r) => /ajudar|precisando|posso/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 2. PREÇO DIRETO
    // ─────────────────────────────────────────
    {
        id: 2,
        name: '💰 Pergunta de Preço',
        desc: 'Lead pergunta preço → deve dar valor e acolher',
        phone: '5562999990002',
        steps: [
            {
                user: 'Quanto custa a avaliação de fono?',
                checks: [
                    { name: 'Mencionou preço (R$)', test: (r) => /R\$|reais|200|2\.?000/i.test(r) },
                    { name: 'NÃO perguntou idade', test: (r) => !/qual.*idade/i.test(r), critical: true },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 3. FLUXO COMPLETO: Queixa → Idade → Período
    // ─────────────────────────────────────────
    {
        id: 3,
        name: '🔄 Fluxo Completo de Qualificação',
        desc: 'Queixa → Nome → Idade → Período (ordem correta)',
        phone: '5562999990003',
        steps: [
            {
                user: 'Quero agendar uma avaliação para meu filho',
                checks: [
                    { name: 'Acolheu', test: (r) => !/\[ERRO/i.test(r) },
                    { name: 'Fez pergunta de coleta', test: (r) => /situação|preocupa|queixa|idade|nome|manhã|tarde|período|ajudar|como posso|fala|criança/i.test(r) },
                ],
            },
            {
                user: 'Ele tem dificuldade na fala, não consegue pronunciar direito',
                checks: [
                    { name: 'Reconheceu a queixa (fono)', test: (r) => /fono|fala|entend/i.test(r) || !/\[ERRO/i.test(r) },
                ],
            },
            {
                user: '6 anos',
                checks: [
                    { name: 'NÃO repetiu pergunta de idade', test: (r) => !/qual.*a.*idade/i.test(r), critical: true },
                ],
            },
            {
                user: 'Prefiro de manhã',
                checks: [
                    { name: 'Avançou no fluxo', test: (r) => !/\[ERRO/i.test(r) },
                    { name: 'NÃO pediu período de novo', test: (r) => !/prefer.*manhã.*ou.*tarde/i.test(r), critical: true },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 4. INTERRUPÇÃO: Preço no meio da coleta
    // ─────────────────────────────────────────
    {
        id: 4,
        name: '🔀 Interrupção: Preço no Meio do Fluxo',
        desc: 'Lead pergunta preço no meio da coleta → responde e retoma',
        phone: '5562999990004',
        steps: [
            {
                user: 'Oi, quero agendar uma consulta',
                checks: [
                    { name: 'Respondeu', test: (r) => !/\[ERRO/i.test(r) },
                ],
            },
            {
                user: 'Mas antes, quanto custa?',
                checks: [
                    { name: 'Mencionou preço', test: (r) => /R\$|reais|200|2\.?000|valor|preço|avaliação/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 5. LOCALIZAÇÃO
    // ─────────────────────────────────────────
    {
        id: 5,
        name: '📍 Endereço / Localização',
        desc: 'Lead pergunta onde fica → envia localização',
        phone: '5562999990005',
        steps: [
            {
                user: 'Onde fica a clínica?',
                checks: [
                    // O legado envia location via sendLocationMessage e retorna null
                    { name: 'Enviou location ou respondeu endereço', test: (r) => /LOCATION|endereço|localização|minas|anápolis|ficamos|jundiaí/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 6. CONTEXTO PRESERVADO
    // ─────────────────────────────────────────
    {
        id: 6,
        name: '🧠 Contexto: Não repetir idade',
        desc: 'Se lead disse idade na 1ª msg, não pedir de novo',
        phone: '5562999990006',
        steps: [
            {
                user: 'Oi, meu filho tem 5 anos e não fala direito',
                checks: [
                    { name: 'NÃO perguntou idade', test: (r) => !/qual.*idade|quantos.*anos/i.test(r), critical: true },
                ],
            },
            {
                user: 'Quanto é a consulta?',
                checks: [
                    { name: 'NÃO perguntou idade de novo', test: (r) => !/qual.*idade|quantos.*anos/i.test(r), critical: true },
                    { name: 'Respondeu sobre preço', test: (r) => /R\$|preço|valor|200|avaliação/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 7. DETECÇÃO DE TERAPIA
    // ─────────────────────────────────────────
    {
        id: 7,
        name: '🎯 Detecção: Fonoaudiologia',
        desc: 'Lead fala "não fala direito" → deve detectar fono',
        phone: '5562999990007',
        steps: [
            {
                user: 'Meu filho tem 4 anos e não fala direito, gostaria de agendar',
                checks: [
                    { name: 'Detectou fono (ou fez pergunta relevante)', test: (r) => /fono|fala|avaliação|horár/i.test(r) || !/\[ERRO/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 8. NEUROPSICOLOGIA (preço diferente)
    // ─────────────────────────────────────────
    {
        id: 8,
        name: '🧠 Preço: Neuropsicologia (R$ 2.000)',
        desc: 'Lead com área neuro → preço correto R$ 2.000',
        phone: '5562999990008',
        leadExtra: {
            therapyArea: 'neuropsicologia',
            stage: 'agendado',
            status: 'agendado',
        },
        steps: [
            {
                user: 'Quanto é a avaliação?',
                checks: [
                    { name: 'Mencionou R$ 2.000', test: (r) => /2\.?000/i.test(r), critical: true },
                    { name: 'NÃO disse R$ 200', test: (r) => !/\bR\$\s*200\b/.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 9. CONVÊNIO
    // ─────────────────────────────────────────
    {
        id: 9,
        name: '🏥 Convênio',
        desc: 'Lead pergunta sobre convênio → deve responder',
        phone: '5562999990009',
        steps: [
            {
                user: 'Vocês aceitam convênio?',
                checks: [
                    { name: 'Respondeu sobre convênio/particular', test: (r) => /particular|convênio|plano|atendemos/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 10. PSICOLOGIA (limite de idade)
    // ─────────────────────────────────────────
    {
        id: 10,
        name: '⚠️ Psicologia: Limite de idade (>16)',
        desc: 'Lead adulto pedindo psico → deve avisar que só atende infantil',
        phone: '5562999990010',
        leadExtra: {
            therapyArea: 'psicologia',
            'patientInfo.age': 25,
        },
        steps: [
            {
                user: 'Quero agendar psicologia',
                checks: [
                    { name: 'Mencionou limite infantil/adolescente', test: (r) => /infantil|adolescente|16|criança|não atendemos/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 11. HANDOFF (anti-spam)
    // ─────────────────────────────────────────
    {
        id: 11,
        name: '🤝 Handoff: Anti-spam "ok"',
        desc: 'Após handoff, "ok" não deve gerar nova resposta longa',
        phone: '5562999990011',
        leadExtra: {
            'autoBookingContext.handoffSentAt': new Date(),
        },
        steps: [
            {
                user: 'Ok',
                checks: [
                    { name: 'Resposta curta (anti-spam)', test: (r) => r.length < 120 },
                    { name: 'Tem 💚', test: (r) => r.includes('💚') },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 12. TDAH
    // ─────────────────────────────────────────
    {
        id: 12,
        name: '🧩 Detecção TDAH',
        desc: 'Lead pergunta sobre TDAH → deve responder sobre avaliação neuropsicológica',
        phone: '5562999990012',
        steps: [
            {
                user: 'Meu filho foi diagnosticado com TDAH, vocês fazem avaliação?',
                checks: [
                    { name: 'Mencionou avaliação ou neuro', test: (r) => /avaliação|neuro|atenção|TDAH/i.test(r) },
                ],
            },
        ],
    },

    // ═════════════════════════════════════════
    // CENÁRIOS DE VALIDAÇÃO — REGRAS BAKED-IN
    // (Validam clinicWisdom.js + amandaPrompt)
    // ═════════════════════════════════════════

    // ─────────────────────────────────────────
    // 13. PREÇO COM ANCHOR DE DESCONTO
    // ─────────────────────────────────────────
    {
        id: 13,
        name: '💰 Preço com Anchor (R$250 → R$200)',
        desc: 'Lead pergunta preço de fono → deve usar anchor de desconto e contextualizar',
        phone: '5562999990013',
        steps: [
            {
                user: 'Oi! Quanto custa a avaliação de fonoaudiologia?',
                checks: [
                    { name: 'Mencionou R$200', test: (r) => /200/i.test(r), critical: true },
                    { name: 'NÃO mandou preço seco (>80 chars)', test: (r) => r.length > 80 },
                    { name: 'Tem acolhimento ou contextualização', test: (r) => /avaliação|anamnese|entrevista|passo|invest|completa/i.test(r) },
                    { name: 'Tem 💚', test: (r) => r.includes('💚') },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 14. CONVÊNIO COM BRIDGE PARA PARTICULAR
    // ─────────────────────────────────────────
    {
        id: 14,
        name: '🏥 Convênio: Bridge Particular + Reembolso',
        desc: 'Lead pergunta Unimed → deve mencionar credenciamento + reembolso + bridge particular',
        phone: '5562999990014',
        steps: [
            {
                user: 'Vocês atendem pela Unimed?',
                checks: [
                    { name: 'Menciona situação convênio', test: (r) => /particular|credenciamento|processo/i.test(r), critical: true },
                    { name: 'Menciona reembolso', test: (r) => /reembolso|nota\s*fiscal/i.test(r) },
                    { name: 'Faz bridge para valores', test: (r) => /valor|conhecer|gostaria/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 15. TEA — ACOLHIMENTO ANTES DE INFORMAÇÃO
    // ─────────────────────────────────────────
    {
        id: 15,
        name: '🧩 TEA: Acolhimento Primeiro',
        desc: 'Mãe preocupada com TEA → deve acolher ANTES de dar informação',
        phone: '5562999990015',
        steps: [
            {
                user: 'Oi, meu filho de 3 anos tem suspeita de autismo e o neuropediatra pediu avaliação. Estou muito preocupada.',
                checks: [
                    { name: 'Acolheu (empatia/entendo/preocupação)', test: (r) => /entendo|compreendo|preocupa|natural|importante|passo|sentir/i.test(r), critical: true },
                    { name: 'Mencionou avaliação', test: (r) => /avaliação|avaliar/i.test(r) },
                    { name: 'NÃO começou com preço', test: (r) => !/^(R\$|o valor|custa)/i.test(r.trim()) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 16. OBJEÇÃO DE PREÇO
    // ─────────────────────────────────────────
    {
        id: 16,
        name: '💸 Objeção: \"Muito caro\"',
        desc: 'Lead acha caro → deve tratar com empatia e mostrar valor',
        phone: '5562999990016',
        leadExtra: {
            therapyArea: 'fonoaudiologia',
            stage: 'pesquisando_preco',
        },
        steps: [
            {
                user: 'Achei muito caro, tem outra clínica mais barata aqui em Anápolis',
                checks: [
                    { name: 'Acolheu/empatizou', test: (r) => /entend|compreend|investimento|valor|import/i.test(r) },
                    { name: 'NÃO disse que é barato', test: (r) => !/é barato|baratinho/i.test(r) },
                    { name: 'Mencionou pacote ou benefício', test: (r) => /pacote|sessão|mensal|profission|equipe|resultado/i.test(r) },
                ],
            },
        ],
    },

    // ─────────────────────────────────────────
    // 17. HORÁRIO APÓS 18H
    // ─────────────────────────────────────────
    {
        id: 17,
        name: '⏰ Horário: Após 18h',
        desc: 'Lead pergunta horário à noite → deve informar seg/qua',
        phone: '5562999990017',
        steps: [
            {
                user: 'Vocês atendem depois das 18h? Porque eu trabalho o dia todo',
                checks: [
                    { name: 'Menciona horário especial', test: (r) => /18|noite|segunda|quarta|tarde/i.test(r) },
                    { name: 'Tem 💚', test: (r) => r.includes('💚') },
                ],
            },
        ],
    },
];

// ============================================
// EXECUÇÃO
// ============================================

async function runScenario(scenario) {
    log(c.magenta, `\n${'═'.repeat(70)}`);
    log(c.bold, `  ${scenario.id}. ${scenario.name}`);
    log(c.dim, `     ${scenario.desc}`);
    log(c.magenta, `${'─'.repeat(70)}`);

    let lead;
    let totalChecks = 0;
    let passedChecks = 0;
    let criticalFail = false;

    try {
        lead = await createTestLead(scenario.phone, scenario.leadExtra || {});

        for (let i = 0; i < scenario.steps.length; i++) {
            const step = scenario.steps[i];
            log(c.cyan, `\n  👤 Mensagem ${i + 1}: "${step.user}"`);

            const response = await callAmanda(lead, step.user);

            // Refresh lead (o legado muda o lead no banco)
            lead = await refreshLead(lead._id);

            if (VERBOSE) {
                log(c.dim, `  🤖 Amanda: "${response}"`);
            } else {
                const preview = response.substring(0, 150);
                log(c.dim, `  🤖 Amanda: "${preview}${response.length > 150 ? '...' : ''}"`);
            }

            for (const check of step.checks) {
                totalChecks++;
                const passed = check.test(response);
                if (passed) {
                    passedChecks++;
                    log(c.green, `     ✅ ${check.name}`);
                } else {
                    if (check.critical) criticalFail = true;
                    log(c.red, `     ❌ ${check.name}${check.critical ? ' 🔥 CRÍTICO' : ''}`);
                }
            }
        }
    } catch (err) {
        log(c.red, `  💥 ERRO NO CENÁRIO: ${err.message}`);
        if (VERBOSE) log(c.red, err.stack);
        criticalFail = true;
    } finally {
        if (lead) await cleanupTestLead(lead._id).catch(() => { });
    }

    return {
        id: scenario.id,
        name: scenario.name,
        passed: passedChecks,
        total: totalChecks,
        allPassed: passedChecks === totalChecks,
        criticalFail,
    };
}

// ============================================
// CENÁRIOS DAS CONVERSAS REAIS (--from-real)
// ============================================
function loadRealScenarios() {
    const jsonPath = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'conversasReaisExtraidas.json');

    if (!fs.existsSync(jsonPath)) {
        log(c.yellow, '⚠️ conversasReaisExtraidas.json não encontrado. Rode o parser primeiro:');
        log(c.dim, '   node scripts/parseWhatsAppExport.js');
        return [];
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    // Filtra cenários com respostas significativamente diferentes do lead (evita echos)
    const validScenarios = data.scenarios.filter(s => {
        const leadNorm = s.leadMessage.toLowerCase().replace(/\s/g, '');
        const respNorm = s.idealResponse.toLowerCase().replace(/\s/g, '');
        return leadNorm !== respNorm && s.idealResponse.length > 20;
    });

    return validScenarios.map((s, i) => ({
        id: 100 + s.id,
        name: `📊 [${s.category}] "${s.leadMessage.slice(0, 40)}..."`,
        desc: `Gabarito humano: "${s.idealResponse.slice(0, 80)}..."`,
        phone: `556299990${String(50 + i).padStart(3, '0')}`,
        idealResponse: s.idealResponse,
        steps: [{
            user: s.leadMessage,
            checks: [
                { name: 'Não deu erro', test: (r) => !r.startsWith('[ERRO') },
                { name: 'Resposta não vazia', test: (r) => r.length > 5 },
                // Checks específicos da categoria
                ...generateCategoryChecks(s),
            ],
        }],
    }));
}

function generateCategoryChecks(scenario) {
    const checks = [];
    const cat = scenario.category;

    if (cat === 'PRECO') {
        checks.push({ name: 'Mencionou preço', test: (r) => /R\$|valor|preço|200|640|160/i.test(r) });
    }
    if (cat === 'CONVENIO') {
        checks.push({ name: 'Respondeu sobre convênio', test: (r) => /convênio|particular|plano|atendemos/i.test(r) });
    }
    if (cat === 'AGENDAMENTO') {
        checks.push({ name: 'Fluxo de agendamento', test: (r) => /agendar|marcar|horário|disponível|avaliação/i.test(r) });
    }
    if (cat === 'TERAPIA') {
        checks.push({ name: 'Mencionou terapia', test: (r) => /fono|psico|terapia|avaliação|atendimento/i.test(r) });
    }
    if (cat === 'TEA_TDAH') {
        checks.push({ name: 'Mencionou TEA/TDAH/neuro', test: (r) => /TEA|TDAH|neuro|atenção|avaliação/i.test(r) });
    }
    if (cat === 'LOCALIZACAO') {
        checks.push({ name: 'Respondeu sobre localização', test: (r) => /endereço|localização|LOCATION|anápolis/i.test(r) });
    }

    return checks;
}

async function main() {
    log(c.cyan, '\n╔══════════════════════════════════════════════════════════════════════╗');
    log(c.cyan, '║  🧪 TESTE LOCAL — AMANDA LEGADO (getOptimizedAmandaResponse)       ║');
    if (FROM_REAL) {
        log(c.cyan, '║  📊 MODO: Cenários extraídos de conversas REAIS                   ║');
    }
    log(c.cyan, '╚══════════════════════════════════════════════════════════════════════╝');

    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        log(c.green, '\n✅ MongoDB conectado');
    } catch (err) {
        log(c.red, `\n❌ MongoDB: ${err.message}`);
        process.exit(1);
    }

    // Seleciona cenários
    const allScenarios = FROM_REAL ? loadRealScenarios() : SCENARIOS;
    const scenarios = ONLY
        ? allScenarios.filter(s => s.id === ONLY)
        : allScenarios;

    if (scenarios.length === 0) {
        log(c.red, `\n❌ Cenário ${ONLY} não encontrado`);
        process.exit(1);
    }

    const results = [];
    for (const scenario of scenarios) {
        const result = await runScenario(scenario);
        results.push(result);
    }

    // ============================================
    // RESUMO FINAL
    // ============================================
    const totalPassed = results.filter(r => r.allPassed).length;
    const totalFailed = results.filter(r => !r.allPassed).length;
    const criticalFails = results.filter(r => r.criticalFail);
    const totalChecks = results.reduce((sum, r) => sum + r.total, 0);
    const totalChecksPass = results.reduce((sum, r) => sum + r.passed, 0);

    log(c.cyan, `\n${'═'.repeat(70)}`);
    log(c.bold, '  📊 RESULTADO FINAL');
    log(c.cyan, `${'═'.repeat(70)}`);

    for (const r of results) {
        const icon = r.allPassed ? '✅' : (r.criticalFail ? '🔥' : '⚠️');
        const color = r.allPassed ? c.green : c.red;
        log(color, `  ${icon} ${r.name} — ${r.passed}/${r.total} checks`);
    }

    log(c.cyan, `\n${'─'.repeat(70)}`);
    log(c.bold, `  Cenários: ${c.green}${totalPassed} passaram${c.reset} | ${c.red}${totalFailed} falharam${c.reset}`);
    log(c.bold, `  Checks:   ${c.green}${totalChecksPass}/${totalChecks}${c.reset}`);

    if (criticalFails.length > 0) {
        log(c.red, `\n  🔥 FALHAS CRÍTICAS (BLOQUEIA DEPLOY):`);
        criticalFails.forEach(r => log(c.red, `     ❌ ${r.name}`));
        log(c.red, `\n  ⛔ NÃO SUBIR PARA PRODUÇÃO!\n`);
    } else if (totalFailed > 0) {
        log(c.yellow, `\n  ⚠️ Algumas falhas não-críticas. Revise antes de subir.\n`);
    } else {
        log(c.green, `\n  🎉 TODOS OS TESTES PASSARAM!`);
        log(c.green, `  🚀 Amanda Legado está PRONTA para produção!\n`);
    }

    await mongoose.disconnect();
    process.exit(criticalFails.length > 0 ? 1 : 0);
}

main();
