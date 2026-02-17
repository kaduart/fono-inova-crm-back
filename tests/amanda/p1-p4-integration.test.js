#!/usr/bin/env node
/**
 * 🧪 TESTES DE INTEGRAÇÃO P1-P4
 * 
 * Foco: Validar que as flags estão sendo detectadas corretamente
 * e o fluxo do orchestrator está direcionando corretamente
 * 
 * Uso: node -r dotenv/config tests/amanda/p1-p4-integration.test.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../../orchestrators/AmandaOrchestrator.js';
import { deriveFlagsFromText } from '../../utils/flagsDetector.js';
import Leads from '../../models/Leads.js';
import Contacts from '../../models/Contacts.js';

const PHONE = '5562999990001';

// Cenários críticos P1-P4
const CRITICAL_SCENARIOS = [
    // P1: Desambiguação Vaga
    { name: 'P1-A1: "tem vaga" simples', text: 'tem vaga', expectFlags: { wantsSchedule: true, wantsPartnershipOrResume: false } },
    { name: 'P1-A2: "Quais os dias tem vaga" (caso real)', text: 'Quais os dias tem vaga', expectFlags: { wantsSchedule: true, wantsPartnershipOrResume: false }, critical: true },
    { name: 'P1-P1: "vaga de trabalho"', text: 'Tem vaga de trabalho?', expectFlags: { wantsPartnershipOrResume: true } },
    { name: 'P1-P2: "enviar currículo"', text: 'Gostaria de enviar meu currículo', expectFlags: { wantsPartnershipOrResume: true } },
    
    // P2: Mais Opções
    { name: 'P2-01: "mais cedo"', text: 'Tem algo mais cedo?', expectFlags: { wantsMoreOptions: true } },
    { name: 'P2-02: "outro horário"', text: 'Tem outro horário?', expectFlags: { wantsMoreOptions: true } },
    
    // P3: Confirmação
    { name: 'P3-01: "pode ser"', text: 'pode ser', expectFlags: { confirmsData: true } },
    
    // Caso real do log
    { name: 'REAL: Caso do log "Quais os dias tem vaga"', text: 'Quais os dias tem vaga', expectFlags: { wantsSchedule: true, wantsPartnershipOrResume: false }, critical: true },
];

async function setupLead() {
    await Leads.deleteMany({ phone: PHONE });
    let contact = await Contacts.findOne({ phone: PHONE });
    if (!contact) {
        contact = await Contacts.create({ name: 'Teste P1-P4', phone: PHONE, source: 'test_p1p4' });
    }
    return Leads.create({
        name: 'Teste P1-P4',
        phone: PHONE,
        contact: contact._id,
        source: 'test_p1p4',
        stage: 'novo',
        autoReplyEnabled: true,
        qualificationData: { extractedInfo: {} }
    });
}

async function main() {
    console.log('\n🧪 TESTES DE INTEGRAÇÃO P1-P4\n');
    
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB conectado\n');

    let passed = 0;
    let failed = 0;

    for (const scenario of CRITICAL_SCENARIOS) {
        process.stdout.write(`${scenario.critical ? '🔴' : '  '} ${scenario.name}... `);
        
        const flags = deriveFlagsFromText(scenario.text);
        let ok = true;
        
        for (const [flag, expected] of Object.entries(scenario.expectFlags)) {
            if (flags[flag] !== expected) {
                ok = false;
                console.log(`\n   ❌ ${flag}: esperado ${expected}, obtido ${flags[flag]}`);
            }
        }
        
        if (ok) {
            console.log('✅');
            passed++;
        } else {
            failed++;
        }
    }

    console.log(`\n📊 Resultado: ${passed}/${CRITICAL_SCENARIOS.length} passaram`);
    if (failed > 0) console.log(`   ❌ ${failed} falhas`);

    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
