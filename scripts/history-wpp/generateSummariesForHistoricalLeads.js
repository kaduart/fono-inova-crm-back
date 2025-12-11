// scripts/history-wpp/generateSummariesForHistoricalLeads.js
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Lead from '../../models/Leads.js';
import Message from '../../models/Message.js';
dotenv.config();

// importa da tua lib atual
import {
    generateConversationSummary,
    needsNewSummary
} from '../../services/conversationSummary.js'; 

async function generateSummariesForHistoricalLeads(limit = 200) {
    console.log('🧠 [SUMMARY] Iniciando geração de resumos para históricos...\n');

    // 1) Busca leads históricos
    const leads = await Lead.find({
        $or: [
            { tags: 'historico_importado' },
            { tags: 'importado' },
            { origin: 'WhatsApp' }
        ]
    })
        .sort({ lastInteractionAt: -1 })
        .limit(limit)
        .lean();


    console.log(`📊 Encontrados ${leads.length} leads históricos para analisar\n`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const lead of leads) {
        try {
            // 2) Conta mensagens desse lead
            const totalMessages = await Message.countDocuments({ lead: lead._id });

            if (!needsNewSummary(lead, totalMessages)) {
                skipped++;
                continue;
            }

            // 3) Busca mensagens em ordem cronológica
            const messages = await Message.find({ lead: lead._id })
                .sort({ timestamp: 1 })
                .select('direction content timestamp')
                .lean();

            if (!messages.length) {
                skipped++;
                continue;
            }

            // 4) Gera o resumo com Anthropic
            const summary = await generateConversationSummary(messages);
            if (!summary) {
                console.warn(`⚠️ [SUMMARY] Falhou para lead ${lead._id}`);
                errors++;
                continue;
            }

            // 5) Atualiza o lead com resumo
            const lastIndex = messages.length; // cobrimos até a última msg
            await Lead.findByIdAndUpdate(
                lead._id,
                {
                    $set: {
                        conversationSummary: summary,
                        summaryGeneratedAt: new Date(),
                        summaryCoversUntilMessage: lastIndex
                    }
                },
                { new: false }
            );

            updated++;
            console.log(
                `✅ [SUMMARY] Lead ${lead._id} atualizado (msgs: ${messages.length})`
            );

        } catch (err) {
            console.error(`❌ [SUMMARY] Erro com lead ${lead._id}:`, err.message);
            errors++;
        }
    }

    console.log('\n🎯 [SUMMARY] Finalizado!\n');
    console.log(`✅ Atualizados: ${updated}`);
    console.log(`⏭️ Ignorados (sem necessidade): ${skipped}`);
    console.log(`❌ Erros: ${errors}\n`);
}

async function main() {
    if (!process.env.MONGO_URI) {
        console.error('❌ MONGO_URI não definida no .env');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB conectado\n');

    const limit = Number(process.argv[2] || 200);
    await generateSummariesForHistoricalLeads(limit);

    await mongoose.disconnect();
    console.log('✅ MongoDB desconectado\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(err => {
        console.error('❌ Erro fatal no script de summaries:', err);
        process.exit(1);
    });
}
