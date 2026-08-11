import {
  InsuranceBatchReceiptError,
  listInvoiceReceivables,
  receiveInsuranceBatch,
  updateInvoiceNumber
} from '../services/insuranceBatch/InsuranceBatchReceiptService.js';

function sendError(res, error) {
  const status = error instanceof InsuranceBatchReceiptError ? error.status : 500;
  if (status === 500) console.error('[InsuranceBatchReceipt]', error);
  return res.status(status).json({
    success: false,
    code: error.code || 'INSURANCE_BATCH_RECEIPT_INTERNAL_ERROR',
    message: error.message,
    ...(error.details ? { details: error.details } : {})
  });
}

export async function list(req, res) {
  try {
    const data = await listInvoiceReceivables(req.query);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

export async function update(req, res) {
  try {
    const data = await updateInvoiceNumber(req.params.id, {
      invoiceNumber: req.body.invoiceNumber,
      userId: req.user.id
    });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

export async function receive(req, res) {
  try {
    const data = await receiveInsuranceBatch(req.params.id, {
      receivedDate: req.body.receivedDate,
      userId: req.user.id,
      guideIds: req.body.guideIds
    });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

export default { list, receive, update };
