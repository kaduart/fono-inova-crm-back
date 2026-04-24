#!/usr/bin/env node
/**
 * 🧪 TESTES DE REGRESSÃO — Bugs 1-6 (corrigidos em 2026-04-24)
 *
 * Bug 1: Sem slots → dead end ("não encontrei horários" sem alternativa)
 * Bug 2: Repete pergunta de período já informado
 * Bug 3: "Não recebi mensagem" falso em msg vazia/mídia
 * Bug 4: currentState ignorado (saudação fresca mesmo em triagem)
 * Bug 5: Idade ignorada quando dada em texto ("5 anos")
 * Bug 6: "Vou verificar" aceito sem oferecer reserva de horário
 *
 * Uso: node --env-file=.env tests/amanda/bug-fixes-1-6.test.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import { deriveFlagsFromText } from '../../utils/flagsDetector.js';
import Leads from '../../models/Leads.js';
import Contacts from '../../models/Contacts.js';

const PHONE = '5562000000099';

const c = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

// ============================================
// CENÁRIOS DE REGRESSÃO BUGS 1-6
// ============================================
const BUG_SCENARIOS = [

    // ═══════════════════════════════════════════
    // BUG 1: Sem slots → dead end
    // ═══════════════════════════════════════════
    {
        group: 'Bug 1 — Sem Slots',
        name: 'B1-01: Detecta wantsSchedule mas sem slots → flag coverage',
        rule: 'Se noSlotsAvailable, Amanda deve oferecer alternativa (outro período, próx semana ou lista de espera)',
        critical: true,
        note: 'Teste de flag: cobertura parcial — validação completa requer mock do bookingService',
        messages: [
            {
                text: 'Quero agendar fonoaudiologia para amanhã de manhã',
                expectFlags: { wantsSchedule: true },
                rejectResponse: ['não encontrei nenhum horário', 'não há vagas disponíveis'],
            }
        ]
    },
    {
        group: 'Bug 1 — Sem Slots',
        name: 'B1-02: Resposta nunca deve ser dead end puro',
        rule: 'Amanda nunca pode encerrar sem oferecer ação concreta ao paciente',
        messages: [
            {
                text: 'Tem horário disponível essa semana?',
                expectFlags: { wantsSchedule: true },
                // Qualquer resposta deve conter uma ação ou próximo passo
                expectResponse: ['nome', 'paciente', 'horário', 'lista', 'período', 'especialidade'],
            }
        ]
    },

    // ═══════════════════════════════════════════
    // BUG 2: Repete pergunta de período já informado
    // ═══════════════════════════════════════════
    {
        group: 'Bug 2 — Período Repetido',
        name: 'B2-01: pendingPreferredPeriod já preenchido → não perguntar período',
        rule: 'getMissingFields deve ver pendingPreferredPeriod e NÃO incluir período em missing',
        critical: true,
        messages: [
            {
                text: 'ok',
                setupLead: (lead) => ({
                    ...lead,
                    pendingPreferredPeriod: 'tarde',
                    therapyArea: 'fonoaudiologia',
                    patientInfo: { name: 'Ana Laura', age: 5 },
                    qualificationData: { extractedInfo: { disponibilidade: 'tarde' } },
                }),
                // Amanda NÃO deve perguntar "manhã ou tarde" pois já sabe
                rejectResponse: ['manhã ou tarde', 'prefere manhã', 'manhã, tarde', 'qual período', 'período prefere'],
            }
        ]
    },
    {
        group: 'Bug 2 — Período Repetido',
        name: 'B2-02: qualificationData.disponibilidade preenchido → não perguntar período',
        rule: 'getMissingFields deve aceitar disponibilidade como fonte válida de período',
        critical: true,
        messages: [
            {
                text: 'pode ser',
                setupLead: (lead) => ({
                    ...lead,
                    therapyArea: 'fonoaudiologia',
                    patientInfo: { name: 'Theo', age: 8 },
                    qualificationData: {
                        extractedInfo: { disponibilidade: 'manha', queixa: 'atraso de fala' }
                    },
                }),
                rejectResponse: ['manhã ou tarde', 'prefere manhã', 'qual período'],
            }
        ]
    },

    // ═══════════════════════════════════════════
    // BUG 3: "Não recebi mensagem" falso positivo
    // ═══════════════════════════════════════════
    {
        group: 'Bug 3 — Mensagem Vazia',
        name: 'B3-01: Mensagem vazia → NÃO deve dizer "não recebi"',
        rule: 'WhatsAppOrchestrator retorna NO_REPLY para texto vazio; Amanda não deve inventar "não recebi"',
        critical: true,
        messages: [
            {
                text: '',
                // Amanda não deve dizer que não recebeu — deve ficar em silêncio
                rejectResponse: ['não recebi', 'parece que não recebi', 'não consegui ver', 'mensagem não chegou'],
            }
        ]
    },
    {
        group: 'Bug 3 — Mensagem Vazia',
        name: 'B3-02: Flag detection em texto vazio não gera noise',
        rule: 'deriveFlagsFromText("") não deve ativar flags de resposta',
        note: 'Teste puro de flags — sem chamada ao orchestrator',
        messages: [
            {
                text: '',
                expectFlags: { wantsSchedule: false, wantsHumanAgent: false, saysBye: false },
            }
        ]
    },

    // ═══════════════════════════════════════════
    // BUG 4: currentState ignorado
    // ═══════════════════════════════════════════
    {
        group: 'Bug 4 — currentState Ignorado',
        name: 'B4-01: Lead em COLLECT_COMPLAINT → não deve cumprimentar como novo',
        rule: 'currentState do lead deve ser respeitado; Amanda continua o fluxo, não reinicia',
        critical: true,
        messages: [
            {
                text: 'atraso de fala',
                setupLead: (lead) => ({
                    ...lead,
                    currentState: 'COLLECT_COMPLAINT',
                    therapyArea: 'fonoaudiologia',
                    pendingPreferredPeriod: 'tarde',
                    patientInfo: { name: 'Lucas', age: 4 },
                    qualificationData: { extractedInfo: {} },
                }),
                // Amanda não deve cumprimentar como se fosse novo lead
                rejectResponse: ['olá', 'oi tudo', 'bem-vindo', 'seja bem'],
                // Deve reconhecer a queixa e avançar
                expectResponse: ['atraso', 'fala', 'horário', 'agendar', 'disponível', 'nome'],
            }
        ]
    },
    {
        group: 'Bug 4 — currentState Ignorado',
        name: 'B4-02: Lead em SHOW_SLOTS → não deve pedir dados já coletados',
        rule: 'Se currentState = SHOW_SLOTS, Amanda sabe que dados já foram coletados',
        messages: [
            {
                text: 'pode ser essa opção',
                setupLead: (lead) => ({
                    ...lead,
                    currentState: 'SHOW_SLOTS',
                    therapyArea: 'fonoaudiologia',
                    pendingPreferredPeriod: 'manha',
                    patientInfo: { name: 'Sofia', age: 6 },
                    pendingSchedulingSlots: {
                        primary: { date: '2026-04-28', time: '09:00', doctorName: 'Dra. Silva' }
                    },
                    qualificationData: { extractedInfo: { queixa: 'dificuldade de leitura' } },
                }),
                // Não deve pedir nome, período ou queixa novamente
                rejectResponse: ['qual o nome', 'qual período', 'manhã ou tarde', 'qual a queixa'],
            }
        ]
    },

    // ═══════════════════════════════════════════
    // BUG 5: Idade ignorada quando dada em texto
    // ═══════════════════════════════════════════
    {
        group: 'Bug 5 — Idade em Texto',
        name: 'B5-01: qualificationData.ageText preenchido → não perguntar idade',
        rule: 'getMissingFields deve aceitar ageText como fonte válida de idade',
        critical: true,
        messages: [
            {
                text: 'ok',
                setupLead: (lead) => ({
                    ...lead,
                    therapyArea: 'fonoaudiologia',
                    pendingPreferredPeriod: 'tarde',
                    patientInfo: { name: 'Pedro' },
                    qualificationData: {
                        ageText: '5 anos',
                        extractedInfo: { queixa: 'gagueira' }
                    },
                }),
                // Amanda NÃO deve perguntar idade — já tem ageText
                rejectResponse: ['quantos anos', 'qual a idade', 'idade do paciente', 'anos tem'],
            }
        ]
    },
    {
        group: 'Bug 5 — Idade em Texto',
        name: 'B5-02: qualificationData.patientAge preenchido → não perguntar idade',
        rule: 'getMissingFields deve aceitar patientAge numérico como fonte válida',
        critical: true,
        messages: [
            {
                text: 'sim',
                setupLead: (lead) => ({
                    ...lead,
                    therapyArea: 'psicologia',
                    pendingPreferredPeriod: 'manha',
                    patientInfo: { name: 'Maria' },
                    qualificationData: {
                        patientAge: 7,
                        extractedInfo: { queixa: 'ansiedade' }
                    },
                }),
                rejectResponse: ['quantos anos', 'qual a idade', 'anos tem o paciente'],
            }
        ]
    },

    // ═══════════════════════════════════════════
    // BUG 6: "Vou verificar" sem oferecer reserva
    // ═══════════════════════════════════════════
    {
        group: 'Bug 6 — Saída Disfarçada',
        name: 'B6-01: Flag "obrigada vou pensar" → detecta saysThanks',
        rule: 'deriveFlagsFromText deve detectar saysThanks em mensagens de saída educada',
        note: 'Teste de flag — a oferta de reserva é feita pelo WhatsAppOrchestrator V8',
        messages: [
            {
                text: 'obrigada vou pensar',
                expectFlags: { saysThanks: true },
            }
        ]
    },
    {
        group: 'Bug 6 — Saída Disfarçada',
        name: 'B6-02: Flag "vou verificar e volto" → detecta saysThanks',
        rule: 'Variações de saída disfarçada devem ser detectadas como saysThanks',
        messages: [
            {
                text: 'vou verificar minha agenda e te aviso',
                expectFlags: { saysThanks: true },
            }
        ]
    },
    {
        group: 'Bug 6 — Saída Disfarçada',
        name: 'B6-03: Lead em fluxo de agendamento + saída → não encerrar sem reserva',
        rule: 'Amanda deve oferecer reservar horário, não só dizer "de nada" e encerrar',
        critical: true,
        messages: [
            {
                text: 'obrigada vou pensar e te aviso',
                setupLead: (lead) => ({
                    ...lead,
                    currentState: 'SHOW_SLOTS',
                    therapyArea: 'fonoaudiologia',
                    pendingPreferredPeriod: 'tarde',
                    patientInfo: { name: 'Clara', age: 7 },
                    pendingSchedulingSlots: {
                        primary: { date: '2026-04-29', time: '14:00', doctorName: 'Dra. Lima' }
                    },
                    qualificationData: { extractedInfo: { queixa: 'dislalia' } },
                }),
                // Amanda deve oferecer reserva, não encerrar
                expectResponse: ['reservar', 'horário', 'nome', 'sem problema', 'cancela'],
                rejectResponse: ['de nada', 'até logo', 'até mais', 'tchau', 'boa sorte'],
            }
        ]
    },
];

// ============================================
// MOTOR DE TESTE (mesmo padrão p1-p4-fixes)
// ============================================
async function setupLead(overrides = {}) {
    await Leads.deleteMany({ phone: PHONE });

    let contact = await Contacts.findOne({ phone: PHONE });
    if (!contact) {
        contact = await Contacts.create({
            name: 'Teste Bugs 1-6',
            phone: PHONE,
            source: 'test_bugs16'
        });
    }

    const leadData = {
        name: 'Teste Bugs 1-6',
        phone: PHONE,
        contact: contact._id,
        source: 'test_bugs16',
        stage: 'novo',
        autoReplyEnabled: true,
        qualificationData: { extractedInfo: {} },
        ...overrides,
    };

    return Leads.create(leadData);
}

async function testFlags(msg) {
    const flags = deriveFlagsFromText(msg.text);
    const errors = [];
    if (msg.expectFlags) {
        for (const [flag, expected] of Object.entries(msg.expectFlags)) {
            if (flags[flag] !== expected) {
                errors.push(`Flag "${flag}": esperado ${expected}, obtido ${flags[flag]}`);
            }
        }
    }
    return { passed: errors.length === 0, errors, flags };
}

async function testResponse(msg, respText) {
    const lower = (respText || '').toLowerCase();
    const errors = [];
    const details = [];

    if (msg.expectResponse) {
        const anyMatches = msg.expectResponse.some(exp => lower.includes(exp.toLowerCase()));
        if (!anyMatches) {
            errors.push(`Resposta não contém nenhum de: ${msg.expectResponse.map(e => `"${e}"`).join(', ')}`);
        } else {
            msg.expectResponse.filter(e => lower.includes(e.toLowerCase()))
                .forEach(e => details.push(`✓ "${e}"`));
        }
    }

    if (msg.rejectResponse) {
        for (const rej of msg.rejectResponse) {
            if (lower.includes(rej.toLowerCase())) {
                errors.push(`Contém texto proibido: "${rej}"`);
            }
        }
    }

    return { passed: errors.length === 0, errors, details };
}

async function runScenario(scenario) {
    const isCritical = scenario.critical ? ' 🔴' : '';
    log(c.cyan, `\n${'─'.repeat(64)}`);
    log(c.cyan, `  [${scenario.group}] ${scenario.name}${isCritical}`);
    log(c.gray, `  📋 ${scenario.rule}`);
    if (scenario.note) log(c.yellow, `  ⚠️  ${scenario.note}`);
    log(c.cyan, `${'─'.repeat(64)}`);

    let lead = await setupLead();
    let allPassed = true;
    const errors = [];

    for (let i = 0; i < scenario.messages.length; i++) {
        const msg = scenario.messages[i];
        log(c.gray, `\n  👤 [MSG ${i + 1}] "${msg.text || '(vazio)'}"`);

        if (msg.setupLead) {
            lead = await setupLead(msg.setupLead(lead.toObject ? lead.toObject() : lead));
        }

        // Teste de flags
        if (msg.expectFlags) {
            const flagResult = await testFlags(msg);
            if (flagResult.passed) {
                log(c.green, `     ✅ Flags OK: ${JSON.stringify(msg.expectFlags)}`);
            } else {
                log(c.red, `     ❌ Flags incorretas:`);
                flagResult.errors.forEach(e => log(c.red, `        - ${e}`));
                allPassed = false;
                errors.push(...flagResult.errors);
            }
        }

        // Teste de resposta (só se há expectResponse ou rejectResponse)
        if (msg.expectResponse || msg.rejectResponse) {
            const origLog = console.log;
            const origError = console.error;
            const origWarn = console.warn;
            console.log = () => {};
            console.error = () => {};
            console.warn = () => {};

            let respText = '';
            try {
                const freshLead = await Leads.findById(lead._id).lean();
                const response = await getOptimizedAmandaResponse({
                    content: msg.text,
                    userText: msg.text,
                    lead: freshLead,
                    context: { source: 'whatsapp-inbound' },
                    messageId: `test-bugs16-${Date.now()}`,
                });
                respText = response || '';
            } catch (err) {
                respText = '';
            } finally {
                console.log = origLog;
                console.error = origError;
                console.warn = origWarn;
            }

            log(c.gray, `     💬 Resposta: "${respText.slice(0, 120).replace(/\n/g, ' ')}"`);

            const respResult = await testResponse(msg, respText);
            if (respResult.passed) {
                log(c.green, `     ✅ Conteúdo OK ${respResult.details.length ? `(${respResult.details.join(', ')})` : ''}`);
            } else {
                log(c.red, `     ❌ Conteúdo inválido:`);
                respResult.errors.forEach(e => log(c.red, `        - ${e}`));
                allPassed = false;
                errors.push(...respResult.errors);
            }
        }
    }

    return { passed: allPassed, critical: scenario.critical, errors };
}

// ============================================
// MAIN
// ============================================
async function main() {
    console.log('\n🧪 TESTES DE REGRESSÃO — BUGS 1-6\n');

    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    log(c.green, '✅ MongoDB conectado\n');

    const results = { passed: 0, failed: 0, critical: { passed: 0, failed: 0 } };
    const failures = [];

    for (const scenario of BUG_SCENARIOS) {
        const result = await runScenario(scenario);

        if (result.passed) {
            results.passed++;
            if (scenario.critical) results.critical.passed++;
            log(c.green, `\n  ✅ PASSOU`);
        } else {
            results.failed++;
            if (scenario.critical) results.critical.failed++;
            failures.push({ name: `[${scenario.group}] ${scenario.name}`, errors: result.errors });
            log(c.red, `\n  ❌ FALHOU`);
        }
    }

    // Relatório final
    const total = BUG_SCENARIOS.length;
    console.log(`\n${'═'.repeat(64)}`);
    log(c.cyan, `📊 RESULTADO FINAL`);
    console.log(`${'═'.repeat(64)}`);
    console.log(`Total: ${results.passed}/${total} passaram`);
    console.log(`Críticos: ${results.critical.passed}/${results.critical.passed + results.critical.failed}`);

    if (failures.length > 0) {
        log(c.red, `\n❌ FALHAS:`);
        failures.forEach(f => {
            log(c.red, `  • ${f.name}`);
            f.errors.forEach(e => log(c.red, `    - ${e}`));
        });
    }

    console.log(`${'═'.repeat(64)}\n`);

    await mongoose.disconnect();
    process.exit(results.critical.failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
});
