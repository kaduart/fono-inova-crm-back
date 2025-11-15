// scripts/forceCleanInsights.js - LIMPEZA FORÇADA

import mongoose from 'mongoose';
import LearningInsight from '../models/LearningInsight.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * 🧹 LIMPA TEXTO
 */
function cleanText(text) {
    if (!text) return '';

    return text
        .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')
        .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '')
        .replace(/wa-wordmark-refreshed:/gi, '')
        .replace(/\[.*?\]/g, '')
        .replace(/Clínica Fono Inova:/gi, '')
        .replace(/\+55\s?\d{2}\s?\d{4,5}-?\d{4}/g, '')
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * ✅ VALIDA TEXTO
 */
function isValid(text) {
    if (!text || text.length < 3) return false;

    // Bloqueia se tiver lixo
    const junk = /wa-wordmark|ObjectId|\+55\s?\d{2}|\d{2}:\d{2}|\[.*?\]/i;
    if (junk.test(text)) return false;

    return true;
}

async function forceClean() {
    console.log('🧹 [FORCE CLEAN] Limpeza forçada...\n');

    await mongoose.connect(process.env.MONGO_URI);

    try {
        // 1. BUSCAR INSIGHT ATUAL
        const current = await LearningInsight.findOne({ type: 'conversation_patterns' })
            .sort({ generatedAt: -1 });

        if (!current) {
            console.log('⚠️ Nenhum insight encontrado\n');
            return;
        }

        console.log('📊 Insight atual:');
        console.log(`   Aberturas: ${current.data.bestOpeningLines?.length || 0}`);
        console.log(`   Respostas: ${current.data.effectivePriceResponses?.length || 0}`);
        console.log(`   Perguntas: ${current.data.successfulClosingQuestions?.length || 0}\n`);

        // 2. LIMPAR E VALIDAR
        const cleanedOpenings = (current.data.bestOpeningLines || [])
            .map(o => ({ ...o, text: cleanText(o.text) }))
            .filter(o => isValid(o.text));

        const cleanedResponses = (current.data.effectivePriceResponses || [])
            .map(r => ({ ...r, response: cleanText(r.response) }))
            .filter(r => isValid(r.response) && r.response.length > 10);

        const cleanedQuestions = (current.data.successfulClosingQuestions || [])
            .map(q => ({ ...q, question: cleanText(q.question) }))
            .filter(q => isValid(q.question) && q.question.length > 5);

        console.log('✅ Após limpeza:');
        console.log(`   Aberturas válidas: ${cleanedOpenings.length}`);
        console.log(`   Respostas válidas: ${cleanedResponses.length}`);
        console.log(`   Perguntas válidas: ${cleanedQuestions.length}\n`);

        // 3. DELETAR ANTIGO
        await LearningInsight.deleteMany({});
        console.log('🗑️ Insights antigos deletados\n');

        // 4. SALVAR LIMPO
        const cleaned = await LearningInsight.create({
            type: 'conversation_patterns',
            data: {
                bestOpeningLines: cleanedOpenings,
                effectivePriceResponses: cleanedResponses,
                successfulClosingQuestions: cleanedQuestions,
                commonObjections: []
            },
            leadsAnalyzed: current.leadsAnalyzed,
            conversationsAnalyzed: current.conversationsAnalyzed,
            dateRange: current.dateRange
        });

        console.log('💾 Insights limpos salvos:', cleaned._id, '\n');

        // 5. MOSTRAR EXEMPLOS
        if (cleanedOpenings.length > 0) {
            console.log('💡 ABERTURAS LIMPAS:');
            cleanedOpenings.slice(0, 3).forEach(o => {
                console.log(`   ✅ "${o.text}" (${o.usageCount}x)`);
            });
            console.log('');
        }

        if (cleanedQuestions.length > 0) {
            console.log('❓ PERGUNTAS LIMPAS:');
            cleanedQuestions.slice(0, 3).forEach(q => {
                console.log(`   ✅ "${q.question}"`);
            });
            console.log('');
        }

        console.log('✅ LIMPEZA CONCLUÍDA!\n');

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await mongoose.disconnect();
    }
}

forceClean();