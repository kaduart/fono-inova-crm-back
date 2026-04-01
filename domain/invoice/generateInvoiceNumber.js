// domain/invoice/generateInvoiceNumber.js
import Invoice from '../../models/Invoice.js';

/**
 * Gera número sequencial de fatura
 * 
 * Formato: {PREFIX}-{YYYY}{MM}-{SEQUENCE}
 * Exemplo: FAT-202603-0001
 * 
 * @param {String} type - Tipo da fatura (patient/insurance)
 * @param {Date} date - Data de referência (default: hoje)
 * @returns {String} Número da fatura
 */
export async function generateInvoiceNumber(type, date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  
  // Prefixo baseado no tipo
  const prefix = {
    patient: 'FAT',
    insurance: 'CON'
  }[type] || 'FAT';
  
  // Busca último número deste mês
  const pattern = new RegExp(`^${prefix}-${year}${month}-`);
  const lastInvoice = await Invoice.findOne({
    invoiceNumber: { $regex: pattern }
  }).sort({ invoiceNumber: -1 });
  
  let sequence = 1;
  if (lastInvoice) {
    const parts = lastInvoice.invoiceNumber.split('-');
    sequence = parseInt(parts[2]) + 1;
  }
  
  return `${prefix}-${year}${month}-${String(sequence).padStart(4, '0')}`;
}
