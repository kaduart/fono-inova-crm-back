#!/usr/bin/env node
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { updatePlanningProgress } from './services/planningService.js';

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

        console.log('🔄 Atualizando planejamento...\n');
        const atualizado = await updatePlanningProgress(planning._id);

        console.log('\n📊 RESULTADO ATUALIZADO:');
        console.log('=' .repeat(50));
        console.log(`Receita Total: R$ ${atualizado.actual.actualRevenue}`);
        console.log(`  ├─ Particular: R$ ${atualizado.actual.actualRevenueParticular || 0}`);
        console.log(`  ├─ Convênio (recebido): R$ ${atualizado.actual.actualRevenueConvenio || 0}`);
        console.log(`  └─ Convênio (a receber): R$ ${atualizado.actual.actualRevenueConvenioAReceber || 0}`);
        console.log(`\nProgresso: ${atualizado.progress.revenuePercentage}% da meta`);

    } catch (error) {
        console.error('❌ Erro:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

main();
