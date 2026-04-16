#!/usr/bin/env node
/**
 * 🔍 Auditoria de Consistência Ledger vs Domínio
 *
 * Detecta divergências entre:
 * - Appointments completed/canceled sem correspondente no FinancialLedger
 * - Sessions completed sem lançamento de receita no ledger
 * - Cancelamentos sem reversão no ledger
 *
 * Uso:
 *   node scripts/audit-ledger-consistency.js           # apenas diagnostica
 *   node scripts/audit-ledger-consistency.js --fix     # aplica ajustes manuais no ledger
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import FinancialLedger from '../models/FinancialLedger.js';
import { recordSessionCancellationReversal } from '../services/financialLedgerService.js';
import { createContextLogger } from '../utils/logger.js';

dotenv.config();

const logger = createContextLogger('LedgerAudit');
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/crm';

async function main() {
  const shouldFix = process.argv.includes('--fix');
  
  logger.info('Conectando ao MongoDB...');
  await mongoose.connect(MONGO_URI);
  
  console.log('\n========================================');
  console.log('🔍 AUDITORIA LEDGER VS DOMÍNIO');
  console.log('========================================\n');
  
  // ============================================================
  // 1. Sessões completed SEM revenue_recognition no ledger
  // ============================================================
  console.log('1️⃣  Buscando sessões completed SEM revenue_recognition...');
  const completedSessions = await Session.find({
    status: 'completed'
  }).select('_id patient appointmentId sessionValue sessionType').lean();
  
  const sessionIds = completedSessions.map(s => s._id.toString());
  const ledgerCredits = await FinancialLedger.find({
    session: { $in: sessionIds },
    type: { $in: ['revenue_recognition', 'package_consumed', 'payment_received'] }
  }).select('session type amount').lean();
  
  const ledgerSessionIds = new Set(ledgerCredits.map(l => l.session?.toString()));
  const sessionsWithoutLedger = completedSessions.filter(s => !ledgerSessionIds.has(s._id.toString()));
  
  console.log(`   Total completed sessions: ${completedSessions.length}`);
  console.log(`   Com lançamento no ledger: ${ledgerCredits.length}`);
  console.log(`   ❌ SEM lançamento no ledger: ${sessionsWithoutLedger.length}`);
  
  if (sessionsWithoutLedger.length > 0) {
    console.log('\n   Detalhes das sessões sem ledger:');
    for (const s of sessionsWithoutLedger.slice(0, 10)) {
      console.log(`     - sessionId: ${s._id.toString()}, patient: ${s.patient?.toString()}, value: ${s.sessionValue}`);
    }
    if (sessionsWithoutLedger.length > 10) {
      console.log(`     ... e mais ${sessionsWithoutLedger.length - 10} sessões`);
    }
  }
  
  // ============================================================
  // 2. Appointments canceled que TINHAM sido completed
  //    (verifica se há reversão no ledger)
  // ============================================================
  console.log('\n2️⃣  Buscando appointments canceled que tinham sido completed...');
  const canceledAppointments = await Appointment.find({
    operationalStatus: 'canceled'
  }).select('_id patient session sessionValue billingType history').lean();
  
  // Filtra appointments que já foram completed antes (histórico)
  const wasCompleted = (apt) => apt.history?.some(h => 
    h.newStatus === 'completed' || h.action === 'completed'
  );
  
  const canceledAfterCompleted = canceledAppointments.filter(wasCompleted);
  const canceledIds = canceledAfterCompleted.map(a => a._id.toString());
  
  const ledgerReversals = await FinancialLedger.find({
    appointment: { $in: canceledIds },
    type: { $in: ['reversal', 'adjustment', 'refund'] }
  }).select('appointment type amount').lean();
  
  const ledgerCanceledIds = new Set(ledgerReversals.map(l => l.appointment?.toString()));
  const canceledWithoutReversal = canceledAfterCompleted.filter(a => !ledgerCanceledIds.has(a._id.toString()));
  
  console.log(`   Total canceled after completed: ${canceledAfterCompleted.length}`);
  console.log(`   Com reversão no ledger: ${ledgerReversals.length}`);
  console.log(`   ❌ SEM reversão no ledger: ${canceledWithoutReversal.length}`);
  
  if (canceledWithoutReversal.length > 0) {
    console.log('\n   Detalhes dos cancelamentos sem reversão:');
    for (const a of canceledWithoutReversal.slice(0, 10)) {
      console.log(`     - appointmentId: ${a._id.toString()}, patient: ${a.patient?.toString()}, value: ${a.sessionValue}`);
    }
    if (canceledWithoutReversal.length > 10) {
      console.log(`     ... e mais ${canceledWithoutReversal.length - 10} appointments`);
    }
  }
  
  // ============================================================
  // 3. FIX: Aplica reversões faltantes
  // ============================================================
  if (shouldFix && canceledWithoutReversal.length > 0) {
    console.log('\n🔧 Aplicando reversões no ledger...');
    
    for (const apt of canceledWithoutReversal) {
      try {
        const session = await Session.findById(apt.session).lean();
        if (!session) {
          console.log(`   ⚠️ Session não encontrada para appointment ${apt._id.toString()}, pulando...`);
          continue;
        }
        
        await recordSessionCancellationReversal(session, {
          correlationId: `audit_cancel_${apt._id.toString()}`,
          reason: 'Reversão aplicada pela auditoria de consistência'
        });
        
        console.log(`   ✅ Reversão aplicada: appointment ${apt._id.toString()}, session ${session._id.toString()}, amount ${session.sessionValue || 0}`);
      } catch (fixErr) {
        console.error(`   ❌ Falha ao aplicar reversão para ${apt._id.toString()}: ${fixErr.message}`);
      }
    }
    
    console.log('\n✅ Processo de correção concluído.');
  } else if (canceledWithoutReversal.length > 0) {
    console.log('\n💡 Para corrigir automaticamente, execute:');
    console.log('   node scripts/audit-ledger-consistency.js --fix');
  }
  
  // ============================================================
  // RESUMO
  // ============================================================
  console.log('\n========================================');
  console.log('📊 RESUMO DA AUDITORIA');
  console.log('========================================');
  console.log(`Sessões completed sem ledger:      ${sessionsWithoutLedger.length}`);
  console.log(`Cancelamentos sem reversão:        ${canceledWithoutReversal.length}`);
  console.log(`Status geral:                      ${sessionsWithoutLedger.length === 0 && canceledWithoutReversal.length === 0 ? '✅ CONSISTENTE' : '⚠️ DIVERGÊNCIAS ENCONTRADAS'}`);
  console.log('========================================\n');
  
  await mongoose.disconnect();
  console.log('👋 Done.');
}

main().catch(err => {
  logger.error('Erro fatal:', err.message);
  console.error(err);
  process.exit(1);
});
