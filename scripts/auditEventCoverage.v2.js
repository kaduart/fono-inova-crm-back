#!/usr/bin/env node
/**
 * Audit Event Coverage V2
 * Detecta saveToOutbox e appendEvent também
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOMAIN_DIRECTORIES = [
  '../domains/clinical/services',
  '../domains/billing/services', 
  '../controllers',
  '../routes'
];

const CRITICAL_OPERATIONS = [
  { pattern: /Appointment\.(create|save|findByIdAndUpdate)/, domain: 'APPOINTMENT' },
  { pattern: /Patient\.(create|save|findByIdAndUpdate)/, domain: 'PATIENT' },
  { pattern: /Payment\.(create|save|findByIdAndUpdate)/, domain: 'PAYMENT' },
];

const EVENT_PATTERNS = [
  /publishEvent/,
  /saveToOutbox/,
  /appendEvent/,
  /EventTypes\./
];

const EXCLUDED_FILES = [
  'eventPublisher.js',
  'outboxPattern.js',
  'eventStoreService.js'
];

class Auditor {
  constructor() {
    this.issues = [];
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
        if (EXCLUDED_FILES.some(e => file.includes(e))) continue;
        await this.auditFile(fullPath);
      }
    }
  }

  async auditFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const hasEvent = EVENT_PATTERNS.some(p => p.test(content));
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      for (const op of CRITICAL_OPERATIONS) {
        if (op.pattern.test(line)) {
          this.operationsFound++;
          
          const hasEventNearby = this.checkEventInContext(lines, i);
          
          if (!hasEvent && !hasEventNearby) {
            this.issues.push({
              file: path.relative(process.cwd(), filePath),
              line: i + 1,
              domain: op.domain,
              code: line.trim().substring(0, 60)
            });
          } else {
            this.eventsFound++;
          }
        }
      }
    }
  }

  checkEventInContext(lines, startIndex) {
    const context = lines.slice(startIndex, startIndex + 15).join('\n');
    return EVENT_PATTERNS.some(pattern => pattern.test(context));
  }

  report() {
    console.log('='.repeat(70));
    console.log('📊 RELATÓRIO DE COBERTURA DE EVENTOS');
    console.log('='.repeat(70));
    console.log(`\nOperações: ${this.operationsFound}`);
    console.log(`Com eventos: ${this.eventsFound}`);
    console.log(`Cobertura: ${((this.eventsFound / this.operationsFound) * 100).toFixed(1)}%`);
    
    if (this.issues.length === 0) {
      console.log('\n✅ Todas as operações têm eventos!');
    } else {
      console.log(`\n⚠️  ${this.issues.length} operações SEM eventos:\n`);
      
      this.issues.slice(0, 20).forEach(issue => {
        console.log(`  ${issue.domain}: ${issue.file}:${issue.line}`);
        console.log(`    ${issue.code}`);
      });
    }
    
    console.log('\n');
    process.exit(this.issues.length > 0 ? 1 : 0);
  }
}

const auditor = new Auditor();
auditor.audit();
