// crons/learningCron.js (CRIAR)

import cron from 'node-cron';
import { analyzeHistoricalConversations } from '../services/amandaLearningService.js';

// Roda diariamente às 23h
export function startLearningCron() {
    cron.schedule('0 23 * * *', async () => {
        console.log('🧠 [CRON] Iniciando análise diária de aprendizado...');
        await analyzeHistoricalConversations();
    });

    console.log('✅ Learning Cron iniciado (23h diariamente)');
}