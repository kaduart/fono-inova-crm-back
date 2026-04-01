#!/usr/bin/env node
/**
 * Script de Validação de Consistência - Billing
 * 
 * Executa verificações periódicas para garantir:
 * - Não há invoices duplicadas
 * - Todos os payments têm invoice (se aplicável)
 * - Views estão sincronizadas com write models
 * 
 * Uso: node scripts/validate-billing-consistency.js [--fix]
 */

import mongoose from 'mongoose';
import { createContextLogger } from '../utils/logger.js';

const logger = createContextLogger('ConsistencyCheck');
const shouldFix = process.argv.includes('--fix');

async function main() {
  logger.info('consistency_check_start', 'Iniciando validação de consistência', { shouldFix });

  try {
    // Conecta ao MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/crm');
    
    const results = {
      checks: [],
      errors: [],
      fixed: []
    };

    // Check 1: Invoices duplicadas
    results.checks.push(await checkDuplicateInvoices());
    
    // Check 2: Payments sem invoice (opcional - pode ser válido)
    results.checks.push(await checkPaymentsWithoutInvoice());
    
    // Check 3: InsuranceBatch vs InsuranceBatchView
    results.checks.push(await checkBatchViewConsistency());

    // Resumo
    const totalErrors = results.checks.reduce((sum, c) => sum + c.errors, 0);
    const totalFixed = results.checks.reduce((sum, c) => sum + c.fixed, 0);

    logger.info('consistency_check_complete', 'Validação finalizada', {
      totalErrors,
      totalFixed,
      checks: results.checks.map(c => ({ name: c.name, status: c.status }))
    });

    if (totalErrors > 0) {
      process.exit(1);
    }

  } catch (error) {
    logger.error('consistency_check_error', 'Erro na validação', { error: error.message });
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// ============================================
// CHECKS
// ============================================

async function checkDuplicateInvoices() {
  const Invoice = (await import('../models/Invoice.js')).default;
  
  const duplicates = await Invoice.aggregate([
    { $match: { status: { $ne: 'cancelled' } } },
    { $group: { 
      _id: '$payment',
      count: { $sum: 1 },
      invoices: { $push: { id: '$_id', number: '$number', createdAt: '$createdAt' } }
    }},
    { $match: { count: { $gt: 1 } }}
  ]);

  const result = {
    name: 'duplicate_invoices',
    status: duplicates.length === 0 ? 'ok' : 'error',
    errors: duplicates.length,
    fixed: 0,
    details: duplicates
  };

  if (duplicates.length > 0) {
    logger.error('duplicate_invoices_found', `${duplicates.length} payments com invoices duplicadas`, {
      duplicates: duplicates.map(d => ({ payment: d._id, count: d.count }))
    });

    if (shouldFix) {
      // Mantém a mais recente, marca outras como duplicadas
      for (const dup of duplicates) {
        const sorted = dup.invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const toFix = sorted.slice(1);
        
        for (const inv of toFix) {
          await Invoice.findByIdAndUpdate(inv.id, { 
            status: 'duplicate',
            duplicateOf: sorted[0].id,
            fixedAt: new Date()
          });
          result.fixed++;
        }
      }
    }
  }

  return result;
}

async function checkPaymentsWithoutInvoice() {
  const Payment = (await import('../models/Payment.js')).default;
  const Invoice = (await import('../models/Invoice.js')).default;

  // Payments concluídos que deveriam ter invoice
  const payments = await Payment.find({
    status: 'completed',
    type: { $in: ['session', 'per_session'] },
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // últimas 24h
  }).select('_id').lean();

  const paymentIds = payments.map(p => p._id.toString());
  
  const invoices = await Invoice.find({
    payment: { $in: paymentIds }
  }).select('payment').lean();

  const invoicedPaymentIds = new Set(invoices.map(i => i.payment?.toString()));
  const missingInvoices = paymentIds.filter(id => !invoicedPaymentIds.has(id));

  const result = {
    name: 'payments_without_invoice',
    status: missingInvoices.length === 0 ? 'ok' : 'warning',
    errors: missingInvoices.length,
    fixed: 0,
    details: missingInvoices.slice(0, 10) // limita a 10
  };

  if (missingInvoices.length > 0) {
    logger.warn('payments_without_invoice', `${missingInvoices.length} payments sem invoice`, {
      sample: missingInvoices.slice(0, 5)
    });
    // Não auto-corrige - precisa investigar caso a caso
  }

  return result;
}

async function checkBatchViewConsistency() {
  const InsuranceBatch = (await import('../models/InsuranceBatch.js')).default;
  const InsuranceBatchView = (await import('../models/InsuranceBatchView.js')).default;

  const writeCount = await InsuranceBatch.countDocuments();
  const viewCount = await InsuranceBatchView.countDocuments();

  const result = {
    name: 'batch_view_consistency',
    status: writeCount === viewCount ? 'ok' : 'warning',
    errors: Math.abs(writeCount - viewCount),
    fixed: 0,
    details: { writeCount, viewCount, difference: writeCount - viewCount }
  };

  if (writeCount !== viewCount) {
    logger.warn('batch_view_inconsistency', 'Diferença entre write e view models', {
      writeCount,
      viewCount,
      difference: writeCount - viewCount
    });

    if (shouldFix) {
      // Rebuild views faltantes
      const batches = await InsuranceBatch.find().select('_id').lean();
      const views = await InsuranceBatchView.find().select('batchId').lean();
      const viewIds = new Set(views.map(v => v.batchId));
      
      const missing = batches.filter(b => !viewIds.has(b._id.toString()));
      
      const { buildInsuranceBatchView } = await import('../domains/billing/services/InsuranceBatchProjectionService.js');
      
      for (const batch of missing) {
        try {
          await buildInsuranceBatchView(batch._id.toString(), { correlationId: 'consistency_fix' });
          result.fixed++;
        } catch (error) {
          logger.error('batch_view_fix_error', `Erro ao rebuild batch ${batch._id}`, { error: error.message });
        }
      }
    }
  }

  return result;
}

// Executa
main();
