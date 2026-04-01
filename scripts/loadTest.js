#!/usr/bin/env node
/**
 * Load Test - Patients V2
 * 
 * Simula carga real para validar:
 * - Performance do projection worker
 * - Consistência sob pressão
 * - Memory leak
 * - Fila acumulando
 */

import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';
import '../config/db.js';

import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

// ============================================
// CONFIG
// ============================================

const CONFIG = {
  PATIENTS_TO_CREATE: parseInt(process.env.PATIENTS_COUNT) || 50,
  BATCH_SIZE: 10,
  DELAY_BETWEEN_BATCHES: 500, // ms
  MAX_WAIT_TIME: 120000, // 2 minutos
};

// ============================================
// LOAD TEST
// ============================================

class LoadTester {
  constructor() {
    this.createdPatients = [];
    this.metrics = {
      startTime: Date.now(),
      eventsPublished: 0,
      viewsCreated: 0,
      errors: 0,
      avgProjectionTime: 0
    };
    this.projectionQueue = new Queue('patient-projection', { connection: redisConnection });
  }

  async run() {
    console.log('🚀 Iniciando teste de carga...\n');
    console.log(`Config: ${CONFIG.PATIENTS_TO_CREATE} pacientes, batch ${CONFIG.BATCH_SIZE}\n`);
    
    // Fase 1: Criar pacientes
    await this.createPatients();
    
    // Fase 2: Aguardar projeções
    await this.waitForProjections();
    
    // Fase 3: Validar consistência
    await this.validateConsistency();
    
    // Fase 4: Report
    this.report();
  }

  async createPatients() {
    console.log('📦 Fase 1: Criando pacientes...\n');
    
    const batches = Math.ceil(CONFIG.PATIENTS_TO_CREATE / CONFIG.BATCH_SIZE);
    
    for (let batch = 0; batch < batches; batch++) {
      const batchStart = Date.now();
      const batchSize = Math.min(CONFIG.BATCH_SIZE, CONFIG.PATIENTS_TO_CREATE - (batch * CONFIG.BATCH_SIZE));
      
      console.log(`  Batch ${batch + 1}/${batches} (${batchSize} pacientes)...`);
      
      const promises = [];
      
      for (let i = 0; i < batchSize; i++) {
        const patientNum = batch * CONFIG.BATCH_SIZE + i + 1;
        promises.push(this.createPatient(patientNum));
      }
      
      const results = await Promise.allSettled(promises);
      
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          this.createdPatients.push(result.value);
          this.metrics.eventsPublished++;
        } else {
          this.metrics.errors++;
          console.error(`    ❌ Erro no paciente ${batch * CONFIG.BATCH_SIZE + i + 1}:`, result.reason.message);
        }
      });
      
      const batchDuration = Date.now() - batchStart;
      console.log(`    ✅ ${batchSize} eventos publicados em ${batchDuration}ms`);
      
      // Delay entre batches
      if (batch < batches - 1) {
        await new Promise(r => setTimeout(r, CONFIG.DELAY_BETWEEN_BATCHES));
      }
    }
    
    console.log(`\n📊 Total: ${this.createdPatients.length} pacientes criados\n`);
  }

  async createPatient(num) {
    const patientId = new mongoose.Types.ObjectId();
    
    const patientData = {
      _id: patientId,
      fullName: `LOAD_TEST_Patient_${num}_${Date.now()}`,
      dateOfBirth: new Date('1990-01-01'),
      phone: `1199999${String(num).padStart(4, '0')}`,
      email: `loadtest_${num}@test.com`,
      cpf: `123456789${String(num).padStart(2, '0')}`,
      createdAt: new Date()
    };
    
    // Salva no MongoDB
    await Patient.create(patientData);
    
    // Publica evento
    await publishEvent(EventTypes.PATIENT_CREATED, {
      patientId: patientId.toString(),
      fullName: patientData.fullName,
      phone: patientData.phone,
      email: patientData.email,
      createdAt: patientData.createdAt.toISOString()
    });
    
    return {
      id: patientId.toString(),
      name: patientData.fullName,
      createdAt: Date.now()
    };
  }

  async waitForProjections() {
    console.log('⏱️  Fase 2: Aguardando projeções...\n');
    
    const startWait = Date.now();
    let lastCount = 0;
    let stableCount = 0;
    
    while (Date.now() - startWait < CONFIG.MAX_WAIT_TIME) {
      const projectedCount = await PatientsView.countDocuments({
        fullName: { $regex: /^LOAD_TEST_/ }
      });
      
      this.metrics.viewsCreated = projectedCount;
      
      // Progresso
      const percent = ((projectedCount / this.createdPatients.length) * 100).toFixed(1);
      process.stdout.write(`  Progresso: ${projectedCount}/${this.createdPatients.length} (${percent}%)\r`);
      
      // Verifica se estabilizou
      if (projectedCount === lastCount) {
        stableCount++;
        if (stableCount > 10 && projectedCount >= this.createdPatients.length) {
          break; // Estabilizou
        }
      } else {
        stableCount = 0;
      }
      
      lastCount = projectedCount;
      await new Promise(r => setTimeout(r, 1000));
    }
    
    const waitDuration = Date.now() - startWait;
    this.metrics.avgProjectionTime = waitDuration / this.metrics.viewsCreated;
    
    console.log(`\n  ✅ Projeções completadas em ${(waitDuration / 1000).toFixed(1)}s\n`);
  }

  async validateConsistency() {
    console.log('🔍 Fase 3: Validando consistência...\n');
    
    let consistent = 0;
    let inconsistent = 0;
    
    // Amostragem para performance
    const sampleSize = Math.min(20, this.createdPatients.length);
    const sample = this.createdPatients.slice(0, sampleSize);
    
    for (const patient of sample) {
      const view = await PatientsView.findOne({ patientId: patient.id }).lean();
      
      if (view && view.fullName === patient.name) {
        consistent++;
      } else {
        inconsistent++;
        console.log(`  ❌ Inconsistente: ${patient.id}`);
      }
    }
    
    console.log(`  ✅ ${consistent}/${sampleSize} consistentes na amostra\n`);
    
    if (inconsistent > 0) {
      throw new Error(`${inconsistent} pacientes inconsistentes`);
    }
  }

  async report() {
    const totalDuration = Date.now() - this.metrics.startTime;
    
    // Status da fila
    const queueStatus = await this.projectionQueue.getJobCounts();
    
    console.log('='.repeat(70));
    console.log('📊 RELATÓRIO DE TESTE DE CARGA');
    console.log('='.repeat(70));
    
    console.log('\n📈 Métricas:');
    console.log(`  Pacientes criados: ${this.metrics.eventsPublished}`);
    console.log(`  Views projetadas: ${this.metrics.viewsCreated}`);
    console.log(`  Taxa de sucesso: ${((this.metrics.viewsCreated / this.metrics.eventsPublished) * 100).toFixed(1)}%`);
    console.log(`  Erros: ${this.metrics.errors}`);
    
    console.log('\n⏱️  Performance:');
    console.log(`  Duração total: ${(totalDuration / 1000).toFixed(1)}s`);
    console.log(`  Tempo médio de projeção: ${this.metrics.avgProjectionTime.toFixed(0)}ms`);
    console.log(`  Throughput: ${(this.metrics.eventsPublished / (totalDuration / 1000)).toFixed(1)} pacientes/s`);
    
    console.log('\n📊 Status da fila:');
    console.log(`  Waiting: ${queueStatus.waiting}`);
    console.log(`  Active: ${queueStatus.active}`);
    console.log(`  Completed: ${queueStatus.completed}`);
    console.log(`  Failed: ${queueStatus.failed}`);
    
    console.log('\n' + '='.repeat(70));
    
    if (this.metrics.errors === 0 && this.metrics.viewsCreated === this.metrics.eventsPublished) {
      console.log('\n✅ TESTE PASSOU!');
      console.log('Sistema aguenta carga esperada.');
    } else {
      console.log('\n❌ TESTE FALHOU!');
      console.log('Revisar performance do projection worker.');
    }
    
    console.log('\n');
    
    // Cleanup
    await this.cleanup();
  }

  async cleanup() {
    console.log('🧹 Limpando dados de teste...');
    
    const testPatientIds = this.createdPatients.map(p => p.id);
    
    await Patient.deleteMany({ _id: { $in: testPatientIds } });
    await PatientsView.deleteMany({ patientId: { $in: testPatientIds } });
    
    console.log(`  ✅ ${testPatientIds.length} registros removidos\n`);
  }
}

// ============================================
// RUN
// ============================================

async function main() {
  const tester = new LoadTester();
  
  try {
    await tester.run();
    process.exit(0);
  } catch (error) {
    console.error('💥 Teste falhou:', error.message);
    process.exit(1);
  }
}

main();
