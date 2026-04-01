#!/usr/bin/env node
import 'dotenv/config';
import { TestRunner } from './framework/TestRunner.js';
import { Fixtures } from './framework/Fixtures.js';
import { startRedis } from '../services/redisClient.js';
import completeToInvoiceScenario from './scenarios/complete-to-invoice.scenario.js';

async function main() {
  console.log('🧪 Teste único: Complete → Invoice\n');
  const runner = new TestRunner({ timeout: 20000, pollInterval: 500 });
  
  try {
    await runner.beforeAll();
    await startRedis();
    console.log('✅ Redis conectado');
    // NOTA: Workers são do servidor (já rodando), não iniciar aqui
    console.log('✅ Usando workers do servidor\n');
    
    runner.context.fixtures = new Fixtures();
    const result = await runner.run(completeToInvoiceScenario);
    
    console.log('\n📊 Resultado:', result.success ? '✅ PASSOU' : '❌ FALHOU');
    if (!result.success) console.log('Erro:', result.error);
    
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error('❌ Erro fatal:', error.message);
    process.exit(1);
  } finally {
    console.log('\n⏳ Aguardando estabilização...');
    try { await runner.waitForStabilization({}, 8000); } catch (e) {}
    // NOTA: Não parar workers do servidor
    await runner.afterAll();
  }
}

main();
