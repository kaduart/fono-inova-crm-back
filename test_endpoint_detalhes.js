#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { calculateDetailedProgress } from './services/planningService.js';

async function main() {
    try {
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        const Planning = (await import('./models/Planning.js')).default;
        const planning = await Planning.findOne({
            'period.start': { $lte: '2026-02-28' },
            'period.end': { $gte: '2026-02-01' }
        });

        if (!planning) {
            console.log('❌ Nenhum planejamento encontrado');
            return;
        }

        console.log('📊 Buscando detalhes do planejamento...\n');
        const details = await calculateDetailedProgress(planning._id);

        console.log('💰 DETALHAMENTO DA RECEITA:');
        console.log('=' .repeat(60));
        console.log(`Receita Total Realizada: R$ ${details.actual.actualRevenue}`);
        console.log(`  ├─ Particular: R$ ${details.actual.actualRevenueParticular || 0}`);
        console.log(`  ├─ Convênio (recebido): R$ ${details.actual.actualRevenueConvenio || 0}`);
        console.log(`  └─ Convênio (a receber): R$ ${details.actual.actualRevenueConvenioAReceber || 0}`);
        
        if (details.details.detalhamentoReceita) {
            console.log('\n📈 PERCENTUAIS:');
            console.log(`  Particular: ${details.details.detalhamentoReceita.particular.percentual}%`);
            console.log(`  Convênio: ${details.details.detalhamentoReceita.convenio.percentual}%`);
        }
        
        console.log('\n📋 OUTROS DADOS:');
        console.log(`Sessões: ${details.actual.completedSessions}`);
        console.log(`Horas: ${details.actual.workedHours}h`);
        console.log(`Gap para meta: R$ ${details.progress.gapRevenue}`);
        console.log(`Meta diária: R$ ${details.projections.dailyRevenueNeeded}/dia`);

    } catch (error) {
        console.error('❌ Erro:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

main();
