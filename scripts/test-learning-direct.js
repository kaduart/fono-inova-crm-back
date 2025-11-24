import mongoose from 'mongoose';
import { analyzeHistoricalConversations } from '../services/amandaLearningService.js';
import dotenv from 'dotenv';
dotenv.config();

console.log('🔗 Conectando MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);


console.log('🧠 Executando análise...\n');
const result = await analyzeHistoricalConversations();

console.log('\n📊 Resultado:', result ? 'Sucesso!' : 'Nenhum lead convertido');

if (result) {
  console.log('✅ ID do insight:', result._id);
  console.log('📈 Leads analisados:', result.leadsAnalyzed);
}

mongoose.disconnect();
