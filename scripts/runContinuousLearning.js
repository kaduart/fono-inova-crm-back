#!/usr/bin/env node
// scripts/runContinuousLearning.js
// Executa análise de aprendizado manualmente

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { runManualLearningCycle, generateDailyReport, generateWeeklyReport } from '../crons/learningCron.js';

const COMMAND = process.argv[2] || 'run';

async function main() {
  console.log('🧠 [CLI] Amanda Continuous Learning\n');
  
  try {
    // Conecta ao MongoDB
    console.log('📡 Conectando ao MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado\n');
    
    switch (COMMAND) {
      case 'run':
      case 'cycle':
        console.log('🚀 Executando ciclo completo de aprendizado...\n');
        const results = await runManualLearningCycle();
        console.log('\n📊 RESULTADOS:');
        console.log(JSON.stringify(results, null, 2));
        break;
        
      case 'daily':
      case 'report':
        console.log('📊 Gerando relatório diário...\n');
        const dailyReport = await generateDailyReport();
        console.log(dailyReport);
        break;
        
      case 'weekly':
        console.log('📈 Gerando relatório semanal...\n');
        const weeklyReport = await generateWeeklyReport();
        console.log(weeklyReport);
        break;
        
      default:
        console.log(`
Uso: node runContinuousLearning.js [comando]

Comandos:
  run, cycle    Executa ciclo completo de análise
  daily, report Gera relatório do dia
  weekly        Gera relatório da semana

Exemplos:
  node runContinuousLearning.js run
  node runContinuousLearning.js daily
        `);
    }
    
  } catch (error) {
    console.error('❌ Erro:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Desconectado');
  }
}

main();
