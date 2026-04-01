// domain/invoice/index.js
// Exporta todas as funções de domínio de faturas

export { createInvoice, createPerSessionInvoice, createMonthlyInvoice } from './createInvoice.js';
export { addPaymentToInvoice } from './addPaymentToInvoice.js';
export { cancelInvoice } from './cancelInvoice.js';
export { recalculateInvoice } from './recalculateInvoice.js';
export { generateInvoiceNumber } from './generateInvoiceNumber.js';
