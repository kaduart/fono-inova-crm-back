import mongoose from 'mongoose';

import LearningInsight from '../models/LearningInsight.js';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);

const latest = await LearningInsight.findOne()
  .sort({ generatedAt: -1 })
  .lean();

console.log('📅 Última execução:', new Date(latest.generatedAt).toLocaleString('pt-BR'));
console.log('📊 Leads analisados:', latest.leadsAnalyzed);
console.log('💬 Conversas analisadas:', latest.conversationsAnalyzed);
console.log('\n📈 Top 3 aberturas:');
latest.data.bestOpeningLines.slice(0, 3).forEach((line, i) => {
  console.log(`${i+1}. "${line.text.substring(0, 60)}..."`);
});

mongoose.disconnect();
