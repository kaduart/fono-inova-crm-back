import {
  BillingSubmissionError,
  cancelBillingSubmission,
  createBillingSubmission,
  finalizeBillingSubmission,
  getBillingSubmission,
  listBillingSubmissions,
  updateBillingSubmission
} from '../services/billingSubmission/BillingSubmissionService.js';

function sendError(res, error) {
  const status = error instanceof BillingSubmissionError
    ? error.status
    : (error?.name === 'ValidationError' || error?.name === 'CastError' ? 400 : 500);
  if (status === 500) console.error('[BillingSubmission]', error);
  return res.status(status).json({
    success: false,
    code: error.code || 'BILLING_SUBMISSION_INTERNAL_ERROR',
    message: error.message,
    ...(error.details ? { details: error.details } : {})
  });
}

export async function create(req, res) {
  try {
    const data = await createBillingSubmission({ ...req.body, userId: req.user.id });
    res.status(201).json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

export async function update(req, res) {
  try {
    const data = await updateBillingSubmission(req.params.id, { ...req.body, userId: req.user.id });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

export async function finalize(req, res) {
  try {
    // Envio externo é opcional e vem junto porque precisa nascer na mesma
    // transação do faturamento (ver finalizeBillingSubmission). E-mail NÃO passa
    // por aqui: é enfileirado depois do commit, pelo fluxo de comunicação.
    const reason = typeof req.body?.externalDeliveryReason === 'string'
      ? req.body.externalDeliveryReason.trim()
      : '';

    const data = await finalizeBillingSubmission(req.params.id, {
      userId: req.user.id,
      ...(reason ? { externalDelivery: { reason } } : {})
    });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

export async function cancel(req, res) {
  try {
    const data = await cancelBillingSubmission(req.params.id, { userId: req.user.id });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

export async function getById(req, res) {
  try {
    const data = await getBillingSubmission(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

export async function list(req, res) {
  try {
    const result = await listBillingSubmissions(req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
}

export default { create, update, finalize, cancel, getById, list };
