
import mongoose from 'mongoose';
import analyzeHistoricalConversations from '../../services/amandaLearningService.js';
import dotenv from 'dotenv';
dotenv.config();
async function main() {
    console.log('🧠 [ANALYSIS] Iniciando análise de aprendizado...\n');

    try {
        // Conecta MongoDB
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB conectado\n');

        // Roda análise
        const insights = await analyzeHistoricalConversations();

        if (insights) {
            console.log('\n✅ ANÁLISE CONCLUÍDA!\n');
            console.log('📊 RESULTADOS:');
            console.log(`   Leads analisados: ${insights.leadsAnalyzed}`);
            console.log(`   Conversas analisadas: ${insights.conversationsAnalyzed}`);
            console.log(`   Aberturas descobertas: ${insights.data.bestOpeningLines?.length || 0}`);
            console.log(`   Respostas de preço: ${insights.data.effectivePriceResponses?.length || 0}`);
            console.log(`   Perguntas de fechamento: ${insights.data.successfulClosingQuestions?.length || 0}`);
            console.log(`\n💾 Insights salvos: ${insights._id}\n`);

            // Mostra exemplo de insight
            if (insights.data.bestOpeningLines?.length > 0) {
                console.log('💡 EXEMPLO - Melhor abertura:');
                const best = insights.data.bestOpeningLines[0];
                console.log(`   "${best.text}"`);
                console.log(`   Origem: ${best.leadOrigin} | Usada: ${best.usageCount}x\n`);
            }
        } else {
            console.log('\n⚠️ Nenhum insight gerado (sem leads convertidos)\n');
        }

    } catch (error) {
        console.error('❌ Erro:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('✅ Análise finalizada!\n');
    }
}

main();