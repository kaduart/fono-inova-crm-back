import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Leads from '../../models/Leads.js';
dotenv.config();

async function migrate() {
    try {
       // 1. MOSTRA CONEXÃO
              console.log('📡 MONGO_URI:', process.env.MONGO_URI?.replace(/:[^:@]+@/, ':***@'));
              
              await mongoose.connect(process.env.MONGO_URI);
              console.log('✅ Conectado ao MongoDB\n');
              
              // 2. MOSTRA DATABASE ATUAL
        const result = await Leads.updateMany(
            {
                conversationSummary: { $exists: false }
            },
            {
                $set: {
                    conversationSummary: null,
                    summaryGeneratedAt: null,
                    summaryCoversUntilMessage: 0
                }
            }
        );

        console.log(`✅ Migration concluída: ${result.modifiedCount} leads atualizados`);
        process.exit(0);
    } catch (error) {
        console.error('❌ Erro na migration:', error);
        process.exit(1);
    }
}

migrate();