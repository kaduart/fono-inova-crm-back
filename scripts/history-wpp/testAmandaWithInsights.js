// scripts/testAmandaWithInsights.js - VERSÃO COM DEBUG + NEURO

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

// ⚠️ IMPORTS RELATIVOS AO BACKEND (scripts/ está 1 nível abaixo)
import getOptimizedAmandaResponse from '../../utils/amandaOrchestrator.js';

import { getLatestInsights } from '../../services/amandaLearningService.js';
import Lead from '../../models/Leads.js';

async function testAmanda() {
    console.log('🧪 [TEST] Iniciando testes...\n');

    try {
        // 1) CONEXÃO MONGO
        console.log('📡 MONGO_URI:', process.env.MONGO_URI?.replace(/:[^:@]+@/, ':***@'));
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Conectado ao MongoDB\n');

        // 2) INSIGHTS
        console.log('🔍 Buscando insights...');
        const insights = await getLatestInsights();

        if (!insights) {
            console.log('⚠️ Nenhum insight encontrado. Rode antes: node scripts/runLearningAnalysis.js\n');
            return;
        }

        console.log('✅ Insights encontrados:', insights._id.toString());
        console.log(`📊 Leads analisados: ${insights.leadsAnalyzed}\n`);

        // (Opcional) Mostra um exemplo de resposta de preço aprendida
        if (insights.data?.effectivePriceResponses?.length) {
            const sample = insights.data.effectivePriceResponses[0];
            console.log('💡 Exemplo de resposta de preço aprendida:');
            console.log('   cenário:', sample.scenario);
            console.log('   resposta:', sample.response, '\n');
        }

        // 3) BUSCA UM LEAD IMPORTADO (Lead Histórico)
        console.log('🔍 Buscando lead de teste (Lead Histórico)...');
        const testLead = await Lead.findOne({ name: 'Lead Histórico' }).lean();

        if (!testLead) {
            console.log('⚠️ Nenhum lead "Lead Histórico" encontrado. Use um lead qualquer do banco.\n');
            return;
        }

        console.log('✅ Lead de teste encontrado:', testLead._id.toString(), '-', testLead.name, '\n');

        console.log('🎯 TESTES COM AMANDA:\n');
        console.log('━'.repeat(60));

        // ==========================
        // TESTE 1: Pergunta sobre preço fono
        // ==========================
        console.log('\n📝 TESTE 1: Pergunta sobre preço (fono)\n');
        console.log('👤 Lead: "quanto custa fono"\n');

        try {
            const response1 = await getOptimizedAmandaResponse({
                userText: 'quanto custa fono',
                lead: testLead,
                context: {
                    stage: 'pesquisando_preco',
                    messageCount: 3
                }
            });

            console.log('🤖 Amanda:', response1, '\n');
        } catch (error) {
            console.error('❌ Erro no teste 1:', error.message);
        }

        console.log('━'.repeat(60));

        // ==========================
        // TESTE 2: Interesse em agendar
        // ==========================
        console.log('\n📝 TESTE 2: Interesse em agendar\n');
        console.log('👤 Lead: "quero agendar"\n');

        try {
            const response2 = await getOptimizedAmandaResponse({
                userText: 'quero agendar uma consulta de fono',
                lead: testLead,
                context: { stage: 'engajado', messageCount: 5 }
            });

            console.log('🤖 Amanda:', response2, '\n');
        } catch (error) {
            console.error('❌ Erro no teste 2:', error.message);
        }

        console.log('━'.repeat(60));

        // ==========================
        // TESTE 3: Primeiro contato (saudação)
        // ==========================
        console.log('\n📝 TESTE 3: Primeiro contato\n');
        console.log('👤 Lead: "oi"\n');

        try {
            const response3 = await getOptimizedAmandaResponse({
                userText: 'oi',
                lead: { ...testLead, name: 'Maria' },
                context: { stage: 'novo', messageCount: 0 }
            });

            console.log('🤖 Amanda:', response3, '\n');
        } catch (error) {
            console.error('❌ Erro no teste 3:', error.message);
        }

        console.log('━'.repeat(60));

        // ==========================
        // TESTE 4: NEUROPSICOLÓGICA ADULTO (caso Flávia)
        // ==========================
        console.log('\n📝 TESTE 4: Avaliação Neuropsicológica (adulto, estilo Flávia)\n');
        const neuroText = `
Vi a página de Psicologia e gostaria de agendar uma Avaliação Neuropsicológica.

Sou adulta e tenho sentido lentidão, dificuldade de concentração, esquecimento
e dificuldade de organização no dia a dia. Já fiz uma bateria de exames médicos
e todos vieram normais, mas os sintomas continuam me preocupando.

Gostaria de entender se isso tem relação com funções cognitivas e quanto custa esse processo.
        `.trim();

        console.log('👤 Lead:\n', neuroText, '\n');

        try {
            const response4 = await getOptimizedAmandaResponse({
                userText: neuroText,
                lead: { ...testLead, name: 'Flávia' },
                context: {
                    stage: 'pesquisando_preco',
                    messageCount: 4,
                    mentionedTherapies: ['neuropsicologica']
                }
            });

            console.log('🤖 Amanda:', response4, '\n');
        } catch (error) {
            console.error('❌ Erro no teste 4:', error.message);
        }

        console.log('━'.repeat(60));
        console.log('\n✅ Testes concluídos!\n');
        console.log('💡 O que observar:');
        console.log('   - Se no TESTE 4 ela fala em 8–10 sessões, laudo, valor 2.000 etc.');
        console.log('   - Se mantém 1 💚 no final.');
        console.log('   - Se o tom está alinhado com o caso da Flávia.\n');

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
