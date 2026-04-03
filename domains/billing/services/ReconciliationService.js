/**
 * ============================================================================
 * RECONCILIATION SERVICE - V2
 * ============================================================================
 * 
 * Verifica inconsistências financeiras e corrige automaticamente.
 * Deve rodar via cron job (ex: diariamente 3am).
 * 
 * Tipos de inconsistência detectadas:
 * 1. Session sem Payment (orfã)
 * 2. Payment sem Session (fantasma)
 * 3. Guia consumida sem registro no consumptionHistory
 * 4. Status divergentes (Payment='paid' mas Session='pending')
 * 5. Valores divergentes
 * ============================================================================
 */

import mongoose from 'mongoose';
import Payment from '../../../models/Payment.js';
import Session from '../../../models/Session.js';
import Appointment from '../../../models/Appointment.js';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';

export class ReconciliationService {
  
  /**
   * Executa reconciliação completa
   * @returns {Promise<Object>} Relatório de inconsistências encontradas
   */
  async reconcile(dateRange = null) {
    const startTime = Date.now();
    const report = {
      timestamp: new Date().toISOString(),
      dateRange,
      checks: {},
      totalInconsistencies: 0,
      autoFixed: 0,
      manualReview: []
    };
    
    console.log('[Reconciliation] Starting...');
    
    // Check 1: Sessions sem Payment
    report.checks.sessionsWithoutPayment = await this.findSessionsWithoutPayment(dateRange);
    
    // Check 2: Payments sem Session
    report.checks.paymentsWithoutSession = await this.findPaymentsWithoutSession(dateRange);
    
    // Check 3: Status divergentes
    report.checks.divergentStatus = await this.findDivergentStatus(dateRange);
    
    // Check 4: Guia consumida sem consumptionHistory
    report.checks.guideInconsistencies = await this.findGuideInconsistencies(dateRange);
    
    // Check 5: Valores divergentes
    report.checks.valueMismatch = await this.findValueMismatch(dateRange);
    
    // Calcula totais
    report.totalInconsistencies = Object.values(report.checks)
      .reduce((sum, check) => sum + (check.count || 0), 0);
    
    // Tenta auto-correção
    for (const check of Object.values(report.checks)) {
      if (check.fixable) {
        const fixed = await this.autoFix(check.issues);
        report.autoFixed += fixed;
      }
    }
    
    // Os não corrigíveis vão para review manual
    report.manualReview = this.collectManualReview(report.checks);
    
    report.durationMs = Date.now() - startTime;
    
    // Publica evento de reconciliação
    await publishEvent('FINANCIAL_RECONCILIATION_COMPLETED', {
      timestamp: report.timestamp,
      totalInconsistencies: report.totalInconsistencies,
      autoFixed: report.autoFixed,
      manualReviewCount: report.manualReview.length
    });
    
    console.log(`[Reconciliation] Completed in ${report.durationMs}ms`, {
      total: report.totalInconsistencies,
      fixed: report.autoFixed
    });
    
    return report;
  }
  
  /**
   * Check 1: Sessions de convênio sem Payment
   */
  async findSessionsWithoutPayment(dateRange) {
    const query = {
      paymentMethod: 'convenio',
      status: { $in: ['completed', 'confirmed'] },
      insuranceBillingProcessed: true
    };
    
    if (dateRange) {
      query.date = { $gte: dateRange.start, $lte: dateRange.end };
    }
    
    const sessions = await Session.find(query).select('_id date patient status');
    
    const issues = [];
    for (const session of sessions) {
      const payment = await Payment.findOne({ session: session._id });
      if (!payment) {
        issues.push({
          type: 'SESSION_WITHOUT_PAYMENT',
          sessionId: session._id,
          sessionDate: session.date,
          patientId: session.patient,
          severity: 'HIGH',
          fixable: false, // Não pode auto-criar Payment sem saber valores
          message: 'Session processed but no Payment found'
        });
      }
    }
    
    return {
      name: 'Sessions without Payment',
      count: issues.length,
      issues,
      fixable: false
    };
  }
  
  /**
   * Check 2: Payments sem Session
   */
  async findPaymentsWithoutSession(dateRange) {
    const query = {
      billingType: 'convenio',
      'source.type': 'session' // V2 only
    };
    
    if (dateRange) {
      query.createdAt = { $gte: dateRange.start, $lte: dateRange.end };
    }
    
    const payments = await Payment.find(query).select('_id session status amount');
    
    const issues = [];
    for (const payment of payments) {
      if (!payment.session) continue; // Skip se não tem session vinculada
      
      const session = await Session.findById(payment.session);
      if (!session) {
        issues.push({
          type: 'PAYMENT_WITHOUT_SESSION',
          paymentId: payment._id,
          sessionId: payment.session,
          amount: payment.amount,
          severity: 'CRITICAL',
          fixable: false,
          message: 'Payment exists but Session was deleted'
        });
      }
    }
    
    return {
      name: 'Payments without Session',
      count: issues.length,
      issues,
      fixable: false
    };
  }
  
  /**
   * Check 3: Status divergentes entre Payment e Session/Appointment
   */
  async findDivergentStatus(dateRange) {
    const query = {
      billingType: 'convenio',
      status: { $in: ['billed', 'paid'] }
    };
    
    if (dateRange) {
      query.updatedAt = { $gte: dateRange.start, $lte: dateRange.end };
    }
    
    const payments = await Payment.find(query)
      .select('_id session status insurance.status appointment');
    
    const issues = [];
    for (const payment of payments) {
      // Verifica Session
      const session = await Session.findById(payment.session)
        .select('paymentStatus isPaid');
      
      if (session) {
        // Se Payment='paid', Session deve ter isPaid=true
        if (payment.status === 'paid' && !session.isPaid) {
          issues.push({
            type: 'STATUS_DIVERGENCE_SESSION',
            paymentId: payment._id,
            sessionId: session._id,
            paymentStatus: payment.status,
            sessionStatus: session.paymentStatus,
            severity: 'MEDIUM',
            fixable: true,
            autoFix: async () => {
              await Session.updateOne(
                { _id: session._id },
                { $set: { isPaid: true, paymentStatus: 'paid' } }
              );
            },
            message: 'Payment is paid but Session is not marked as paid'
          });
        }
      }
      
      // Verifica Appointment
      if (payment.appointment) {
        const appointment = await Appointment.findById(payment.appointment)
          .select('paymentStatus');
        
        if (appointment && payment.status !== appointment.paymentStatus) {
          issues.push({
            type: 'STATUS_DIVERGENCE_APPOINTMENT',
            paymentId: payment._id,
            appointmentId: appointment._id,
            paymentStatus: payment.status,
            appointmentStatus: appointment.paymentStatus,
            severity: 'LOW',
            fixable: true,
            autoFix: async () => {
              await Appointment.updateOne(
                { _id: appointment._id },
                { $set: { paymentStatus: payment.status } }
              );
            },
            message: 'Payment status differs from Appointment status'
          });
        }
      }
    }
    
    return {
      name: 'Divergent Status',
      count: issues.length,
      issues,
      fixable: true
    };
  }
  
  /**
   * Check 4: Inconsistências na guia
   */
  async findGuideInconsistencies(dateRange) {
    const Guide = mongoose.model('InsuranceGuide');
    
    const query = {};
    if (dateRange) {
      query.updatedAt = { $gte: dateRange.start, $lte: dateRange.end };
    }
    
    const guides = await Guide.find({
      ...query,
      $expr: { $ne: ['$usedSessions', { $size: { $ifNull: ['$consumptionHistory', []] } }] }
    }).select('_id number usedSessions consumptionHistory');
    
    const issues = guides.map(guide => ({
      type: 'GUIDE_INCONSISTENCY',
      guideId: guide._id,
      guideNumber: guide.number,
      usedSessions: guide.usedSessions,
      historyCount: (guide.consumptionHistory || []).length,
      severity: 'HIGH',
      fixable: false, // Requer análise manual
      message: 'usedSessions does not match consumptionHistory length'
    }));
    
    return {
      name: 'Guide Inconsistencies',
      count: issues.length,
      issues,
      fixable: false
    };
  }
  
  /**
   * Check 5: Valores divergentes
   */
  async findValueMismatch(dateRange) {
    const query = {
      billingType: 'convenio',
      status: 'paid',
      $or: [
        { amount: 0 },
        { 'insurance.grossAmount': 0 },
        { 'insurance.receivedAmount': 0 }
      ]
    };
    
    if (dateRange) {
      query.updatedAt = { $gte: dateRange.start, $lte: dateRange.end };
    }
    
    const payments = await Payment.find(query)
      .select('_id amount insurance.grossAmount insurance.receivedAmount status');
    
    const issues = payments.map(payment => ({
      type: 'VALUE_MISMATCH',
      paymentId: payment._id,
      amount: payment.amount,
      grossAmount: payment.insurance?.grossAmount,
      receivedAmount: payment.insurance?.receivedAmount,
      severity: 'MEDIUM',
      fixable: false, // Requer verificação manual do valor correto
      message: 'Paid payment has zero or inconsistent values'
    }));
    
    return {
      name: 'Value Mismatch',
      count: issues.length,
      issues,
      fixable: false
    };
  }
  
  /**
   * Tenta auto-corrigir issues
   */
  async autoFix(issues) {
    let fixed = 0;
    
    for (const issue of issues) {
      if (issue.fixable && issue.autoFix) {
        try {
          await issue.autoFix();
          issue.fixed = true;
          fixed++;
          console.log(`[Reconciliation] Auto-fixed: ${issue.type} ${issue.paymentId || issue.sessionId}`);
        } catch (error) {
          issue.fixError = error.message;
          console.error(`[Reconciliation] Auto-fix failed: ${issue.type}`, error);
        }
      }
    }
    
    return fixed;
  }
  
  /**
   * Coleta issues que precisam de review manual
   */
  collectManualReview(checks) {
    const manual = [];
    
    for (const check of Object.values(checks)) {
      for (const issue of (check.issues || [])) {
        if (!issue.fixed && (issue.severity === 'HIGH' || issue.severity === 'CRITICAL')) {
          manual.push({
            type: issue.type,
            severity: issue.severity,
            ids: {
              paymentId: issue.paymentId,
              sessionId: issue.sessionId,
              guideId: issue.guideId
            },
            message: issue.message
          });
        }
      }
    }
    
    return manual;
  }
}

export const reconciliationService = new ReconciliationService();
export default reconciliationService;
