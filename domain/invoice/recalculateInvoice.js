// domain/invoice/recalculateInvoice.js
import Invoice from '../../models/Invoice.js';
import Payment from '../../models/Payment.js';
import { createContextLogger } from '../../utils/logger.js';

/**
 * Recalcula totais da fatura baseado nos itens e payments
 * 
 * REGRAS:
 * - subtotal = soma dos itens
 * - total = subtotal - discount + tax
 * - paidAmount = soma dos payments (source of truth)
 * - balance = total - paidAmount
 * - status derivado do balance
 * 
 * @param {Object} data - Dados
 * @param {ObjectId} data.invoiceId - ID da fatura
 * @param {mongoose.ClientSession} data.mongoSession - Sessão MongoDB
 * @param {String} data.correlationId - ID de correlação
 * @returns {Object} Resultado
 */
export async function recalculateInvoice(data) {
  const { 
    invoiceId, 
    mongoSession = null,
    correlationId = null 
  } = data;

  const log = createContextLogger(correlationId, 'invoice_recalc');

  log.info('start', 'Recalculando fatura', { invoiceId });

  try {
    const session = mongoSession;

    // Busca invoice
    const invoice = await Invoice.findById(invoiceId).session(session);
    
    if (!invoice) {
      throw new Error('INVOICE_NOT_FOUND');
    }

    // 🧮 Calcula subtotal dos itens
    const subtotal = invoice.items.reduce((sum, item) => {
      return sum + ((item.quantity || 1) * (item.unitValue || 0));
    }, 0);

    // 🧮 Calcula total
    const total = Math.max(0, subtotal - (invoice.discount || 0) + (invoice.tax || 0));

    // 🔥 Busca payments para calcular paidAmount (SOURCE OF TRUTH)
    let paidAmount = 0;
    if (invoice.payments && invoice.payments.length > 0) {
      const payments = await Payment.find({
        _id: { $in: invoice.payments },
        status: { $in: ['paid', 'confirmed'] }
      }).session(session);

      paidAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    }

    // 🧮 Calcula balance
    const balance = Math.max(0, total - paidAmount);

    // 🧮 Determina status
    let status = invoice.status;
    let paidAt = invoice.paidAt;

    if (balance <= 0 && paidAmount > 0) {
      status = 'paid';
      if (!paidAt) paidAt = new Date();
    } else if (paidAmount > 0) {
      status = 'partial';
    } else if (invoice.isOverdue && status !== 'canceled' && status !== 'draft') {
      status = 'overdue';
    }

    // Atualiza invoice
    const updateData = {
      subtotal,
      total,
      paidAmount,
      balance,
      status,
      paidAt,
      updatedAt: new Date()
    };

    const updatedInvoice = await Invoice.findByIdAndUpdate(
      invoice._id,
      { $set: updateData },
      { session, new: true }
    );

    log.info('success', 'Fatura recalculada', {
      invoiceId,
      subtotal,
      total,
      paidAmount,
      balance,
      status
    });

    return {
      success: true,
      invoice: updatedInvoice,
      totals: {
        subtotal,
        total,
        paidAmount,
        balance
      }
    };

  } catch (error) {
    log.error('error', 'Erro ao recalcular fatura', {
      invoiceId,
      error: error.message
    });
    throw error;
  }
}
