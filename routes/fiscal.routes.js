// routes/fiscal.routes.js
// Rotas REST mínimas para o MVP do módulo fiscal NFS-e.
// Base: /api/v2/fiscal

import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getFiscalProfile,
  upsertFiscalProfile,
  createCertificate,
  listCertificates,
  emitFiscalInvoice,
  emitFromPayment,
  listFiscalInvoices,
  getFiscalInvoice,
  retryFiscalInvoice,
  cancelFiscalInvoice,
  downloadFiscalInvoiceXml,
  downloadFiscalInvoicePdf
} from '../controllers/fiscalController.js';

const router = express.Router();

// Configuração fiscal
router.get('/profile', auth, getFiscalProfile);
router.post('/profile', auth, upsertFiscalProfile);
router.get('/certificates', auth, listCertificates);
router.post('/certificates', auth, createCertificate);

// Emissão e consulta
router.post('/nfse/emit', auth, emitFiscalInvoice);
router.post('/nfse/emit-from-payment', auth, emitFromPayment);
router.get('/nfse', auth, listFiscalInvoices);
router.get('/nfse/:id', auth, getFiscalInvoice);
router.post('/nfse/:id/retry', auth, retryFiscalInvoice);
router.post('/nfse/:id/cancel', auth, cancelFiscalInvoice);

// Download
router.get('/nfse/:id/xml', auth, downloadFiscalInvoiceXml);
router.get('/nfse/:id/pdf', auth, downloadFiscalInvoicePdf);

export default router;
