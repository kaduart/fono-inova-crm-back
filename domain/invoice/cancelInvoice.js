// domain/invoice/cancelInvoice.js
import Invoice from '../../models/Invoice.js';
import { createContextLogger } from '../../utils/logger.js';
import { publishEvent, EventTypes } from '../../infrastructure/events/eventPublisher.js';

/**
 * Cancela uma fatura
 * 
 * REGRAS:
 * - Não pode cancelar se já estiver paga (precisa estornar primeiro)
 * - Não pode cancelar 2x (idempotente)
 * - Não cancela payments, só desvincula
 * 
 * @param {Object} data - Dados
 * @param {ObjectId} data.invoiceId - ID da fatura
 * @param {String} data.reason - Motivo do cancelamento
 * @param {ObjectId} data.userId - ID do usuário
 * @param {mongoose.ClientSession} data.mongoSession - Sessão MongoDB
 * @param {String} data.correlationId - ID de correlação
 * @returns {Object} Resultado
 */
export async function cancelInvoice(data) {
  const { 
    invoiceId, 
    reason = '', 
    userId = null,
    mongoSession = null,
    correlationId = null 
  } = data;

  const log = createContextLogger(correlationId, 'invoice_cancel');

  log.info('start', 'Cancelando fatura', {
    invoiceId,
    reason
  });

  try {
    const session = mongoSession;

    // Busca invoice
    const invoice = await Invoice.findById(invoiceId).session(session);
    
    if (!invoice) {
      throw new Error('INVOICE_NOT_FOUND');
    }

    // 🛡️ Idempotência: já cancelada?
    if (invoice.status === 'canceled') {
      log.info('already_canceled', 'Fatura já cancelada', { invoiceId });
      return {
        success: true,
        invoice,
        alreadyCanceled: true
      };
    }

    // 🛡️ Validação: já foi paga?
    if (invoice.status === 'paid' && invoice.paidAmount > 0) {
      log.warn('cannot_cancel_paid', 'Tentativa de cancelar fatura paga', {
        invoiceId,
        paidAmount: invoice.paidAmount
      });
      throw new Error('CANNOT_CANCEL_PAID_INVOICE');
    }

    // 🛡️ Validação: tem pagamentos parciais?
    if (invoice.status === 'partial' && invoice.payments.length > 0) {
      log.warn('cannot_cancel_partial', 'Tentativa de cancelar fatura com pagamentos', {
        invoiceId,
        paidAmount: invoice.paidAmount,
        paymentsCount: invoice.payments.length
      });
      throw new Error('CANNOT_CANCEL_WITH_PAYMENTS');
    }

    // Atualiza status
    const updateData = {
      status: 'canceled',
      cancelReason: reason,
      canceledAt: new Date(),
      updatedBy: userId,
      updatedAt: new Date()
    };

    const updatedInvoice = await Invoice.findByIdAndUpdate(
      invoice._id,
      { $set: updateData },
      { session, new: true }
    );

    // Publica evento
    await publishEvent(
      EventTypes.INVOICE_CANCELED,
      {
        invoiceId: invoice._id.toString(),
        invoiceNumber: invoice.invoiceNumber,
        patientId: invoice.patient.toString(),
        reason,
        canceledBy: userId
      },
      { correlationId }
    );

    log.info('success', 'Fatura cancelada', {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber
    });

    return {
      success: true,
      invoice: updatedInvoice
    };

  } catch (error) {
    log.error('error', 'Erro ao cancelar fatura', {
      invoiceId,
      error: error.message
    });
    throw error;
  }
}
