// routes/billingDocuments.routes.js
import express from 'express';
import { auth } from '../middleware/auth.js';
import { composeBillingDocuments } from '../services/billing/BillingDocumentComposer.js';

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
      return res.status(400).json({
        success: false,
        error: 'patientId e guideId são obrigatórios'
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Usuário não autenticado'
      });
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
    return res.status(422).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
