#!/usr/bin/env node
// tests/runChaosTests.js
// Executor de Chaos Tests - Quebra o sistema de propósito para provar resiliência

import 'dotenv/config.js';
import mongoose from 'mongoose';
import TestDatabase from './framework/TestDatabase.js';
import TestFixtures from './framework/TestFixtures.js';
import TestRunner from './framework/TestRunner.js';

// Cenários de caos
import chaosWorkerDies from './scenarios/chaos-worker-dies.scenario.js';
import chaosMongoFailure from './scenarios/chaos-mongo-failure.scenario.js';
import chaosEventStorm from './scenarios/chaos-event-storm.scenario.js';
import chaosPartialCommit from './scenarios/chaos-partial-commit.scenario.js';

const CHAOS_SCENARIOS = [
  chaosWorkerDies,
  chaosMongoFailure,
  chaosEventStorm,
  chaosPartialCommit
];

class ChaosEngine {
  constructor() {
    this.results = [];
    this.startTime = null;
  }
  
  async init() {
    console.log('\n' + '='.repeat(70));
    console.log('  🔥🔥🔥  CHAOS ENGINE  🔥🔥🔥');
    console.log('  Sistema será quebrado para provar resiliência');
    console.log('='.repeat(70) + '\n');
    
    // Valida ambiente
    if (process.env.MONGO_URI?.includes('production')) {
      console.error('❌ REFUSING TO RUN CHAOS ON PRODUCTION');
      process.exit(1);
    }
    
    if (!process.env.MONGO_URI?.includes('test')) {
      console.error('❌ Chaos tests MUST use a test database');
      process.exit(1);
    }
    
    console.log('✅ Ambiente validado (test database)');
    console.log(`🗄️  Database: ${process.env.MONGO_URI}\n`);
    
    this.startTime = Date.now();
  }
  
  async runScenario(scenario) {
    const scenarioStart = Date.now();
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  💥 ${scenario.name}`);
    console.log('='.repeat(70));
    
    const runner = new TestRunner();
    const db = new TestDatabase();
    const fixtures = new TestFixtures();
    
    try {
      // Setup
      console.log('\n  🔧 Setup...');
      await db.connect();
      await db.cleanDatabase();
      
      const ctx = { runner, db, fixtures };
      const setupData = await scenario.setup(ctx);
      
      // Execute
      console.log('  ⚡ Executando caos...\n');
      const result = await scenario.execute({ 
        data: setupData, 
        runner 
      });
      
      // Assert
      console.log('\n  🔍 Validando recuperação...');
      await scenario.assert({ 
        data: { ...setupData, result }, 
        runner 
      });
      
      // Cleanup
      await scenario.cleanup({ data: setupData, fixtures });
      await db.disconnect();
      
      const duration = Date.now() - scenarioStart;
      
      console.log(`\n  ✅ CHAOS SURVIVED (${duration}ms)`);
      
      return {
        name: scenario.name,
        status: 'PASSED',
        duration
      };
      
    } catch (error) {
      const duration = Date.now() - scenarioStart;
      
      console.error(`\n  💥 CHAOS REVEALED FAILURE (${duration}ms)`);
      console.error(`  ❌ ${error.message}\n`);
      
      // Cleanup mesmo em erro
      try {
        await fixtures.cleanup?.();
        await db.disconnect();
      } catch {}
      
      return {
        name: scenario.name,
        status: 'FAILED',
        error: error.message,
        duration
      };
    }
  }
  
  async run() {
    await this.init();
    
    for (const scenario of CHAOS_SCENARIOS) {
      const result = await this.runScenario(scenario);
      this.results.push(result);
    }
    
    this.printReport();
  }
  
  printReport() {
    const totalTime = Date.now() - this.startTime;
    const passed = this.results.filter(r => r.status === 'PASSED').length;
    const failed = this.results.filter(r => r.status === 'FAILED').length;
    
    console.log('\n' + '='.repeat(70));
    console.log('  📊 CHAOS REPORT');
    console.log('='.repeat(70));
    
    this.results.forEach(r => {
      const icon = r.status === 'PASSED' ? '✅' : '💥';
      console.log(`  ${icon} ${r.name} (${r.duration}ms)`);
      if (r.error) {
        console.log(`     ❌ ${r.error.substring(0, 100)}`);
      }
    });
    
    console.log('\n' + '-'.repeat(70));
    console.log(`  Total: ${this.results.length} chaos tests`);
    console.log(`  ✅ Survived: ${passed}`);
    console.log(`  💥 Failed: ${failed}`);
    console.log(`  ⏱️  Duration: ${totalTime}ms`);
    console.log('-'.repeat(70));
    
    if (failed === 0) {
      console.log('\n  🔥🔥🔥 SYSTEM IS CHAOS-PROOF 🔥🔥🔥\n');
      process.exit(0);
    } else {
      console.log('\n  ⚠️  System needs hardening\n');
      process.exit(1);
    }
  }
}

// Run
const engine = new ChaosEngine();
engine.run().catch(err => {
  console.error('💥 Engine crash:', err);
  process.exit(1);
});
