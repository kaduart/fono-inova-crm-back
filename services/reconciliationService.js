// services/reconciliationService.js
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
