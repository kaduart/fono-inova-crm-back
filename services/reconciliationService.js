// services/reconciliationService.js
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';

/**
 * Serviço de Reconciliação
 * 
 * Detecta e corrige inconsistências no sistema.
 * Deve ser executado periodicamente (ex: diariamente às 3h)
 * 
 * Tipos de inconsistência detectados:
 * 1. Appointment.completed mas Session.pending
 * 2. Session.paid mas sem Payment correspondente
 * 3. Payment.status != Session.paymentStatus
 * 4. Package.sessionsDone inconsistente
 * 5. PatientBalance divergente
 */

export async function runReconciliation() {
    console.log('[Reconciliation] Iniciando reconciliação...');
    
    const report = {
        startedAt: new Date(),
        inconsistencies: [],
        corrections: [],
        errors: []
    };
    
    try {
        // 1. Inconsistência: Appointment.completed mas Session.pending
        const mismatchedSessions = await findMismatchedSessions();
        report.inconsistencies.push(...mismatchedSessions);
        
        // 2. Orphan Payments: Payment pendente há mais de 1h
        const orphanedPayments = await findOrphanedPayments();
        report.inconsistencies.push(...orphanedPayments);
        
        // 3. Status divergence
        const statusDivergence = await findStatusDivergence();
        report.inconsistencies.push(...statusDivergence);
        
        // 4. Ledger divergence (Payment vs PatientBalance)
        const ledgerDivergence = await findLedgerDivergence();
        report.inconsistencies.push(...ledgerDivergence);
        
        console.log(`[Reconciliation] ${report.inconsistencies.length} inconsistências encontradas`);
        
        // Correções automáticas (opcional, cuidado)
        for (const issue of report.inconsistencies) {
            if (issue.autoFixable) {
                try {
                    await fixIssue(issue);
                    report.corrections.push(issue);
                } catch (error) {
                    report.errors.push({ issue, error: error.message });
                }
            }
        }
        
        report.finishedAt = new Date();
        report.duration = report.finishedAt - report.startedAt;
        
        console.log(`[Reconciliation] Concluída em ${report.duration}ms`, {
            found: report.inconsistencies.length,
            corrected: report.corrections.length,
            errors: report.errors.length
        });
        
        return report;
        
    } catch (error) {
        console.error('[Reconciliation] Erro fatal:', error.message);
        throw error;
    }
}

async function findMismatchedSessions() {
    const issues = [];
    
    const appointments = await Appointment.find({
        clinicalStatus: 'completed',
        session: { $exists: true }
    }).select('session sessionId').lean();
    
    const sessionIds = appointments.map(a => a.session).filter(Boolean);
    
    const sessions = await Session.find({
        _id: { $in: sessionIds },
        status: { $ne: 'completed' }
    }).lean();
    
    for (const session of sessions) {
        issues.push({
            type: 'SESSION_STATUS_MISMATCH',
            severity: 'high',
            sessionId: session._id,
            expectedStatus: 'completed',
            actualStatus: session.status,
            autoFixable: true,
            suggestedFix: 'Update session.status to completed'
        });
    }
    
    return issues;
}

async function findOrphanedPayments() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const orphaned = await Payment.find({
        status: 'pending',
        createdAt: { $lt: oneHourAgo },
        correlationId: { $exists: true }
    }).select('_id status createdAt correlationId').lean();
    
    return orphaned.map(p => ({
        type: 'ORPHANED_PAYMENT',
        severity: 'medium',
        paymentId: p._id,
        createdAt: p.createdAt,
        correlationId: p.correlationId,
        autoFixable: false, // Requer análise manual
        suggestedFix: 'Verificar se transação correspondente foi completada'
    }));
}

async function findStatusDivergence() {
    const issues = [];
    
    // Session marcada como paid mas sem paymentId
    const sessionsWithoutPayment = await Session.find({
        isPaid: true,
        $or: [
            { paymentId: { $exists: false } },
            { paymentId: null }
        ]
    }).select('_id isPaid paymentId').lean();
    
    for (const session of sessionsWithoutPayment) {
        issues.push({
            type: 'MISSING_PAYMENT_REFERENCE',
            severity: 'high',
            sessionId: session._id,
            autoFixable: false,
            suggestedFix: 'Buscar Payment correspondente e vincular'
        });
    }
    
    return issues;
}

// ==============================================================================
// CHECK 4: LEDGER DIVERGENCE (Payment vs PatientBalance)
// ==============================================================================

async function findLedgerDivergence() {
    const issues = [];
    
    // Busca todos os PatientBalance com saldo > 0
    const ledgers = await PatientBalance.find({
        currentBalance: { $gt: 0 }
    }).select('patient currentBalance').lean();
    
    for (const ledger of ledgers) {
        const patientId = ledger.patient;
        
        // Soma payments pendentes deste paciente
        const paymentsAgg = await Payment.aggregate([
            { $match: { patient: patientId, status: 'pending' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        
        const paymentsTotal = paymentsAgg[0]?.total || 0;
        const ledgerTotal = ledger.currentBalance || 0;
        const diff = Math.abs(paymentsTotal - ledgerTotal);
        
        // Se divergir mais de R$ 0.01, reporta
        if (diff > 0.01) {
            issues.push({
                type: 'LEDGER_DIVERGENCE',
                severity: diff > 100 ? 'critical' : diff > 10 ? 'high' : 'medium',
                patientId: patientId.toString(),
                paymentsTotal,
                ledgerTotal,
                diff,
                autoFixable: false,
                suggestedFix: 'Verificar payments pendentes vs lançamentos no ledger. Fonte da verdade: Payment.'
            });
        }
    }
    
    // Também detecta payments órfãos sem session/appointment
    const orphanPayments = await Payment.find({
        status: 'pending',
        session: null,
        appointment: null
    }).select('_id patient amount paymentDate').lean();
    
    for (const p of orphanPayments) {
        issues.push({
            type: 'ORPHAN_PAYMENT',
            severity: 'medium',
            paymentId: p._id.toString(),
            patientId: p.patient?.toString(),
            amount: p.amount,
            paymentDate: p.paymentDate,
            autoFixable: true,
            suggestedFix: 'Linkar payment à session/appointment correspondente'
        });
    }
    
    return issues;
}

// ==============================================================================
// API PÚBLICA: Reconciliação por paciente ou global
// ==============================================================================

export async function reconcilePatientLedger(patientId) {
    const paymentsAgg = await Payment.aggregate([
        { $match: { patient: new mongoose.Types.ObjectId(patientId), status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    
    const ledger = await PatientBalance.findOne({ patient: patientId }).select('currentBalance').lean();
    
    const paymentsTotal = paymentsAgg[0]?.total || 0;
    const ledgerTotal = ledger?.currentBalance || 0;
    const diff = Math.abs(paymentsTotal - ledgerTotal);
    
    return {
        patientId,
        paymentsTotal,
        ledgerTotal,
        diff,
        isConsistent: diff <= 0.01,
        paymentsCount: paymentsAgg[0]?.count || 0
    };
}

export async function reconcileAllLedgers() {
    const ledgers = await PatientBalance.find({ currentBalance: { $gt: 0 } }).select('patient').lean();
    
    const results = [];
    for (const ledger of ledgers) {
        const result = await reconcilePatientLedger(ledger.patient.toString());
        if (!result.isConsistent) {
            results.push(result);
        }
    }
    
    return {
        totalChecked: ledgers.length,
        inconsistent: results.length,
        details: results
    };
}

async function fixIssue(issue) {
    console.log(`[Reconciliation] Corrigindo: ${issue.type}`, issue);
    
    switch (issue.type) {
        case 'SESSION_STATUS_MISMATCH':
            await Session.findByIdAndUpdate(issue.sessionId, {
                status: 'completed'
            });
            break;
            
        default:
            console.log(`[Reconciliation] Correção automática não implementada para ${issue.type}`);
    }
}

// Se executado via CLI
if (import.meta.url === `file://${process.argv[1]}`) {
    runReconciliation()
        .then(report => {
            console.log('[Reconciliation] Relatório:', JSON.stringify(report, null, 2));
            process.exit(0);
        })
        .catch(error => {
            console.error('[Reconciliation] Falha:', error);
            process.exit(1);
        });
}
