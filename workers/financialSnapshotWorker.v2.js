/**
 * 💰 Financial Snapshot Service — V2.5 (Transicional + Idempotente)
 *
 * ⚠️ NOTA: Este arquivo está em back/workers/ por histórico, mas NÃO é um worker
 * BullMQ ativo no registry. Ele é chamado como função utilitária por outros
 * workers, rotas e hooks de eventos.
 *
 * Princípios:
 *   1. Evento transicional: reage a MUDANÇAS de status, não a semântica
 *   2. Idempotência: processedEvents + contributions (evita duplicação)
 *   3. Rebuild determinístico: usa unifiedFinancialService como fonte da verdade
 *   4. Compensação: suporta reversão (paid → pending não duplica)
 */

import FinancialDailySnapshot from '../models/FinancialDailySnapshot.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';
import { EventTypes } from '../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger(null, 'FinancialSnapshotWorkerV2');

// 🎯 Shadow validation (compara snapshot vs realtime após cada evento)
const SHADOW_VALIDATE = process.env.FINANCIAL_SNAPSHOT_SHADOW_VALIDATE !== 'false'; // default: true

const toDateStr = (d) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().split('T')[0];
};

const methodMap = {
  dinheiro: 'dinheiro',
  pix: 'pix',
  credit_card: 'cartao',
  debit_card: 'cartao',
  cartao: 'cartao',
  'cartão': 'cartao',
  'cartão de crédito': 'cartao',
  'cartão de débito': 'cartao',
  transferencia: 'outros',
  'transferência': 'outros',
  cash: 'dinheiro',
  bank_transfer: 'outros',
  insurance: 'outros',
  convenio: 'outros',
  liminar_credit: 'outros',
  package_prepaid: 'outros',
};

function normalizeMethod(method) {
  return methodMap[(method || '').toLowerCase()] || 'outros';
}

/**
 * Atualiza o snapshot com operação atômica e idempotente.
 * Grava contribution para permitir rebuild e reversão.
 */
async function applySnapshotOperation({ dateStr, clinicId = 'default', eventId, eventType }, operation) {
  if (!dateStr || !eventId) {
    log.warn('snapshot_invalid_params', 'dateStr ou eventId ausente', { dateStr, eventId });
    return;
  }

  // 1. Verifica idempotência
  const exists = await FinancialDailySnapshot.findOne(
    { date: dateStr, clinicId, processedEvents: eventId },
    { _id: 1 }
  ).lean();

  if (exists) {
    log.info('snapshot_already_processed', 'Evento já aplicado', { dateStr, eventId });
    return;
  }

  // 2. Monta o update com contribution
  const update = {
    $set: { updatedAt: new Date(), lastEventAt: new Date() },
    $addToSet: { processedEvents: eventId },
    $push: { contributions: operation.contribution }
  };

  if (operation.$inc && Object.keys(operation.$inc).length) {
    update.$inc = operation.$inc;
  }

  try {
    await FinancialDailySnapshot.findOneAndUpdate(
      { date: dateStr, clinicId },
      update,
      { upsert: true, new: true }
    );
    log.info('snapshot_updated', 'Snapshot atualizado', { dateStr, eventId, eventType, ...operation.meta });
  } catch (err) {
    log.error('snapshot_update_failed', err.message, { dateStr, clinicId, eventId, operation });
    throw err;
  }
}

/**
 * 🎯 HANDLER PRINCIPAL: PAYMENT_STATUS_CHANGED
 *
 * Lógica:
 *   from !== 'paid' && to === 'paid'  →  entra no caixa (+)
 *   from === 'paid' && to !== 'paid'  →  sai do caixa (-)
 *   Qualquer outra transição          →  atualiza contadores apenas
 */
export async function onPaymentStatusChanged(payload) {
  const {
    paymentId,
    from,
    to,
    amount = 0,
    paymentMethod,
    financialDate,
    kind,
    billingType,
    isFromPackage,
    eventId,
    reason
  } = payload;

  if (!paymentId) {
    log.error('payment_status_changed_no_id', 'Payload sem paymentId', { payload });
    return;
  }

  // Determina a data do snapshot
  const dateStr = toDateStr(financialDate) || toDateStr(new Date());
  const value = Number(amount) || 0;

  // Se não houve mudança efetiva de caixa, apenas loga
  const enteredCash = (from !== 'paid' && to === 'paid');
  const leftCash = (from === 'paid' && to !== 'paid');

  if (!enteredCash && !leftCash) {
    log.info('payment_status_no_cash_impact', 'Transição não afeta caixa', { paymentId, from, to, reason });
    return;
  }

  const sign = enteredCash ? 1 : -1;
  const method = normalizeMethod(paymentMethod);

  // Mapeia billingType para campo do snapshot
  let cashField = 'cash.particular';
  if (billingType === 'convenio' || kind === 'insurance') {
    cashField = 'cash.convenioAvulso';
  } else if (billingType === 'liminar') {
    cashField = 'cash.liminar';
  } else if (kind === 'package_receipt' || isFromPackage) {
    cashField = 'cash.convenioPacote';
  }

  const $inc = {
    'cash.total': value * sign,
    [cashField]: value * sign,
    [`cash.byMethod.${method}`]: value * sign,
  };

  // Se entrou no caixa, incrementa countPaid; se saiu, decrementa
  if (enteredCash) {
    $inc['payments.countPaid'] = 1;
    $inc['payments.received'] = value;
  } else {
    $inc['payments.countPaid'] = -1;
    $inc['payments.received'] = -value;
  }

  await applySnapshotOperation(
    { dateStr, eventId: eventId || `psc_${paymentId}_${Date.now()}`, eventType: EventTypes.PAYMENT_STATUS_CHANGED },
    {
      $inc,
      contribution: {
        eventId: eventId || `psc_${paymentId}_${Date.now()}`,
        eventType: EventTypes.PAYMENT_STATUS_CHANGED,
        paymentId,
        category: 'cash',
        amount: value,
        operation: enteredCash ? 'add' : 'remove',
        billingType,
        paymentMethod: method,
        timestamp: new Date()
      },
      meta: { paymentId, from, to, amount: value, billingType, method }
    }
  );
}

/**
 * 🏭 HANDLER: SESSION_COMPLETED
 *
 * Incrementa produção do dia. NÃO toca em caixa (caixa é papel do payment).
 */
export async function onSessionCompleted(payload) {
  const { sessionId, appointmentId, eventId } = payload;

  if (!sessionId) {
    log.warn('session_completed_no_id', 'Payload sem sessionId', { payload });
    return;
  }

  // Busca session para obter valor e data
  const session = await Session.findById(sessionId).lean();
  if (!session) {
    log.warn('session_not_found', 'Session não encontrada', { sessionId });
    return;
  }

  const dateStr = toDateStr(session.date);
  const value = Number(session.sessionValue) || 0;

  // Determina billingType da session
  let billingType = 'particular';
  if (session.method === 'convenio' || session.origin === 'convenio') billingType = 'convenio';
  else if (session.method === 'liminar' || session.origin === 'liminar') billingType = 'liminar';
  else if (session.package || session.origin === 'package_prepaid') billingType = 'pacote';

  const productionField = `production.byBusinessType.${billingType}.total`;
  const productionCount = `production.byBusinessType.${billingType}.count`;

  await applySnapshotOperation(
    { dateStr, eventId: eventId || `sc_${sessionId}_${Date.now()}`, eventType: EventTypes.SESSION_COMPLETED },
    {
      $inc: {
        'production.total': value,
        'production.count': 1,
        [productionField]: value,
        [productionCount]: 1,
      },
      contribution: {
        eventId: eventId || `sc_${sessionId}_${Date.now()}`,
        eventType: EventTypes.SESSION_COMPLETED,
        sessionId,
        category: 'production',
        amount: value,
        operation: 'add',
        billingType,
        timestamp: new Date()
      },
      meta: { sessionId, appointmentId, value, billingType }
    }
  );
}

/**
 * 🔄 DISPATCHER PRINCIPAL
 */
export async function processFinancialEvent(eventType, payload) {
  log.info('process_event', 'Processando evento financeiro', { eventType, eventId: payload?.eventId });

  try {
    let dateStr = null;
    
    switch (eventType) {
      case EventTypes.PAYMENT_STATUS_CHANGED:
        await onPaymentStatusChanged(payload);
        dateStr = toDateStr(payload.financialDate) || toDateStr(new Date());
        break;
      case EventTypes.SESSION_COMPLETED:
        await onSessionCompleted(payload);
        // Session date vem do payload ou do banco
        dateStr = toDateStr(payload.date) || toDateStr(new Date());
        break;
      // Eventos legados (manter para compatibilidade, mas logam warning)
      case EventTypes.PAYMENT_COMPLETED:
        log.warn('legacy_event', 'PAYMENT_COMPLETED é legado — use PAYMENT_STATUS_CHANGED', { payload });
        await onPaymentStatusChanged({ ...payload, from: 'pending', to: 'paid' });
        dateStr = toDateStr(payload.financialDate) || toDateStr(new Date());
        break;
      case EventTypes.PAYMENT_PROCESS_REQUESTED:
        log.warn('legacy_event', 'PAYMENT_PROCESS_REQUESTED é legado', { payload });
        break;
      default:
        log.debug('event_ignored', 'Evento não mapeado para snapshot', { eventType });
    }

    // 🎯 SHADOW VALIDATION: compara snapshot vs realtime após processar
    if (SHADOW_VALIDATE && dateStr) {
      try {
        const validation = await validateSnapshotVsRealtime(dateStr);
        if (validation.hasDivergence) {
          log.warn('shadow_divergence', 'Snapshot diverge do realtime', { dateStr, ...validation.diffs });
        }
      } catch (valErr) {
        log.error('shadow_validation_failed', valErr.message, { dateStr });
      }
    }

  } catch (err) {
    log.error('process_event_failed', err.message, { eventType, payload, stack: err.stack });
    throw err;
  }
}

/**
 * 🔧 REBUILD DETERMINÍSTICO
 *
 * Reconstrói o snapshot de um dia usando unifiedFinancialService como fonte da verdade.
 * Útil para:
 *   - Correção de dados históricos
 *   - Migração inicial
 *   - Teste de consistência
 *
 * ATENÇÃO: Apaga contributions e processedEvents do dia (rebuild from scratch).
 */
export async function rebuildSnapshotForDate(dateStr, clinicId = 'default') {
  log.info('rebuild_start', 'Reconstruindo snapshot', { dateStr, clinicId });

  const start = new Date(`${dateStr}T00:00:00.000-03:00`);
  const end = new Date(`${dateStr}T23:59:59.999-03:00`);

  const [cash, production] = await Promise.all([
    unifiedFinancialService.calculateCash(start, end),
    unifiedFinancialService.calculateProduction(start, end),
  ]);

  // Monta o documento completo a partir do realtime
  const snapshotDoc = {
    clinicId,
    date: dateStr,
    cash: {
      total: cash.total,
      particular: cash.particular,
      convenioAvulso: cash.convenio,
      convenioPacote: cash.pacote,
      liminar: cash.liminar,
      byMethod: {
        pix: cash.byMethod?.pix || 0,
        dinheiro: cash.byMethod?.dinheiro || 0,
        cartao: cash.byMethod?.cartao || 0,
        outros: cash.byMethod?.outros || 0,
      }
    },
    production: {
      total: production.total,
      count: production.count,
      byBusinessType: {
        particular: { total: production.particular || 0, count: 0 },
        convenio:   { total: production.convenio || 0, count: 0 },
        pacote:     { total: production.pacote || 0, count: 0 },
        liminar:    { total: production.liminar || 0, count: 0 },
      }
    },
    // Limpa contributions e processedEvents (rebuild from scratch)
    contributions: [],
    processedEvents: [],
    version: 2,
    lastEventAt: new Date(),
    updatedAt: new Date(),
  };

  await FinancialDailySnapshot.findOneAndUpdate(
    { date: dateStr, clinicId },
    { $set: snapshotDoc },
    { upsert: true, new: true }
  );

  log.info('rebuild_complete', 'Snapshot reconstruído', {
    dateStr,
    cash: cash.total,
    production: production.total,
    paymentsCount: cash.count,
    sessionsCount: production.count
  });

  return {
    date: dateStr,
    realtime: { cash: cash.total, production: production.total },
    snapshot: snapshotDoc
  };
}

/**
 * 🔧 REBUILD DE RANGE
 */
export async function rebuildSnapshotRange(startDateStr, endDateStr, clinicId = 'default') {
  const results = [];
  let current = new Date(`${startDateStr}T00:00:00`);
  const end = new Date(`${endDateStr}T00:00:00`);

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    try {
      const result = await rebuildSnapshotForDate(dateStr, clinicId);
      results.push({ date: dateStr, status: 'ok', ...result.realtime });
    } catch (err) {
      results.push({ date: dateStr, status: 'error', error: err.message });
    }
    current.setDate(current.getDate() + 1);
  }

  return results;
}

/**
 * 🔍 SHADOW VALIDATION
 *
 * Compara snapshot do dia com realtime (unifiedFinancialService).
 * Retorna divergências para auditoria e alerta.
 */
export async function validateSnapshotVsRealtime(dateStr, clinicId = 'default') {
  const start = new Date(`${dateStr}T00:00:00.000-03:00`);
  const end = new Date(`${dateStr}T23:59:59.999-03:00`);

  const [realtime, snapshot] = await Promise.all([
    unifiedFinancialService.calculateCash(start, end)
      .then(c => ({ cash: c.total, particular: c.particular, pacote: c.pacote, convenio: c.convenio, liminar: c.liminar })),
    unifiedFinancialService.calculateProduction(start, end)
      .then(p => ({ production: p.total, count: p.count, particular: p.particular, pacote: p.pacote, convenio: p.convenio, liminar: p.liminar })),
    FinancialDailySnapshot.findOne({ date: dateStr, clinicId }).lean()
  ]);

  const snapCash = snapshot?.cash?.total || 0;
  const snapProd = snapshot?.production?.total || 0;

  const diffs = {};
  const threshold = 0.01; // tolerância de 1 centavo

  if (Math.abs(realtime.cash - snapCash) > threshold) {
    diffs.cash = { realtime: realtime.cash, snapshot: snapCash, diff: realtime.cash - snapCash };
  }
  if (Math.abs(realtime.production - snapProd) > threshold) {
    diffs.production = { realtime: realtime.production, snapshot: snapProd, diff: realtime.production - snapProd };
  }

  const hasDivergence = Object.keys(diffs).length > 0;

  return {
    date: dateStr,
    hasDivergence,
    diffs: hasDivergence ? diffs : null,
    realtime: { cash: realtime.cash, production: realtime.production },
    snapshot: { cash: snapCash, production: snapProd },
    contributions: snapshot?.contributions?.length || 0,
    processedEvents: snapshot?.processedEvents?.length || 0,
  };
}

/**
 * 🔍 VALIDAÇÃO DE RANGE
 *
 * Valida snapshot vs realtime para um range de datas.
 */
export async function validateSnapshotRange(startDateStr, endDateStr, clinicId = 'default') {
  const results = [];
  let current = new Date(`${startDateStr}T00:00:00`);
  const end = new Date(`${endDateStr}T00:00:00`);
  let divergenceCount = 0;

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    try {
      const result = await validateSnapshotVsRealtime(dateStr, clinicId);
      if (result.hasDivergence) divergenceCount++;
      results.push(result);
    } catch (err) {
      results.push({ date: dateStr, hasDivergence: true, error: err.message });
      divergenceCount++;
    }
    current.setDate(current.getDate() + 1);
  }

  return {
    start: startDateStr,
    end: endDateStr,
    totalDays: results.length,
    divergenceCount,
    divergences: results.filter(r => r.hasDivergence),
    results,
  };
}

export default {
  processFinancialEvent,
  onPaymentStatusChanged,
  onSessionCompleted,
  rebuildSnapshotForDate,
  rebuildSnapshotRange,
  validateSnapshotVsRealtime,
  validateSnapshotRange,
};
