#!/usr/bin/env node
/**
 * Validate Consistency
 * 
 * Compara dados entre collections e PatientsView.
 * Detecta divergências que indicam bugs na projeção.
 */

import mongoose from 'mongoose';
import '../config/db.js'; // Conecta ao MongoDB

import Patient from '../models/Patient.js';
import PatientsView from '../models/PatientsView.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';

// ============================================
// CONFIG
// ============================================

const SAMPLE_SIZE = parseInt(process.env.SAMPLE_SIZE) || 100;
const VERBOSE = process.env.VERBOSE === 'true';

// ============================================
// VALIDATORS
// ============================================

class ConsistencyValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.stats = {
      patientsChecked: 0,
      viewsChecked: 0,
      appointmentsChecked: 0,
      paymentsChecked: 0
    };
  }

  async validate() {
    console.log('🔍 Validando consistência entre domínio e projeção...\n');
    
    await this.validatePatientCounts();
    await this.validateAppointmentCounts();
    await this.validatePaymentTotals();
    await this.validateViewFreshness();
    
    this.report();
  }

  // ==========================================
  // VALIDATION 1: Contagem de pacientes
  // ==========================================
  
  async validatePatientCounts() {
    console.log('📊 Validando contagem de pacientes...');
    
    const totalPatients = await Patient.countDocuments();
    const totalViews = await PatientsView.countDocuments();
    
    this.stats.patientsChecked = totalPatients;
    this.stats.viewsChecked = totalViews;
    
    if (totalPatients !== totalViews) {
      this.errors.push({
        type: 'COUNT_MISMATCH',
        message: `Divergência: ${totalPatients} patients vs ${totalViews} views`,
        severity: 'HIGH'
      });
      
      // Encontra pacientes sem view
      const patientIds = await Patient.find({}, '_id').lean();
      const viewPatientIds = await PatientsView.find({}, 'patientId').lean();
      const viewIdsSet = new Set(viewPatientIds.map(v => v.patientId.toString()));
      
      const missingViews = patientIds
        .filter(p => !viewIdsSet.has(p._id.toString()))
        .map(p => p._id.toString());
      
      if (missingViews.length > 0) {
        this.errors.push({
          type: 'MISSING_VIEWS',
          message: `${missingViews.length} pacientes sem view`,
          sample: missingViews.slice(0, 5),
          severity: 'HIGH'
        });
      }
      
      // Encontra views órfãs
      const patientIdsSet = new Set(patientIds.map(p => p._id.toString()));
      const orphanViews = viewPatientIds
        .filter(v => !patientIdsSet.has(v.patientId.toString()))
        .map(v => v.patientId.toString());
      
      if (orphanViews.length > 0) {
        this.warnings.push({
          type: 'ORPHAN_VIEWS',
          message: `${orphanViews.length} views sem paciente correspondente`,
          sample: orphanViews.slice(0, 5),
          severity: 'MEDIUM'
        });
      }
    } else {
      console.log(`  ✅ ${totalPatients} pacientes = ${totalViews} views`);
    }
  }

  // ==========================================
  // VALIDATION 2: Contagem de appointments
  // ==========================================
  
  async validateAppointmentCounts() {
    console.log('📅 Validando contagem de appointments...');
    
    // Amostragem para performance
    const samplePatients = await Patient.find({}, '_id').limit(SAMPLE_SIZE).lean();
    
    let mismatches = 0;
    
    for (const patient of samplePatients) {
      const patientId = patient._id.toString();
      
      // Conta no domínio
      const realCount = await Appointment.countDocuments({ patient: patientId });
      
      // Conta na view
      const view = await PatientsView.findOne({ patientId }).lean();
      const viewCount = view?.stats?.totalAppointments || 0;
      
      if (realCount !== viewCount) {
        mismatches++;
        
        if (VERBOSE || mismatches <= 5) {
          this.errors.push({
            type: 'APPOINTMENT_COUNT_MISMATCH',
            patientId,
            message: `Patient ${patientId}: ${realCount} real vs ${viewCount} na view`,
            severity: 'HIGH'
          });
        }
      }
    }
    
    this.stats.appointmentsChecked = samplePatients.length;
    
    if (mismatches === 0) {
      console.log(`  ✅ ${samplePatients.length} pacientes verificados, todos consistentes`);
    } else {
      console.log(`  ❌ ${mismatches}/${samplePatients.length} pacientes com divergência`);
    }
  }

  // ==========================================
  // VALIDATION 3: Totais de pagamento
  // ==========================================
  
  async validatePaymentTotals() {
    console.log('💰 Validando totais de pagamento...');
    
    const samplePatients = await Patient.find({}, '_id').limit(SAMPLE_SIZE).lean();
    
    let mismatches = 0;
    let totalDiff = 0;
    
    for (const patient of samplePatients) {
      const patientId = patient._id.toString();
      
      // Calcula no domínio
      const payments = await Payment.find({ 
        patient: patientId,
        status: 'completed'
      }).lean();
      
      const realTotal = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
      
      // Pega da view
      const view = await PatientsView.findOne({ patientId }).lean();
      const viewTotal = view?.stats?.totalRevenue || 0;
      
      const diff = Math.abs(realTotal - viewTotal);
      
      if (diff > 0.01) { // tolerância de 1 centavo
        mismatches++;
        totalDiff += diff;
        
        if (VERBOSE || mismatches <= 5) {
          this.errors.push({
            type: 'PAYMENT_TOTAL_MISMATCH',
            patientId,
            message: `Patient ${patientId}: R$ ${realTotal.toFixed(2)} real vs R$ ${viewTotal.toFixed(2)} na view (diff: R$ ${diff.toFixed(2)})`,
            severity: 'HIGH'
          });
        }
      }
    }
    
    this.stats.paymentsChecked = samplePatients.length;
    
    if (mismatches === 0) {
      console.log(`  ✅ ${samplePatients.length} pacientes verificados, todos consistentes`);
    } else {
      console.log(`  ❌ ${mismatches}/${samplePatients.length} pacientes com divergência`);
      console.log(`     Diferença total: R$ ${totalDiff.toFixed(2)}`);
    }
  }

  // ==========================================
  // VALIDATION 4: Freshness das views
  // ==========================================
  
  async validateViewFreshness() {
    console.log('⏱️  Validando freshness das views...');
    
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const staleViews = await PatientsView.countDocuments({
      $or: [
        { 'snapshot.isStale': true },
        { 'snapshot.calculatedAt': { $lt: fiveMinutesAgo } }
      ]
    });
    
    const veryStaleViews = await PatientsView.countDocuments({
      'snapshot.calculatedAt': { $lt: oneHourAgo }
    });
    
    const totalViews = await PatientsView.countDocuments();
    
    const stalePercent = (staleViews / totalViews) * 100;
    
    if (staleViews > 0) {
      this.warnings.push({
        type: 'STALE_VIEWS',
        message: `${staleViews}/${totalViews} views desatualizadas (${stalePercent.toFixed(1)}%)`,
        veryStale: veryStaleViews,
        severity: stalePercent > 20 ? 'HIGH' : 'MEDIUM'
      });
      
      console.log(`  ⚠️  ${staleViews} views desatualizadas (${stalePercent.toFixed(1)}%)`);
      if (veryStaleViews > 0) {
        console.log(`     ${veryStaleViews} views muito desatualizadas (> 1h)`);
      }
    } else {
      console.log(`  ✅ Todas as ${totalViews} views estão fresh`);
    }
  }

  // ==========================================
  // REPORT
  // ==========================================
  
  report() {
    console.log('\n' + '='.repeat(70));
    console.log('📊 RELATÓRIO DE CONSISTÊNCIA');
    console.log('='.repeat(70));
    
    console.log('\n📈 Estatísticas:');
    console.log(`  Pacientes verificados: ${this.stats.patientsChecked}`);
    console.log(`  Views verificadas: ${this.stats.viewsChecked}`);
    console.log(`  Appointments verificados: ${this.stats.appointmentsChecked}`);
    console.log(`  Payments verificados: ${this.stats.paymentsChecked}`);
    
    console.log('\n' + '─'.repeat(70));
    
    if (this.errors.length === 0 && this.warnings.length === 0) {
      console.log('\n✅ SISTEMA CONSISTENTE!');
      console.log('Nenhuma divergência encontrada.');
    } else {
      if (this.errors.length > 0) {
        console.log(`\n❌ ${this.errors.length} ERROS (requerem ação):`);
        this.errors.forEach((err, i) => {
          console.log(`\n  ${i + 1}. [${err.type}] ${err.severity}`);
          console.log(`     ${err.message}`);
          if (err.sample) {
            console.log(`     Exemplos: ${err.sample.join(', ')}`);
          }
        });
      }
      
      if (this.warnings.length > 0) {
        console.log(`\n⚠️  ${this.warnings.length} AVISOS:`);
        this.warnings.forEach((warn, i) => {
          console.log(`\n  ${i + 1}. [${warn.type}] ${warn.severity}`);
          console.log(`     ${warn.message}`);
        });
      }
    }
    
    console.log('\n' + '='.repeat(70));
    
    // Health score
    const totalIssues = this.errors.length + this.warnings.length;
    const healthScore = Math.max(0, 100 - (totalIssues * 5));
    
    console.log(`\n🏥 Health Score: ${healthScore}/100`);
    
    if (healthScore === 100) {
      console.log('🎉 Sistema pronto para produção!');
    } else if (healthScore >= 80) {
      console.log('⚠️  Sistema estável, mas requer atenção');
    } else if (healthScore >= 60) {
      console.log('🔴 Problemas significativos detectados');
    } else {
      console.log('💥 Sistema inconsistente - NÃO SUBIR PARA PRODUÇÃO');
    }
    
    console.log('\n');
    process.exit(this.errors.length > 0 ? 1 : 0);
  }
}

// ============================================
// RUN
// ============================================

async function main() {
  console.log('🚀 Iniciando validação de consistência...\n');
  
  // Aguarda conexão MongoDB
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const validator = new ConsistencyValidator();
  await validator.validate();
  
  process.exit(0);
}

main().catch(error => {
  console.error('💥 Erro:', error);
  process.exit(1);
});
