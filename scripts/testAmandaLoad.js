// scripts/testAmandaLoad.js

import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config();

/**
 * 🔥 TESTE DE CARGA - 100 LEADS SIMULTÂNEOS
 */

async function loadTest() {
    await mongoose.connect(process.env.MONGODB_URI);

    console.log('🔥 Teste de carga: 100 leads respondendo simultaneamente...\n');

    const promises = [];
    const startTime = Date.now();

    for (let i = 0; i < 100; i++) {
        promises.push(
            getOptimizedAmandaResponse({
                userText: 'Quanto custa fono?',
                lead: { _id: null, name: `Lead${i}` }
            })
        );
    }

    const results = await Promise.all(promises);
    const duration = Date.now() - startTime;

    console.log(`✅ 100 respostas geradas em ${duration}ms`);
    console.log(`📊 Média: ${(duration / 100).toFixed(0)}ms por resposta`);
    console.log(`📊 Taxa: ${(100 / (duration / 1000)).toFixed(1)} respostas/segundo`);

    process.exit(0);
}

loadTest();