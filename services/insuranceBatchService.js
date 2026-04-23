// services/insuranceBatchService.js
// Serviço de Faturamento de Convênio V2

import mongoose from 'mongoose';
import Session from '../models/Session.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import Payment from '../models/Payment.js';
import { v4 as uuidv4 } from 'uuid';
import { recordInsuranceBilled, recordInsuranceReceived } from './financialLedgerService.js';

// 🔄 Importação dinâmica do cache para evitar circular dependency
let dashboardCache;
async function getDashboardCache() {
  if (!dashboardCache) {
    const { dashboardCache: cache } = await import('../routes/financial/dashboard.routes.js');
    dashboardCache = cache;
  }
  return dashboardCache;
}

/**
 * Cria um novo lote de faturamento de convênio
 */
export async function createBatch({ insuranceProvider, startDate, endDate, userId, sessionIds }) {
  console.log(`[InsuranceBatch] Criando lote para ${insuranceProvider}`, { startDate, endDate, sessionIds: sessionIds?.length });
  
  // 1. Buscar sessões elegíveis (apenas NÃO vinculadas a lote)
  const query = {
    paymentMethod: 'convenio',
    status: 'completed',
    $or: [
      { billingBatchId: { $exists: false } },
      { billingBatchId: null }
    ]
  };
  
  // Se sessionIds fornecido, usar explicitamente (faturamento seletivo)
  // Senão, buscar pelo período e exigir insuranceBillingProcessed
  if (sessionIds && sessionIds.length > 0) {
    query._id = { $in: sessionIds };
  } else {
    query.insuranceBillingProcessed = true;
    query.date = { $gte: startDate, $lte: endDate };
  }
  
  const sessions = await Session.find(query).populate('patient appointmentId insuranceGuide paymentId');
  
  console.log(`[InsuranceBatch] Encontradas ${sessions.length} sessões elegíveis (billingBatchId: null)`);
  
  if (sessions.length === 0) {
    throw new Error('Nenhuma sessão elegível para faturamento no período (todas já em lotes ou não completadas)');
  }
  
  // 2. Criar o lote
  const batchNumber = `LOT-${insuranceProvider.toUpperCase()}-${Date.now()}`;
  
  const batch = await InsuranceBatch.create({
    batchNumber,
    insuranceProvider,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    sessions: sessions.map(s => ({
      session: s._id,
      appointment: s.appointmentId,
      guide: s.insuranceGuide,
      payment: s.paymentId,  // ✅ Vínculo seguro para retorno
      protocolItemId: null,  // ✅ Será preenchido ao gerar XML TISS
      grossAmount: s.sessionValue || 0,
      netAmount: s.sessionValue || 0,
      status: 'pending'
    })),
    totalGross: sessions.reduce((sum, s) => sum + (s.sessionValue || 0), 0),
    totalNet: sessions.reduce((sum, s) => sum + (s.sessionValue || 0), 0),
    totalSessions: sessions.length,
    status: 'ready',
    createdBy: userId,
    correlationId: uuidv4()
  });
  
  // 3. Marcar sessões como vinculadas ao lote
  await Session.updateMany(
    { _id: { $in: sessions.map(s => s._id) } },
    { $set: { billingBatchId: batch._id } }
  );
  
  console.log(`[InsuranceBatch] Lote criado: ${batch._id} (${sessions.length} sessões)`);
  
  return batch;
}

/**
 * Envia lote para o convênio
 */
export async function sendBatch(batchId, userId) {
  console.log(`[InsuranceBatch] Enviando lote ${batchId}`);
  
  const batch = await InsuranceBatch.findById(batchId);
  
  if (!batch) {
    throw new Error('Lote não encontrado');
  }
  
  // IDEMPOTÊNCIA: Só envia se estiver 'ready'
  if (batch.status !== 'ready') {
    console.log(`[InsuranceBatch] Lote ${batchId} já processado (status: ${batch.status}) - ignorando`);
    return {
      idempotent: true,
      batch,
      message: `Lote já foi enviado anteriormente (status: ${batch.status})`
    };
  }
  
  // Atualizar status do lote
  batch.status = 'sent';
  batch.sentDate = new Date();
  batch.sentBy = userId;
  
  // Atualizar status das sessões no lote
  for (const sessionItem of batch.sessions) {
    sessionItem.status = 'sent';
    sessionItem.sentAt = new Date();
  }
  
  await batch.save();
  
  // Atualizar insurance.status dos payments vinculados
  const sessionIds = batch.sessions.map(s => s.session.toString());
  
  await Payment.updateMany(
    {
      session: { $in: sessionIds },
      billingType: 'convenio'
    },
    {
      $set: {
        status: 'billed',
        'insurance.status': 'billed',
        'insurance.billedAt': new Date(),
        updatedAt: new Date()
      }
    }
  );

  // 🏦 LEDGER: registrar insurance_billed para cada payment
  const billedPayments = await Payment.find({
    session: { $in: sessionIds },
    billingType: 'convenio'
  }).lean();

  for (const payment of billedPayments) {
    try {
      await recordInsuranceBilled(payment, { billedAt: new Date() });
    } catch (ledgerErr) {
      if (ledgerErr.code !== 'LEDGER_IMMUTABLE') {
        console.warn(`[InsuranceBatch] Ledger billed warning:`, ledgerErr.message);
      }
    }
  }
  
  console.log(`[InsuranceBatch] Lote ${batchId} enviado + ${sessionIds.length} payments atualizados para 'billed'`);
  
  return batch;
}

/**
 * Processar retorno do convênio
 */
export async function processReturn(batchId, returnData) {
  console.log(`[InsuranceBatch] Processando retorno do lote ${batchId}`);
  
  const batch = await InsuranceBatch.findById(batchId);
  
  if (!batch) {
    throw new Error('Lote não encontrado');
  }
  
  // IDEMPOTÊNCIA: Se lote já foi recebido totalmente, não processa de novo
  if (batch.status === 'received' && !returnData.force) {
    console.log(`[InsuranceBatch] Lote ${batchId} já recebido totalmente - ignorando (use force=true para reprocessar)`);
    return {
      idempotent: true,
      batch,
      message: 'Lote já foi processado anteriormente'
    };
  }
  
  // Atualizar cada sessão com o retorno (busca por paymentId ou sessionId)
  let totalReceived = 0;
  let totalGlosa = 0;
  
  for (const item of returnData.items || []) {
    // Busca por paymentId (preferencial) ou sessionId (fallback)
    const sessionItem = batch.sessions.find(s => {
      if (item.paymentId && s.payment) {
        return s.payment.toString() === item.paymentId;
      }
      return s.session.toString() === item.sessionId;
    });
    
    if (sessionItem) {
      sessionItem.status = item.status; // 'paid', 'partial', 'glosa', 'rejected'
      sessionItem.returnAmount = item.returnAmount || 0;
      sessionItem.glosaAmount = item.glosaAmount || 0;
      sessionItem.glosaReason = item.glosaReason || null;
      sessionItem.protocolNumber = returnData.protocolNumber;
      sessionItem.processedAt = new Date();
      
      totalReceived += item.returnAmount || 0;
      totalGlosa += item.glosaAmount || 0;
    } else {
      console.warn(`[InsuranceBatch] Item não encontrado no lote:`, { 
        paymentId: item.paymentId, 
        sessionId: item.sessionId 
      });
    }
  }
  
  // Atualizar totais do lote
  batch.receivedAmount = totalReceived;
  batch.totalGlosa = totalGlosa;
  
  // Determinar status do lote
  const allPaid = batch.sessions.every(s => s.status === 'paid');
  const allProcessed = batch.sessions.every(s => ['paid', 'partial', 'rejected'].includes(s.status));
  
  if (allPaid) {
    batch.status = 'received';
  } else if (allProcessed) {
    batch.status = 'partial';
  } else {
    batch.status = 'processing';
  }
  
  batch.processedAt = new Date();
  await batch.save();
  
  // Atualizar insurance.status dos payments baseado no retorno
  for (const item of returnData.items || []) {
    const insuranceStatus = {
      'paid': 'received',
      'partial': 'partial',
      'glosa': 'glosa',
      'rejected': 'glosa'
    }[item.status] || 'pending_billing';
    
    // Preferencialmente atualiza por paymentId, senão por sessionId
    const query = item.paymentId 
      ? { _id: item.paymentId }
      : { session: item.sessionId };
    
    // IDEMPOTÊNCIA: Verifica se payment já foi recebido (exceto se force=true)
    if (!returnData.force) {
      const existingPayment = await Payment.findOne(query);
      if (existingPayment?.insurance?.status === 'received') {
        console.log(`[InsuranceBatch] Payment ${item.paymentId || item.sessionId} já recebido - ignorando`);
        continue;
      }
    }
    
    const paymentUpdate = {
      'insurance.status': insuranceStatus,
      'insurance.receivedAmount': item.returnAmount || 0,
      'insurance.glosaAmount': item.glosaAmount || 0,
      'insurance.receivedAt': new Date().toISOString().split('T')[0]
    };
    
    // Se convênio pagou, atualizar status principal também
    if (item.status === 'paid') {
      paymentUpdate.status = 'paid';
      paymentUpdate.paidAt = new Date();
      paymentUpdate.financialDate = new Date();
    }
    
    await Payment.updateOne(
      query,
      {
        $set: paymentUpdate
      }
    );
  }

  // 🏦 LEDGER: registrar insurance_received para payments com status 'received'
  const receivedItems = (returnData.items || []).filter(i => i.status === 'paid' || i.status === 'partial');
  for (const item of receivedItems) {
    const query = item.paymentId ? { _id: item.paymentId } : { session: item.sessionId };
    const paymentDoc = await Payment.findOne(query).lean();
    if (paymentDoc) {
      try {
        await recordInsuranceReceived(paymentDoc, { receivedAt: new Date() });
      } catch (ledgerErr) {
        if (ledgerErr.code !== 'LEDGER_IMMUTABLE') {
          console.warn(`[InsuranceBatch] Ledger received warning:`, ledgerErr.message);
        }
      }
    }
  }
  
  console.log(`[InsuranceBatch] Retorno processado: ${totalReceived} recebido, ${totalGlosa} glosa, ${returnData.items?.length || 0} payments atualizados`);
  
  // Log de auditoria
  console.log('[InsuranceBatch] Auditoria do lote:', {
    batchId: batch._id,
    batchNumber: batch.batchNumber,
    status: batch.status,
    totalSessions: batch.totalSessions,
    totalGross: batch.totalGross,
    receivedAmount: batch.receivedAmount,
    totalGlosa: batch.totalGlosa
  });
  
  // 🔄 INVALIDAR CACHE DO DASHBOARD (para atualizar pipeline em tempo real)
  try {
    const cache = await getDashboardCache();
    const monthKey = `${batch.startDate.getFullYear()}-${String(batch.startDate.getMonth() + 1).padStart(2, '0')}`;
    const keysToDelete = cache.keys().filter(key => 
      key.includes('dashboard_month_') && key.includes(monthKey)
    );
    keysToDelete.forEach(key => cache.del(key));
    console.log(`[Pipeline] Dashboard cache invalidado: ${keysToDelete.length} keys para ${monthKey}`);
    
    // 🔄 INVALIDAR CACHE DE DESPESAS TAMBÉM (V2)
    const { expenseCache } = await import('../routes/expenses.v2.js');
    if (expenseCache) {
      expenseCache.flushAll();
      console.log('[Pipeline] Expense cache invalidado');
    }
    
    // 🔔 NOTIFICAR CLIENTES VIA SSE (tempo real)
    const { notifyDashboardUpdate } = await import('../routes/financial/sse.routes.js');
    notifyDashboardUpdate('default', 'INSURANCE_PIPELINE_CHANGED', {
      batchId: batch._id.toString(),
      batchNumber: batch.batchNumber,
      provider: batch.insuranceProvider,
      month: monthKey,
      receivedAmount: batch.receivedAmount,
      totalGlosa: batch.totalGlosa,
      status: batch.status
    });
  } catch (err) {
    console.warn('[Pipeline] Erro ao notificar:', err.message);
  }
  
  return batch;
}

/**
 * Listar lotes por convênio
 */
export async function listBatches({ insuranceProvider, status, page = 1, limit = 20 }) {
  const filter = {};
  
  if (insuranceProvider) {
    filter.insuranceProvider = insuranceProvider;
  }
  
  if (status) {
    filter.status = status;
  }
  
  const batches = await InsuranceBatch.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sessions.session', 'date patient specialty')
    .lean();
  
  const total = await InsuranceBatch.countDocuments(filter);
  
  return {
    batches,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

export default {
  createBatch,
  sendBatch,
  processReturn,
  listBatches
};
