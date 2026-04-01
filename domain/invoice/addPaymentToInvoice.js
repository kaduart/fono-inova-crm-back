// domain/invoice/addPaymentToInvoice.js
import Invoice from '../../models/Invoice.js';
import Payment from '../../models/Payment.js';
import { createContextLogger } from '../../utils/logger.js';

/**
 * Adiciona pagamento à fatura
 * 
 * REGRA CRÍTICA: Payment é a fonte única de verdade
 * Invoice.paidAmount é DERIVADO (soma dos payments vinculados)
 * 
 * @param {Object} data - Dados
 * @param {ObjectId} data.invoiceId - ID da fatura
 * @param {ObjectId} data.paymentId - ID do pagamento
 * @param {mongoose.ClientSession} data.mongoSession - Sessão MongoDB
 * @param {String} data.correlationId - ID de correlação
 * @returns {Object} Resultado
 */
export async function addPaymentToInvoice(data) {
  const { 
    invoiceId, 
    paymentId, 
    mongoSession = null,
    correlationId = null 
  } = data;

  const log = createContextLogger(correlationId, 'invoice_payment');

  log.info('start', 'Adicionando pagamento à fatura', {
    invoiceId,
    paymentId
  });

  try {
    // Busca invoice
    const invoice = await Invoice.findById(invoiceId).session(mongoSession);
    
    if (!invoice) {
      throw new Error('INVOICE_NOT_FOUND');
    }

    // Valida payment
    const payment = await Payment.findById(paymentId).session(mongoSession);
    
    if (!payment) {
      throw new Error('PAYMENT_NOT_FOUND');
    }

    // 🛡️ Validação: payment pertence ao mesmo paciente?
    if (payment.patient?.toString() !== invoice.patient?.toString()) {
      throw new Error('PAYMENT_PATIENT_MISMATCH');
    }

    // 🛡️ RACE CONDITION PROTECTION: Usa $addToSet (idempotente)
    // Se já existe, não duplica. Se não existe, adiciona.
    const updateOptions = { new: true };
    if (mongoSession) {
      updateOptions.session = mongoSession;
    }
    
    const updateResult = await Invoice.findByIdAndUpdate(
      invoiceId,
      { $addToSet: { payments: paymentId } },
      updateOptions
    );

    if (!updateResult) {
      throw new Error('INVOICE_UPDATE_FAILED');
    }

    // Verifica se já estava vinculado (para log)
    const alreadyAdded = invoice.payments.includes(paymentId);

    // 🔥 RECALCULA baseado nos payments (source of truth)
    // Usa updateResult que já tem o payment adicionado
    const recalculated = await recalculateFromPayments(updateResult, mongoSession);

    log.info('success', 'Pagamento adicionado', {
      invoiceId,
      paymentId,
      alreadyAdded,
      paidAmount: recalculated.paidAmount,
      balance: recalculated.balance,
      status: recalculated.status
    });

    return {
      success: true,
      invoice: recalculated,
      alreadyAdded,
      paidAmount: recalculated.paidAmount,
      balance: recalculated.balance,
      status: recalculated.status
    };

  } catch (error) {
    log.error('error', 'Erro ao adicionar pagamento', {
      invoiceId,
      paymentId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Recalcula totais da fatura baseado nos payments vinculados
 * Payment é a fonte única de verdade!
 */
async function recalculateFromPayments(invoice, mongoSession) {
  // Busca todos os payments vinculados
  const query = Payment.find({ _id: { $in: invoice.payments } });
  
  // Só aplica sessão se existir
  if (mongoSession) {
    query.session(mongoSession);
  }
  
  const payments = await query;

  // Soma APENAS payments com status 'paid' ou 'confirmed'
  const paidAmount = payments
    .filter(p => ['paid', 'confirmed'].includes(p.status))
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  // Calcula balance
  const balance = Math.max(0, invoice.total - paidAmount);

  // Determina status
  let status = invoice.status;
  let paidAt = invoice.paidAt;

  if (balance <= 0 && paidAmount > 0) {
    status = 'paid';
    if (!paidAt) paidAt = new Date();
  } else if (paidAmount > 0) {
    status = 'partial';
  }

  // Atualiza invoice
  const updateData = {
    paidAmount,
    balance,
    status,
    paidAt,
    updatedAt: new Date()
  };

  // Só aplica sessão se existir
  const options = { new: true };
  if (mongoSession) {
    options.session = mongoSession;
  }
  
  const updatedInvoice = await Invoice.findByIdAndUpdate(
    invoice._id,
    { $set: updateData },
    options
  );

  return updatedInvoice;
}
