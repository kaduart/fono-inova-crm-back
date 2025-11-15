// scripts/testAmandaWithInsights.js - VERSÃO COM DEBUG

import mongoose from 'mongoose';
import getOptimizedAmandaResponse from '../utils/amandaOrchestrator.js';
import { getLatestInsights } from '../services/amandaLearningService.js';
import Lead from '../models/Leads.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * 🧪 TESTA AMANDA COM DIFERENTES CENÁRIOS
 */
async function testAmanda() {
    console.log('🧪 [TEST] Iniciando testes...\n');

    try {
        // 1. CONECTA MONGODB
        // 1. MOSTRA CONEXÃO
              console.log('📡 MONGO_URI:', process.env.MONGO_URI?.replace(/:[^:@]+@/, ':***@'));
              
              await mongoose.connect(process.env.MONGO_URI);
              console.log('✅ Conectado ao MongoDB\n');
              
              // 2. MOSTRA DATABASE ATUAL
              const dbName = mongoose.connection.db.databaseName;
              

        // 2. BUSCA INSIGHTS
        console.log('🔍 Buscando insights...');
        const insights = await getLatestInsights();

        if (!insights) {
            console.log('⚠️ Nenhum insight encontrado. Rode a análise primeiro:\n');
            console.log('   node scripts/runLearningAnalysis.js\n');
            await mongoose.disconnect();
            return;
        }

        console.log('✅ Insights encontrados:', insights._id);
        console.log(`📊 ${insights.leadsAnalyzed} leads analisados\n`);

        // 3. BUSCA LEAD DE TESTE
        console.log('🔍 Buscando lead de teste...');
        const testLead = await Lead.findOne({ name: 'Lead Histórico' }).lean();

        if (!testLead) {
            console.log('⚠️ Nenhum lead de teste encontrado\n');
            await mongoose.disconnect();
            return;
        }

        console.log('✅ Lead de teste encontrado:', testLead.name, '\n');

        console.log('🎯 TESTES COM AMANDA:\n');
        console.log('━'.repeat(60));

        // TESTE 1: Pergunta sobre preço
        console.log('\n📝 TESTE 1: Pergunta sobre preço\n');
        console.log('👤 Lead: "quanto custa fono"\n');

        try {
            const response1 = await getOptimizedAmandaResponse({
                userText: 'quanto custa fono',
                lead: testLead,
                context: {}
            });

            console.log('🤖 Amanda:', response1);
        } catch (error) {
            console.error('❌ Erro no teste 1:', error.message);
        }

        console.log('\n━'.repeat(60));

        // TESTE 2: Interesse em agendar
        console.log('\n📝 TESTE 2: Interesse em agendar\n');
        console.log('👤 Lead: "quero agendar"\n');

        try {
            const response2 = await getOptimizedAmandaResponse({
                userText: 'quero agendar',
                lead: testLead,
                context: { stage: 'engajado', messageCount: 3 }
            });

            console.log('🤖 Amanda:', response2);
        } catch (error) {
            console.error('❌ Erro no teste 2:', error.message);
        }

        console.log('\n━'.repeat(60));

        // TESTE 3: Primeiro contato
        console.log('\n📝 TESTE 3: Primeiro contato\n');
        console.log('👤 Lead: "oi"\n');

        try {
            const response3 = await getOptimizedAmandaResponse({
                userText: 'oi',
                lead: { ...testLead, name: 'Maria' },
                context: { stage: 'novo', messageCount: 0 }
            });

            console.log('🤖 Amanda:', response3);
        } catch (error) {
            console.error('❌ Erro no teste 3:', error.message);
        }

        console.log('\n━'.repeat(60));

        console.log('\n✅ Testes concluídos!\n');
        console.log('💡 Observe se Amanda está usando insights aprendidos:');
        console.log('   - Respostas de preço contextualizadas');
        console.log('   - Perguntas engajadoras');
        console.log('   - Tom adaptado ao estágio\n');

    } catch (error) {
        console.error('❌ Erro geral:', error);
        console.error('Stack:', error.stack);
    } finally {
        await mongoose.disconnect();
        console.log('✅ Desconectado do MongoDB\n');
    }
}

testAmanda().catch(error => {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
});