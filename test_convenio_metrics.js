#!/usr/bin/env node
/**
 * 🧪 Teste do ConvenioMetricsService
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import ConvenioMetricsService from './services/financial/ConvenioMetricsService.js';

dotenv.config();

async function main() {
    console.log('🧪 Testando ConvenioMetricsService...\n');

    try {
        // Conectar
        console.log('📡 Conectando ao MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
        console.log('✅ Conectado!\n');

        // Testar métricas de fevereiro/2026
        console.log('📊 Buscando métricas de convênio para Fevereiro/2026...\n');
        
        const metrics = await ConvenioMetricsService.getConvenioMetrics({
            month: 2,
            year: 2026
        });

        console.log('✅ MÉTRICAS RETORNADAS:\n');
        console.log(JSON.stringify(metrics, null, 2));

        console.log('\n\n📈 RESUMO EXECUTIVO:');
        console.log('====================');
        console.log(`Produção do Mês: ${new Intl.NumberFormat('pt-BR', {
            style: 'currency', 
            currency: 'BRL'
        }).format(metrics.resumo.producaoMes)}`);
        console.log(`A Receber: ${new Intl.NumberFormat('pt-BR', {
            style: 'currency', 
            currency: 'BRL'
        }).format(metrics.resumo.entradaEsperada)}`);
        console.log(`Cobertura Convênio: ${metrics.resumo.coberturaConvenio}%`);

        console.log('\n\n📦 ATIVOS:');
        console.log('==========');
        console.log(`Pacotes Ativos: ${metrics.ativos.pacotesConvenio}`);
        console.log(`Guias Ativas: ${metrics.ativos.guiasAtivas}`);
        console.log(`Sessões Disponíveis: ${metrics.ativos.totalSessoesDisponiveis}`);
        console.log(`Valor Estimado Disponível: ${new Intl.NumberFormat('pt-BR', {
            style: 'currency', 
            currency: 'BRL'
        }).format(metrics.ativos.valorTotalDisponivel)}`);

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

main();
