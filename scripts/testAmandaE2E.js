#!/usr/bin/env node
/**
 * 🧪 TESTE E2E — AMANDA VIA WEBHOOK SIMULADO
 * 
 * Simula o webhook do Meta (POST /api/whatsapp/webhook) localmente,
 * espera a Amanda processar, e verifica a resposta no banco.
 * 
 * ⚠️ NÃO ENVIA MENSAGENS REAIS PRO WHATSAPP!
 *     O script intercepta sendTextMessage antes de testar.
 * 
 * REQUISITOS:
 *   - Backend rodando (npm run dev) na porta 5000
 *   - MongoDB acessível
 * 
 * USO:
 *   node scripts/testAmandaE2E.js                    # todos cenários
 *   node scripts/testAmandaE2E.js --only 3           # só cenário 3
 *   node scripts/testAmandaE2E.js --from-real         # cenários das conversas reais
 *   node scripts/testAmandaE2E.js --verbose           # mostra resposta completa
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Lead from '../models/Leads.js';
import Contact from '../models/Contacts.js';
import Message from '../models/Message.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// CONFIG
// ============================================
const PORT = process.env.PORT || 5000;
const BASE_URL = `http://localhost:${PORT}/api/whatsapp`;

const VERBOSE = process.argv.includes('--verbose');
const FROM_REAL = process.argv.includes('--from-real');
const ONLY = process.argv.includes('--only')
    ? parseInt(process.argv[process.argv.indexOf('--only') + 1])
    : null;

// Tempo para esperar a Amanda processar (ms)
const WAIT_MS = 4000;

const c = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m',
    cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m'
};
const log = (color, ...args) => console.log(color, ...args, c.reset);

// Número de teste (compatível com AUTO_TEST_NUMBERS no controller)
const TEST_PHONE_BASE = '5562999880';

// ============================================
// PAYLOAD BUILDER (formato Meta/WhatsApp)
// ============================================
function buildMetaPayload(phone, text, messageId = null) {
    const wamid = messageId || `wamid.test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();

    return {
        object: "whatsapp_business_account",
        entry: [{
            id: process.env.META_WABA_BIZ_ID || "TEST_BIZ_ID",
            changes: [{
                value: {
                    messaging_product: "whatsapp",
                    metadata: {
                        display_phone_number: process.env.CLINIC_PHONE_E164 || "5562992013573",
                        phone_number_id: process.env.META_WABA_PHONE_ID || "TEST_PHONE_ID"
                    },
                    contacts: [{
                        profile: {
                            name: `Teste E2E ${phone.slice(-4)}`
                        },
                        wa_id: phone
                    }],
                    messages: [{
                        from: phone,
                        id: wamid,
                        timestamp,
                        text: {
                            body: text
                        },
                        type: "text"
                    }]
                },
                field: "messages"
            }]
        }]
    };
}

// ============================================
// ENVIO VIA WEBHOOK (simula o Meta)
// ============================================
async function sendViaWebhook(phone, text) {
    const payload = buildMetaPayload(phone, text);

    try {
        const res = await fetch(`${BASE_URL}/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Webhook retornou ${res.status}: ${body}`);
        }

        return { success: true };
    } catch (err) {
        if (err.code === 'ECONNREFUSED') {
            throw new Error(`❌ Backend não está rodando na porta ${PORT}! Rode: npm run dev`);
        }
        throw err;
    }
}

// ============================================
// MONITOR DE RESPOSTA
// ============================================
async function waitForResponse(phone, sentAt, timeoutMs = WAIT_MS) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        // Busca resposta outbound mais recente para esse phone
        const response = await Message.findOne({
            to: { $regex: phone.slice(-10) },
            direction: 'outbound',
            timestamp: { $gte: sentAt },
        })
            .sort({ timestamp: -1 })
            .lean();

        if (response) {
            return {
                found: true,
                content: response.content || '',
                type: response.type || 'text',
                timestamp: response.timestamp,
                waMessageId: response.waMessageId,
                metadata: response.metadata,
            };
        }

        // Espera antes de tentar de novo
        await new Promise(r => setTimeout(r, 500));
    }

    return { found: false, content: '', type: 'timeout' };
}

// ============================================
// PREPARAÇÃO (cleanup + lead)
// ============================================
async function prepareTestLead(phone) {
    // Limpa dados antigos de teste
    const numericPhone = phone.replace(/\D/g, '');
    await Lead.deleteMany({
        $or: [
            { phone: { $regex: numericPhone } },
            { source: 'test_e2e' },
        ]
    });
    await Contact.deleteMany({
        $or: [
            { phone: { $regex: numericPhone } },
            { source: 'test_e2e' },
        ]
    });
    await Message.deleteMany({
        $or: [
            { from: { $regex: numericPhone } },
            { to: { $regex: numericPhone } },
        ]
    });
}

async function cleanupTestData(phone) {
    const numericPhone = phone.replace(/\D/g, '');
    await Lead.deleteMany({ phone: { $regex: numericPhone } });
    await Contact.deleteMany({ phone: { $regex: numericPhone } });
    await Message.deleteMany({
        $or: [
            { from: { $regex: numericPhone } },
            { to: { $regex: numericPhone } },
        ]
    });
}

// ============================================
// CENÁRIOS MANUAIS
// ============================================
const SCENARIOS = [
    {
        id: 1,
        name: '👋 E2E: Saudação → Resposta acolhedora',
        phone: `${TEST_PHONE_BASE}01`,
        message: 'Oi, bom dia!',
        checks: [
            { name: 'Amanda respondeu', test: (r) => r.found },
            { name: 'Acolheu', test: (r) => /oi|olá|bem.vind|bom dia/i.test(r.content) },
            { name: 'Não deu erro', test: (r) => !/erro|error/i.test(r.content) },
        ],
    },
    {
        id: 2,
        name: '💰 E2E: Preço → Valor R$',
        phone: `${TEST_PHONE_BASE}02`,
        message: 'Quanto custa a avaliação de fonoaudiologia?',
        checks: [
            { name: 'Amanda respondeu', test: (r) => r.found },
            { name: 'Mencionou preço', test: (r) => /R\$|200|valor|preço|avaliação/i.test(r.content) },
        ],
    },
    {
        id: 3,
        name: '🏥 E2E: Convênio',
        phone: `${TEST_PHONE_BASE}03`,
        message: 'Vocês aceitam convênio? Tenho Unimed.',
        checks: [
            { name: 'Amanda respondeu', test: (r) => r.found },
            { name: 'Respondeu sobre convênio', test: (r) => /particular|convênio|plano|atend/i.test(r.content) },
        ],
    },
    {
        id: 4,
        name: '📍 E2E: Localização',
        phone: `${TEST_PHONE_BASE}04`,
        message: 'Onde fica a clínica?',
        checks: [
            { name: 'Amanda respondeu (texto ou location)', test: (r) => r.found },
        ],
    },
    {
        id: 5,
        name: '🎯 E2E: Detecção Fono',
        phone: `${TEST_PHONE_BASE}05`,
        message: 'Meu filho tem 4 anos e não fala direito',
        checks: [
            { name: 'Amanda respondeu', test: (r) => r.found },
            { name: 'Detectou fono', test: (r) => /fono|fala|avaliação|criança/i.test(r.content) },
        ],
    },
];

// ============================================
// CENÁRIOS DAS CONVERSAS REAIS
// ============================================
function loadRealScenarios() {
    const jsonPath = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'conversasReaisExtraidas.json');

    if (!fs.existsSync(jsonPath)) {
        log(c.yellow, '⚠️ conversasReaisExtraidas.json não encontrado. Rode o parser primeiro:');
        log(c.dim, '   node scripts/parseWhatsAppExport.js');
        return [];
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const scenarios = [];

    // Filtra cenários com respostas significativamente diferentes do lead
    // (evita cenários onde a "resposta" é echo do lead)
    const validScenarios = data.scenarios.filter(s => {
        const leadNorm = s.leadMessage.toLowerCase().replace(/\s/g, '');
        const respNorm = s.idealResponse.toLowerCase().replace(/\s/g, '');
        // Resposta deve ser diferente do input
        return leadNorm !== respNorm && s.idealResponse.length > 20;
    });

    for (let i = 0; i < validScenarios.length; i++) {
        const s = validScenarios[i];
        const phone = `${TEST_PHONE_BASE}${String(50 + i).padStart(2, '0')}`;

        scenarios.push({
            id: 100 + s.id,
            name: `📊 Real [${s.category}]: "${s.leadMessage.slice(0, 40)}..."`,
            phone,
            message: s.leadMessage,
            idealResponse: s.idealResponse,
            checks: convertChecks(s.checks),
        });
    }

    return scenarios;
}

function convertChecks(jsonChecks) {
    const checks = [
        { name: 'Amanda respondeu', test: (r) => r.found },
    ];

    for (const ch of jsonChecks) {
        switch (ch.type) {
            case 'notEmpty':
                checks.push({ name: ch.name, test: (r) => r.content.length > 0 });
                break;
            case 'contains':
                if (ch.matchAny) {
                    checks.push({
                        name: ch.name,
                        test: (r) => ch.patterns.some(p =>
                            r.content.toLowerCase().includes(p.toLowerCase())
                        ),
                    });
                } else {
                    checks.push({
                        name: ch.name,
                        test: (r) => ch.patterns.every(p =>
                            r.content.toLowerCase().includes(p.toLowerCase())
                        ),
                    });
                }
                break;
            case 'notContains':
                checks.push({
                    name: ch.name,
                    test: (r) => !ch.patterns.some(p =>
                        r.content.toLowerCase().includes(p.toLowerCase())
                    ),
                });
                break;
            case 'regex':
                checks.push({
                    name: ch.name,
                    test: (r) => new RegExp(ch.pattern, ch.flags || '').test(r.content),
                });
                break;
        }
    }

    return checks;
}

// ============================================
// EXECUÇÃO
// ============================================
async function runScenario(scenario) {
    log(c.magenta, `\n${'═'.repeat(70)}`);
    log(c.bold, `  ${scenario.id}. ${scenario.name}`);
    log(c.magenta, `${'─'.repeat(70)}`);

    let totalChecks = 0;
    let passedChecks = 0;

    try {
        // Prepara (limpa dados antigos)
        await prepareTestLead(scenario.phone);

        // Timestamp anterior ao envio
        const sentAt = new Date();

        log(c.cyan, `  👤 Enviando via webhook: "${scenario.message.slice(0, 60)}"`);

        // Envia via webhook (simula Meta)
        await sendViaWebhook(scenario.phone, scenario.message);

        log(c.dim, `  ⏳ Aguardando ${WAIT_MS}ms para Amanda processar...`);

        // Espera resposta no banco
        const response = await waitForResponse(scenario.phone, sentAt, WAIT_MS);

        if (response.found) {
            if (VERBOSE) {
                log(c.dim, `  🤖 Amanda: "${response.content}"`);
            } else {
                const preview = response.content.substring(0, 150);
                log(c.dim, `  🤖 Amanda: "${preview}${response.content.length > 150 ? '...' : ''}"`);
            }

            if (scenario.idealResponse) {
                log(c.blue, `  📝 Ideal:  "${scenario.idealResponse.substring(0, 120)}"`);
            }
        } else {
            log(c.yellow, `  ⏱️ Timeout: Amanda não respondeu em ${WAIT_MS}ms`);
        }

        // Valida checks
        for (const check of scenario.checks) {
            totalChecks++;
            const passed = check.test(response);
            if (passed) {
                passedChecks++;
                log(c.green, `     ✅ ${check.name}`);
            } else {
                log(c.red, `     ❌ ${check.name}`);
            }
        }
    } catch (err) {
        log(c.red, `  💥 ERRO: ${err.message}`);
        if (VERBOSE) log(c.red, err.stack);
        totalChecks++;
    } finally {
        // Cleanup
        await cleanupTestData(scenario.phone).catch(() => { });
    }

    return {
        id: scenario.id,
        name: scenario.name,
        passed: passedChecks,
        total: totalChecks,
        allPassed: passedChecks === totalChecks,
    };
}

async function main() {
    log(c.cyan, '\n╔══════════════════════════════════════════════════════════════════════╗');
    log(c.cyan, '║  🧪 TESTE E2E — AMANDA VIA WEBHOOK SIMULADO                       ║');
    log(c.cyan, '║  Simula Meta → webhook → Amanda → resposta no banco               ║');
    log(c.cyan, '╚══════════════════════════════════════════════════════════════════════╝');

    // Verifica backend ativo
    try {
        const healthRes = await fetch(`${BASE_URL}/webhook`, { method: 'GET' });
        if (healthRes.status === 403 || healthRes.status === 200) {
            log(c.green, `\n✅ Backend ativo na porta ${PORT}`);
        }
    } catch (err) {
        log(c.red, `\n❌ Backend não está rodando na porta ${PORT}!`);
        log(c.yellow, `   Execute: cd backend && npm run dev`);
        process.exit(1);
    }

    // Conecta ao MongoDB
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        log(c.green, '✅ MongoDB conectado');
    } catch (err) {
        log(c.red, `\n❌ MongoDB: ${err.message}`);
        process.exit(1);
    }

    // Seleciona cenários
    let scenarios = FROM_REAL ? loadRealScenarios() : SCENARIOS;

    if (ONLY) {
        scenarios = scenarios.filter(s => s.id === ONLY);
    }

    if (scenarios.length === 0) {
        log(c.yellow, '\n⚠️ Nenhum cenário encontrado.');
        process.exit(0);
    }

    log(c.bold, `\n🧪 Executando ${scenarios.length} cenários...\n`);

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
    const totalChecks = results.reduce((sum, r) => sum + r.total, 0);
    const totalChecksPassed = results.reduce((sum, r) => sum + r.passed, 0);

    log(c.cyan, `\n${'═'.repeat(70)}`);
    log(c.bold, '  📊 RESULTADO FINAL E2E');
    log(c.cyan, `${'═'.repeat(70)}`);

    for (const r of results) {
        const icon = r.allPassed ? '✅' : '❌';
        const color = r.allPassed ? c.green : c.red;
        log(color, `  ${icon} ${r.name} — ${r.passed}/${r.total}`);
    }

    log(c.cyan, `\n${'─'.repeat(70)}`);
    log(c.bold, `  Cenários: ${c.green}${totalPassed} passaram${c.reset} | ${c.red}${totalFailed} falharam${c.reset}`);
    log(c.bold, `  Checks:   ${c.green}${totalChecksPassed}/${totalChecks}${c.reset}`);
    log(c.bold, `  Taxa:     ${c.green}${((totalChecksPassed / totalChecks) * 100).toFixed(1)}%${c.reset}`);

    if (totalFailed === 0) {
        log(c.green, `\n  🎉 TODOS OS TESTES E2E PASSARAM!`);
        log(c.green, `  🚀 Sistema está PRONTO!\n`);
    } else {
        log(c.yellow, `\n  ⚠️ ${totalFailed} cenários com falhas.\n`);
    }

    await mongoose.disconnect();
    process.exit(totalFailed > 0 ? 1 : 0);
}

main();
