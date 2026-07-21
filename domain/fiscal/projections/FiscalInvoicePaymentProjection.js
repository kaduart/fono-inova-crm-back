// domain/fiscal/projections/FiscalInvoicePaymentProjection.js
// Read-model puro (Fase 2 v3, Seção 2.1): resolve quais Payments participam de uma FiscalInvoice
// a partir de `origin`, sem persistir nenhuma referência duplicada. Único ponto do Fiscal Domain
// que consulta Payment diretamente — nunca escreve nele.
//
// Campos reais de Payment confirmados em models/Payment.js antes de escrever esta projeção
// (nunca inferidos): `appointment`, `package`, `status`.

import Payment from '../../../models/Payment.js';
import Invoice from '../../../models/Invoice.js';
import { FiscalOriginType } from '../../../constants/fiscalEnums.js';

/**
 * @param {{type: string, id: string|ObjectId}} origin
 * @returns {Promise<Array>} Payments com status 'paid' relacionados à origem
 */
export async function resolvePaymentsForOrigin(origin) {
  switch (origin.type) {
    case FiscalOriginType.APPOINTMENT:
      return Payment.find({ appointment: origin.id, status: 'paid' });

    case FiscalOriginType.PACKAGE:
      return Payment.find({ package: origin.id, status: 'paid' });

    case FiscalOriginType.INVOICE: {
      const invoice = await Invoice.findById(origin.id).populate('payments');
      if (!invoice) return [];
      return (invoice.payments || []).filter((p) => p.status === 'paid');
    }

    case FiscalOriginType.MANUAL:
      // Sem Payment associado — emissão manual não deriva de nenhum registro financeiro existente
      return [];

    case FiscalOriginType.BATCH:
      // `origin.id` referencia um agrupamento leve de seleção (não implementado neste PR —
      // decisão de shape do "registro de lote" fica para quando o fluxo de emissão em lote for
      // desenhado; não inventar aqui).
      throw new Error('FISCAL_ORIGIN_BATCH_PROJECTION_NOT_IMPLEMENTED');

    default:
      throw new Error(`FISCAL_ORIGIN_TYPE_DESCONHECIDO: ${origin.type}`);
  }
}

/**
 * Valida que existe ao menos 1 Payment `paid` para a origem informada — usado pelo
 * EmissionEligibilityValidator, não deve ser chamado fora do domínio fiscal.
 */
export async function hasSettledPayments(origin) {
  const payments = await resolvePaymentsForOrigin(origin);
  return payments.length > 0;
}
