// routes/fiscal.routes.js
// Rotas REST mínimas para o MVP do módulo fiscal NFS-e.
// Base: /api/v2/fiscal

import express from 'express';
import multer from 'multer';
import { auth } from '../middleware/auth.js';
import {
  getFiscalProfile,
  upsertFiscalProfile,
  createCertificate,
  listCertificates,
  emitFiscalInvoice,
  emitFromPayment,
  getPaymentFiscalContext,
  listFiscalInvoices,
  getFiscalInvoice,
  retryFiscalInvoice,
  cancelFiscalInvoice,
  downloadFiscalInvoiceXml,
  downloadFiscalInvoicePdf,
  testConnection
} from '../controllers/fiscalController.js';

const router = express.Router();

// Upload do certificado digital (.pfx/.p12) — memória apenas (o buffer é criptografado e
// persistido no controller; nunca gravado em disco em texto claro). Certificado A1 típico tem
// poucos KB, 5MB é folga generosa.
const certificateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pfx', '.p12'];
    const ok = allowed.some((ext) => file.originalname.toLowerCase().endsWith(ext));
    cb(ok ? null : new Error('Arquivo inválido — envie um certificado .pfx ou .p12'), ok);
  }
});

// Configuração fiscal
router.get('/profile', auth, getFiscalProfile);
router.post('/profile', auth, upsertFiscalProfile);
router.get('/certificates', auth, listCertificates);
router.post('/certificates', auth, certificateUpload.single('file'), createCertificate);
router.post('/test-connection', auth, testConnection);

// Emissão e consulta
router.post('/nfse/emit', auth, emitFiscalInvoice);
router.post('/nfse/emit-from-payment', auth, emitFromPayment);
router.get('/nfse/payment/:paymentId/context', auth, getPaymentFiscalContext);
router.get('/nfse', auth, listFiscalInvoices);
router.get('/nfse/:id', auth, getFiscalInvoice);
router.post('/nfse/:id/retry', auth, retryFiscalInvoice);
router.post('/nfse/:id/cancel', auth, cancelFiscalInvoice);

// Download
router.get('/nfse/:id/xml', auth, downloadFiscalInvoiceXml);
router.get('/nfse/:id/pdf', auth, downloadFiscalInvoicePdf);

export default router;
