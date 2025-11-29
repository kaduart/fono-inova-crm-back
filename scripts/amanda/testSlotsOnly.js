//============================================================================
// 🔍 TESTE SIMPLES - BUSCA DE SLOTS (SEM CRIAR AGENDAMENTO)
// ============================================================================
// Arquivo: scripts/amanda/testSlotsOnly.js
//
// Execução: node scripts/amanda/testSlotsOnly.js
//
// Este script apenas BUSCA slots disponíveis sem criar nada no banco
// Útil para validar se a integração com a API de disponibilidade está ok
// ============================================================================

import 'dotenv/config';
import mongoose from 'mongoose';
import { findAvailableSlots, formatSlot } from '../../services/amandaBookingService.js';

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

async function testSlotsOnly() {
    console.log('\n' + '='.repeat(70));
    console.log('  🔍 TESTE: BUSCA DE SLOTS DISPONÍVEIS (SEM CRIAR AGENDAMENTO)');
    console.log('='.repeat(70) + '\n');

    try {
        // Conecta ao MongoDB
        console.log(`${colors.blue}📡${colors.reset} Conectando ao MongoDB...`);
        await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
        console.log(`${colors.green}✅${colors.reset} Conectado\n`);

        // Define áreas para testar
        const areasToTest = [
            'fonoaudiologia',
            'psicologia',
            'terapia_ocupacional',
            'fisioterapia'
        ];

        console.log(`${colors.cyan}🎯${colors.reset} Testando ${areasToTest.length} áreas de terapia\n`);

        // Testa cada área
        for (const area of areasToTest) {
            console.log(`${'─'.repeat(70)}`);
            console.log(`${colors.yellow}📋${colors.reset} Área: ${area.toUpperCase()}`);

            const slots = await findAvailableSlots({
                therapyArea: area,
                daysAhead: 7
            });

            if (!slots) {
                console.log(`   ${colors.red}❌${colors.reset} Nenhum slot disponível\n`);
                continue;
            }

            console.log(`   ${colors.green}✅${colors.reset} ${slots.totalFound} slots encontrados`);
            console.log(`\n   ${colors.cyan}🥇${colors.reset} MELHOR OPÇÃO:`);
            console.log(`      ${formatSlot(slots.primary)}`);

            if (slots.alternativesSamePeriod.length > 0) {
                console.log(`\n   ${colors.cyan}📅${colors.reset} ALTERNATIVAS (mesmo período):`);
                slots.alternativesSamePeriod.slice(0, 2).forEach((s, i) => {
                    console.log(`      ${i + 2}. ${formatSlot(s)}`);
                });
            }

            if (slots.alternativesOtherPeriod.length > 0) {
                console.log(`\n   ${colors.cyan}🔄${colors.reset} ALTERNATIVAS (outro período):`);
                slots.alternativesOtherPeriod.slice(0, 2).forEach((s, i) => {
                    console.log(`      ${formatSlot(s)}`);
                });
            }

            console.log('');
        }

        console.log(`${'='.repeat(70)}`);
        console.log(`${colors.green}✅${colors.reset} Teste concluído com sucesso!`);
        console.log(`${'='.repeat(70)}\n`);

    } catch (error) {
        console.error(`\n${colors.red}❌ ERRO:${colors.reset}`, error.message);
        console.error('\nStack:', error.stack);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log(`${colors.blue}📡${colors.reset} Desconectado do MongoDB\n`);
    }
}