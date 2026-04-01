#!/usr/bin/env node
/**
 * Audit Event Coverage
 * 
 * Detecta operações de write que NÃO emitem eventos.
 * Isso é CRÍTICO para garantir que o PatientsView não fique inconsistente.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// CONFIG
// ============================================

const DOMAIN_DIRECTORIES = [
  '../domains/clinical/services',
  '../domains/billing/services',
  '../controllers',
  '../routes'
];

const CRITICAL_OPERATIONS = [
  // Patient
  { pattern: /Patient\.(create|save|findByIdAndUpdate|findOneAndUpdate|deleteOne)/, domain: 'PATIENT', event: 'PATIENT_*' },
  { pattern: /new Patient\(/, domain: 'PATIENT', event: 'PATIENT_CREATED' },
  
  // Appointment
  { pattern: /Appointment\.(create|save|findByIdAndUpdate)/, domain: 'APPOINTMENT', event: 'APPOINTMENT_*' },
  { pattern: /new Appointment\(/, domain: 'APPOINTMENT', event: 'APPOINTMENT_CREATED' },
  
  // Session
  { pattern: /Session\.(create|save|findByIdAndUpdate)/, domain: 'SESSION', event: 'SESSION_*' },
  
  // Payment
  { pattern: /Payment\.(create|save|findByIdAndUpdate)/, domain: 'PAYMENT', event: 'PAYMENT_*' },
  { pattern: /createPayment/, domain: 'PAYMENT', event: 'PAYMENT_CREATED' },
  
  // Package
  { pattern: /Package\.(create|save|findByIdAndUpdate)/, domain: 'PACKAGE', event: 'PACKAGE_*' },
];

const EVENT_PATTERNS = [
  /publishEvent\s*\(/,
  /eventPublisher\.publish/,
  /EventTypes\./,
  /PATIENT_CREATED/,
  /PATIENT_UPDATED/,
  /APPOINTMENT_/,
  /SESSION_/,
  /PAYMENT_/,
  /PACKAGE_/
];

// ============================================
// AUDIT
// ============================================

class EventCoverageAuditor {
  constructor() {
    this.issues = [];
    this.filesChecked = 0;
    this.operationsFound = 0;
    this.eventsFound = 0;
  }

  async audit() {
    console.log('🔍 Auditando cobertura de eventos...\n');
    
    for (const dir of DOMAIN_DIRECTORIES) {
      const fullPath = path.resolve(__dirname, dir);
      if (fs.existsSync(fullPath)) {
        await this.scanDirectory(fullPath);
      }
    }
    
    this.report();
  }

  async scanDirectory(dir) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        await this.scanDirectory(fullPath);
      } else if (file.endsWith('.js') && !file.includes('.test.')) {
        await this.auditFile(fullPath);
      }
    }
  }

  async auditFile(filePath) {
    this.filesChecked++;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    // Verifica operações críticas
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;
      
      for (const op of CRITICAL_OPERATIONS) {
        if (op.pattern.test(line)) {
          this.operationsFound++;
          
          // Verifica se há evento próximo (nas próximas 10 linhas)
          const hasEvent = this.checkEventInContext(lines, i);
          
          if (!hasEvent) {
            this.issues.push({
              file: path.relative(process.cwd(), filePath),
              line: lineNumber,
              code: line.trim().substring(0, 80),
              domain: op.domain,
              expectedEvent: op.event,
              severity: 'HIGH'
            });
          } else {
            this.eventsFound++;
          }
        }
      }
    }
  }

  checkEventInContext(lines, startIndex) {
    // Verifica próximas 15 linhas
    const context = lines.slice(startIndex, startIndex + 15).join('\n');
    
    return EVENT_PATTERNS.some(pattern => pattern.test(context));
  }

  report() {
    console.log('='.repeat(70));
    console.log('📊 RELATÓRIO DE COBERTURA DE EVENTOS');
    console.log('='.repeat(70));
    console.log(`\nArquivos analisados: ${this.filesChecked}`);
    console.log(`Operações críticas encontradas: ${this.operationsFound}`);
    console.log(`Operações com eventos: ${this.eventsFound}`);
    console.log(`Cobertura: ${((this.eventsFound / this.operationsFound) * 100).toFixed(1)}%`);
    
    if (this.issues.length === 0) {
      console.log('\n✅ Nenhum problema encontrado!');
      console.log('Todas as operações críticas emitem eventos.');
    } else {
      console.log(`\n❌ ${this.issues.length} PROBLEMAS ENCONTRADOS:\n`);
      
      // Agrupa por domínio
      const byDomain = this.groupBy(this.issues, 'domain');
      
      for (const [domain, issues] of Object.entries(byDomain)) {
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`🔴 DOMÍNIO: ${domain} (${issues.length} issues)`);
        console.log(`${'─'.repeat(70)}`);
        
        issues.forEach(issue => {
          console.log(`\n  📁 ${issue.file}:${issue.line}`);
          console.log(`     Código: ${issue.code}`);
          console.log(`     Esperado: ${issue.expectedEvent}`);
          console.log(`     Severidade: ${issue.severity}`);
        });
      }
      
      console.log('\n' + '='.repeat(70));
      console.log('⚠️  AÇÃO NECESSÁRIA');
      console.log('='.repeat(70));
      console.log('\nEssas operações podem quebrar o PatientsView!');
      console.log('Adicione publicação de evento após cada operação.');
      console.log('\nExemplo:');
      console.log('  await patient.save();');
      console.log('  await publishEvent(EventTypes.PATIENT_CREATED, { patientId });');
    }
    
    console.log('\n');
    process.exit(this.issues.length > 0 ? 1 : 0);
  }

  groupBy(array, key) {
    return array.reduce((result, item) => {
      (result[item[key]] = result[item[key]] || []).push(item);
      return result;
    }, {});
  }
}

// ============================================
// RUN
// ============================================

const auditor = new EventCoverageAuditor();
auditor.audit().catch(error => {
  console.error('💥 Erro no audit:', error);
  process.exit(1);
});
