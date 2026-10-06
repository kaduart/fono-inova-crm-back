// routes/billingDocuments.routes.js
import express from 'express';
import { auth } from '../middleware/auth.js';
import { composeBillingDocuments } from '../services/billing/BillingDocumentComposer.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

/**
 * @route   POST /api/v2/billing-documents/compose
 * @desc    Monta o dossiê de faturamento para um paciente/guia.
 *          Se persist=true, salva os PDFs gerados como PatientDocument.
 * @access  Private
 */
router.post('/compose', auth, async (req, res) => {
  try {
    const { patientId, guideId, sessionIds = [], persist = false } = req.body;
    const userId = req.user?.id;

    if (!patientId || !guideId) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'patientId e guideId são obrigatórios', {
          status: 400,
        }),
        req
      );
    }

    if (!userId) {
      return sendApiError(res, new AppError('UNAUTHORIZED', 'Usuário não autenticado', { status: 401 }), req);
    }

    const result = await composeBillingDocuments({
      patientId,
      guideId,
      sessionIds,
      generatedBy: userId,
      persist: persist === true
    });

    return res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('[BillingDocumentsRoutes] Erro ao compor documentos:', error);
    return sendApiError(res, new AppError('UNPROCESSABLE', error.message, { status: 422 }), req);
  }
});

export default router;
