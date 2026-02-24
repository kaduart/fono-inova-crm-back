#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { calculateDetailedProgress } from './services/planningService.js';

async function main() {
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        // Buscar um planejamento ativo (fevereiro 2026)
        const Planning = (await import('./models/Planning.js')).default;
        const planning = await Planning.findOne({
            'period.start': { $lte: '2026-02-28' },
            'period.end': { $gte: '2026-02-01' }
        });

        if (!planning) {
            console.log('❌ Nenhum planejamento encontrado para fevereiro 2026');
            return;
        }

        console.log('📊 Planejamento encontrado:');
        console.log(`   Período: ${planning.period.start} a ${planning.period.end}`);
        console.log(`   Meta: R$ ${planning.targets.expectedRevenue}`);
        console.log(`   Sessões: ${planning.targets.totalSessions}\n`);

        const resultado = await calculateDetailedProgress(planning._id);

        console.log('💰 RESULTADO DETALHADO:');
        console.log('=' .repeat(50));
        console.log(`Receita Total Realizada: R$ ${resultado.actual.actualRevenue}`);
        console.log(`  ├─ Particular: R$ ${resultado.actual.actualRevenueParticular}`);
        console.log(`  └─ Convênio (recebido): R$ ${resultado.actual.actualRevenueConvenio}`);
        console.log(`Convênio (a receber): R$ ${resultado.actual.actualRevenueConvenioAReceber}`);
        console.log(`\nSessões: ${resultado.actual.completedSessions}`);
        console.log(`Horas: ${resultado.actual.workedHours}h`);
        
        if (resultado.details.detalhamentoReceita) {
            console.log('\n📈 DETALHAMENTO:');
            console.log(`  Particular: ${resultado.details.detalhamentoReceita.particular.percentual}%`);
            console.log(`  Convênio: ${resultado.details.detalhamentoReceita.convenio.percentual}%`);
        }

    } catch (error) {
        console.error('❌ Erro:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

main();
