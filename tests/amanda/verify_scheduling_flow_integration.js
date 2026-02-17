#!/usr/bin/env node
/**
 * 🧪 TESTE DE INTEGRAÇÃO: Fluxo Completo de Agendamento
 * 
 * Valida:
 * 1. "Quais os dias tem vaga" → Busca slots reais (não parceria)
 * 2. Resposta com opções A/B/C → Slots reais da API
 * 3. Escolha de slot → Ativa coleta de dados
 * 4. Coleta nome → Salva e pede data
 * 5. Coleta data → Confirma agendamento
 * 
 * ⚠️  REQUER: MongoDB + API de slots funcionando
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Leads from '../../models/Leads.js';
import Contacts from '../../models/Contacts.js';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';

const PHONE = '556299997777';
const TEST_LEAD_NAME = 'Teste Agendamento';

const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bold: '\x1b[1m'
};

function log(color, msg) { console.log(`${color}${msg}${c.reset}`); }

// ============================================
// CONVERSA SIMULADA
// ============================================
const CONVERSATION_FLOW = [
    {
        step: 1,
        user: 'Quais os dias tem vaga para fonoaudiologia?',
        validations: {
            notContains: ['parceria', 'currículo', 'e-mail', 'contato@'],  // NUNCA deve responder sobre emprego
            shouldContain: ['manhã', 'tarde', 'período', 'opção', 'horário', 'fono']
        }
    },
    {
        step: 2,
        user: 'De manhã',
        validations: {
            shouldContain: ['opção', 'A', 'B', 'C'],  // Deve oferecer opções
            notContains: ['parceria']  // Não deve desviar
        }
    },
    {
        step: 3,
        user: 'Tem pra mais cedo?',
        validations: {
            shouldContain: ['opção', 'manhã'],  // Deve buscar alternativas de manhã
            notContains: ['não entendi', 'pode repetir']  // Deve entender o pedido
        }
    },
    {
        step: 4,
        user: 'Opção A',
        validations: {
            shouldContain: ['nome completo'],  // Deve pedir dados do paciente
            leadState: {
                pendingPatientInfoForScheduling: true,
                pendingPatientInfoStep: 'name'
            }
        }
    },
    {
        step: 5,
        user: 'Maria Silva Santos',
        validations: {
            shouldContain: ['data de nascimento'],  // Deve pedir data
            leadState: {
                pendingPatientInfoStep: 'birth',
                'patientInfo.fullName': 'Maria Silva Santos'
            }
        }
    },
    {
        step: 6,
        user: '10/05/2020',
        validations: {
            shouldContain: ['confirmado', 'agendado', 'tudo certo'],  // Deve confirmar
            notContains: ['nome completo', 'data de nascimento']  // Não deve repetir pergunta
        }
    }
];

// ============================================
// SETUP
// ============================================
async function setupTest() {
    // Limpa dados anteriores
    await Leads.deleteMany({ phone: PHONE });
    await Contacts.deleteMany({ phone: PHONE });

    // Cria contato e lead
    const contact = await Contacts.create({
        name: TEST_LEAD_NAME,
        phone: PHONE,
        source: 'test_scheduling_flow'
    });

    const lead = await Leads.create({
        name: TEST_LEAD_NAME,
        phone: PHONE,
        contact: contact._id,
        source: 'test_scheduling_flow',
        stage: 'novo',
        autoReplyEnabled: true,
        qualificationData: { extractedInfo: {} }
    });

    return lead;
}

// ============================================
// EXECUÇÃO DO TESTE
// ============================================
async function runIntegrationTest() {
    log(c.cyan, '\n╔════════════════════════════════════════════════════════════════╗');
    log(c.cyan, '║  🧪 TESTE DE INTEGRAÇÃO: Fluxo Completo de Agendamento         ║');
    log(c.cyan, '║  📋 Valida: slots reais → escolha → coleta nome → coleta data ║');
    log(c.cyan, '╚════════════════════════════════════════════════════════════════╝\n');

    let lead = await setupTest();
    let allPassed = true;

    for (const step of CONVERSATION_FLOW) {
        log(c.blue, `  ── Etapa ${step.step}: ${step.user.substring(0, 40)}... ──`);

        try {
            // Busca lead atualizado
            lead = await Leads.findById(lead._id);

            // Chama a Amanda
            const response = await getOptimizedAmandaResponse({
                content: step.user,
                userText: step.user,
                lead: lead,
                context: { source: 'whatsapp-inbound' },
                messageId: `test-scheduling-${Date.now()}-${step.step}`
            });

            const responseText = typeof response === 'string'
                ? response.toLowerCase()
                : (response?.text || '').toLowerCase();

            log(c.gray, `  🤖 Amanda: "${responseText.substring(0, 80)}..."`);

            // Validações
            let stepPassed = true;

            // 1. Valida conteúdo que NÃO deve ter
            if (step.validations.notContains) {
                for (const forbidden of step.validations.notContains) {
                    if (responseText.includes(forbidden.toLowerCase())) {
                        log(c.red, `  ❌ Resposta contém "${forbidden}" (proibido)`);
                        stepPassed = false;
                    }
                }
            }

            // 2. Valida conteúdo que DEVE ter
            if (step.validations.shouldContain) {
                const found = step.validations.shouldContain.some(word =>
                    responseText.includes(word.toLowerCase())
                );
                if (!found) {
                    log(c.red, `  ❌ Resposta não contém nenhuma das palavras esperadas: [${step.validations.shouldContain.join(', ')}]`);
                    stepPassed = false;
                }
            }

            // 3. Valida estado do lead
            if (step.validations.leadState) {
                const freshLead = await Leads.findById(lead._id);
                for (const [key, expectedValue] of Object.entries(step.validations.leadState)) {
                    const actualValue = key.includes('.')
                        ? key.split('.').reduce((o, k) => o?.[k], freshLead)
                        : freshLead[key];

                    if (actualValue !== expectedValue) {
                        log(c.red, `  ❌ Lead.${key}: esperado="${expectedValue}", obtido="${actualValue}"`);
                        stepPassed = false;
                    }
                }
            }

            if (stepPassed) {
                log(c.green, `  ✅ Etapa ${step.step} passou`);
            } else {
                allPassed = false;
            }

        } catch (err) {
            log(c.red, `  💥 ERRO: ${err.message}`);
            allPassed = false;
        }

        console.log();
    }

    // Cleanup
    await Leads.deleteMany({ phone: PHONE });
    await Contacts.deleteMany({ phone: PHONE });

    // ============================================
    // RELATÓRIO
    // ============================================
    log(c.cyan, '═'.repeat(64));
    if (allPassed) {
        log(c.green, '  🎉 SUCESSO! Fluxo completo de agendamento funcionando!');
        log(c.green, '  ✅ Slots reais buscados (não parceria)');
        log(c.green, '  ✅ Alternativas "mais cedo" funcionando');
        log(c.green, '  ✅ Coleta de dados (nome → data) funcionando');
    } else {
        log(c.red, '  ❌ FALHA! Algumas etapas do fluxo falharam');
    }
    log(c.cyan, '═'.repeat(64));

    return allPassed;
}

// ============================================
// MAIN
// ============================================
async function main() {
    try {
        // Conecta ao MongoDB
        if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
            throw new Error('MONGO_URI ou MONGODB_URI não definido');
        }

        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        log(c.green, '✅ MongoDB conectado\n');

        const success = await runIntegrationTest();
        process.exit(success ? 0 : 1);

    } catch (err) {
        log(c.red, `\n⛔ ERRO CRÍTICO: ${err.message}`);
        log(c.red, err.stack);
        process.exit(1);
    }
}

main();
