// back/tests/e2e/integration-validator.js
/**
 * Integration Validator
 * 
 * Valida se a integração entre domínios está corretamente configurada.
 * Verifica arquivos, exports, handlers e consistência.
 * 
 * Uso: node tests/e2e/integration-validator.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.join(__dirname, '../..');

// ============================================
// CONFIGURAÇÃO DAS INTEGRAÇÕES
// ============================================

const INTEGRATIONS = [
  {
    name: 'Clinical → Billing (SESSION_COMPLETED)',
    from: 'Clinical Domain',
    to: 'Billing Domain',
    event: 'SESSION_COMPLETED',
    critical: true,
    checks: [
      {
        type: 'file_exists',
        path: 'domains/clinical/events/clinicalEvents.js',
        description: 'Clinical events definitions'
      },
      {
        type: 'file_contains',
        path: 'domains/clinical/events/clinicalEvents.js',
        content: 'SESSION_COMPLETED',
        description: 'SESSION_COMPLETED event defined'
      },
      {
        type: 'file_exists',
        path: 'domains/billing/adapters/SessionCompletedAdapter.js',
        description: 'SessionCompletedAdapter (ACL)'
      },
      {
        type: 'file_contains',
        path: 'domains/billing/adapters/SessionCompletedAdapter.js',
        content: 'adaptSessionCompleted',
        description: 'adaptSessionCompleted function exported'
      },
      {
        type: 'file_exists',
        path: 'domains/billing/workers/billingOrchestratorWorker.js',
        description: 'Billing Orchestrator Worker'
      },
      {
        type: 'file_contains',
        path: 'domains/billing/workers/billingOrchestratorWorker.js',
        content: "case 'SESSION_COMPLETED':",
        description: 'Worker handles SESSION_COMPLETED'
      },
      {
        type: 'file_contains',
        path: 'domains/billing/workers/billingOrchestratorWorker.js',
        content: 'adaptSessionCompleted',
        description: 'Worker uses SessionCompletedAdapter'
      }
    ]
  },
  {
    name: 'WhatsApp Workers Pipeline',
    from: 'WhatsApp Webhook',
    to: 'Amanda AI + Realtime',
    event: 'WHATSAPP_MESSAGE_RECEIVED',
    critical: true,
    checks: [
      {
        type: 'file_exists',
        path: 'domains/whatsapp/workers/messageBufferWorker.js',
        description: 'MessageBufferWorker'
      },
      {
        type: 'file_exists',
        path: 'domains/whatsapp/workers/leadStateWorker.js',
        description: 'LeadStateWorker'
      },
      {
        type: 'file_exists',
        path: 'domains/whatsapp/workers/orchestratorWorker.js',
        description: 'OrchestratorWorker'
      },
      {
        type: 'file_exists',
        path: 'domains/whatsapp/workers/notificationWorker.js',
        description: 'NotificationWorker'
      },
      {
        type: 'file_exists',
        path: 'domains/whatsapp/workers/realtimeWorker.js',
        description: 'RealtimeWorker'
      },
      {
        type: 'file_contains',
        path: 'domains/whatsapp/workers/index.js',
        content: 'createMessageBufferWorker',
        description: 'Workers exported from index'
      }
    ]
  },
  {
    name: 'Clinical Orchestration',
    from: 'Appointment Service',
    to: 'Session Service',
    event: 'APPOINTMENT_SCHEDULED',
    critical: false,
    checks: [
      {
        type: 'file_exists',
        path: 'domains/clinical/workers/clinicalOrchestrator.js',
        description: 'Clinical Orchestrator Worker'
      },
      {
        type: 'file_exists',
        path: 'domains/clinical/workers/sessionWorker.js',
        description: 'Session Worker'
      },
      {
        type: 'file_contains',
        path: 'domains/clinical/workers/clinicalOrchestrator.js',
        content: "case 'APPOINTMENT_SCHEDULED':",
        description: 'Orchestrator handles APPOINTMENT_SCHEDULED'
      }
    ]
  }
];

// ============================================
// FUNÇÕES DE VALIDAÇÃO
// ============================================

function checkFileExists(filePath) {
  const fullPath = path.join(PROJECT_ROOT, filePath);
  return fs.existsSync(fullPath);
}

function checkFileContains(filePath, content) {
  const fullPath = path.join(PROJECT_ROOT, filePath);
  if (!fs.existsSync(fullPath)) return false;
  
  const fileContent = fs.readFileSync(fullPath, 'utf-8');
  return fileContent.includes(content);
}

function runCheck(check) {
  switch (check.type) {
    case 'file_exists':
      return checkFileExists(check.path);
    case 'file_contains':
      return checkFileContains(check.path, check.content);
    default:
      return false;
  }
}

// ============================================
// EXECUÇÃO
// ============================================

function validateIntegrations() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🔍 Integration Validator');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let allPassed = true;
  let criticalPassed = 0;
  let criticalTotal = 0;

  for (const integration of INTEGRATIONS) {
    console.log(`\n📦 ${integration.name}`);
    console.log(`   ${integration.from} → ${integration.to}`);
    console.log(`   Event: ${integration.event}`);
    
    if (integration.critical) {
      criticalTotal++;
      console.log('   ⚠️  CRITICAL');
    }
    
    console.log('');

    let integrationPassed = true;

    for (const check of integration.checks) {
      const passed = runCheck(check);
      const status = passed ? '✅' : '❌';
      
      console.log(`   ${status} ${check.description}`);
      
      if (!passed) {
        integrationPassed = false;
        console.log(`       → ${check.path}`);
        if (check.content) {
          console.log(`       → Missing: "${check.content.substring(0, 50)}..."`);
        }
      }
    }

    if (integrationPassed && integration.critical) {
      criticalPassed++;
    }

    if (!integrationPassed) {
      allPassed = false;
    }

    console.log(`\n   ${integrationPassed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log('   ' + '─'.repeat(50));
  }

  // Resumo
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 Summary');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`\nTotal Integrations: ${INTEGRATIONS.length}`);
  console.log(`Critical Integrations: ${criticalTotal}`);
  console.log(`Critical Passed: ${criticalPassed}/${criticalTotal}`);
  
  if (allPassed) {
    console.log('\n✅ ALL INTEGRATIONS VALIDATED');
    console.log('\nArquitetura Event-Driven está CORRETAMENTE CONFIGURADA');
  } else {
    console.log('\n❌ SOME INTEGRATIONS FAILED');
    console.log('\nVerifique os arquivos marcados com ❌');
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');

  return allPassed;
}

// ============================================
// VALIDAÇÕES ADICIONAIS
// ============================================

function validateEventSchemas() {
  console.log('\n🔍 Validating Event Schemas...\n');

  // Verificar consistência de SESSION_COMPLETED entre domínios
  const clinicalEventsPath = path.join(PROJECT_ROOT, 'domains/clinical/events/clinicalEvents.js');
  const adapterPath = path.join(PROJECT_ROOT, 'domains/billing/adapters/SessionCompletedAdapter.js');

  if (!fs.existsSync(clinicalEventsPath) || !fs.existsSync(adapterPath)) {
    console.log('❌ Cannot validate schemas - files not found');
    return false;
  }

  const clinicalContent = fs.readFileSync(clinicalEventsPath, 'utf-8');
  const adapterContent = fs.readFileSync(adapterPath, 'utf-8');

  // Extrair campos esperados do adapter
  const adapterFields = [];
  const fieldMatches = adapterContent.match(/payload\.(\w+)/g);
  if (fieldMatches) {
    fieldMatches.forEach(match => {
      const field = match.replace('payload.', '');
      if (!adapterFields.includes(field)) {
        adapterFields.push(field);
      }
    });
  }

  console.log('   Fields used by Adapter:');
  adapterFields.forEach(field => {
    const inClinical = clinicalContent.includes(field);
    const status = inClinical ? '✅' : '❌';
    console.log(`     ${status} ${field}`);
  });

  // Verificar campos críticos
  const criticalFields = ['sessionId', 'patientId', 'insuranceProvider', 'paymentType'];
  const missingFields = criticalFields.filter(field => 
    !adapterContent.includes(`payload.${field}`)
  );

  if (missingFields.length > 0) {
    console.log(`\n   ⚠️  Adapter may need fields: ${missingFields.join(', ')}`);
  }

  return true;
}

// ============================================
// MAIN
// ============================================

const integrationsOk = validateIntegrations();
validateEventSchemas();

process.exit(integrationsOk ? 0 : 1);
