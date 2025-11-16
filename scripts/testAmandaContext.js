import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import enrichLeadContext from '../services/leadContext.js';

async function test() {
    try {
        await mongoose.connect(process.env.MONGO_URI);

        // Lead do log com 159 msgs
        const leadId = '690fefd4f645d0fd6a114b19';

        console.log('🧪 Testando contexto inteligente com lead real...\n');
        console.log('⏳ Processando (pode demorar ~3s se gerar resumo)...\n');

        const startTime = Date.now();
        const context = await enrichLeadContext(leadId);
        const duration = Date.now() - startTime;

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 RESULTADO DO TESTE');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        console.log('👤 DADOS DO LEAD:');
        console.log(`   Nome: ${context.name}`);
        console.log(`   Telefone: ${context.phone}`);
        console.log(`   Origem: ${context.origin}`);
        console.log(`   Status: ${context.status}\n`);

        console.log('📈 MÉTRICAS:');
        console.log(`   Total de mensagens: ${context.messageCount}`);
        console.log(`   Estágio: ${context.stage}`);
        console.log(`   Dias sem contato: ${context.daysSinceLastContact}`);
        console.log(`   Score: ${context.conversionScore}\n`);

        console.log('🧠 CONTEXTO INTELIGENTE:');
        console.log(`   Histórico carregado: ${context.conversationHistory.length} msgs`);
        console.log(`   Tem resumo? ${context.conversationSummary ? '✅ SIM' : '❌ NÃO'}`);
        console.log(`   Deve cumprimentar? ${context.shouldGreet ? 'SIM' : 'NÃO'}`);
        console.log(`   Tempo de processamento: ${duration}ms\n`);

        if (context.conversationSummary) {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📋 RESUMO GERADO:');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            console.log(context.conversationSummary);
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        }

        console.log('📜 HISTÓRICO (primeiras 5 msgs):');
        context.conversationHistory.slice(0, 5).forEach((msg, idx) => {
            const role = msg.role === 'user' ? '👤 CLIENTE' : '🤖 AMANDA';
            const preview = msg.content.substring(0, 80) + (msg.content.length > 80 ? '...' : '');
            console.log(`   ${idx + 1}. ${role}: ${preview}`);
        });

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ TESTE CONCLUÍDO COM SUCESSO');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        process.exit(0);
    } catch (error) {
        console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ ERRO NO TESTE:');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.error(error);
        console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        process.exit(1);
    }
}

test();