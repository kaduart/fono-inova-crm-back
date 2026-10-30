// routes/fiscal.routes.js
// Rotas REST mínimas para o MVP do módulo fiscal NFS-e.
// Base: /api/v2/fiscal

import express from 'express';
import multer from 'multer';
import { auth, authorize } from '../middleware/auth.js';
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

// Só a gestão mexe no fiscal. Configuração (perfil, certificado, teste) é só admin;
// emitir, cancelar e consultar notas é admin ou secretária. Profissional não acessa.
const gestao = authorize(['admin', 'secretary']);
const somenteAdmin = authorize(['admin']);

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
router.get('/profile', auth, gestao, getFiscalProfile);
router.post('/profile', auth, somenteAdmin, upsertFiscalProfile);
router.get('/certificates', auth, gestao, listCertificates);
router.post('/certificates', auth, somenteAdmin, certificateUpload.single('file'), createCertificate);
router.post('/test-connection', auth, somenteAdmin, testConnection);

// Emissão e consulta
router.post('/nfse/emit', auth, gestao, emitFiscalInvoice);
router.post('/nfse/emit-from-payment', auth, gestao, emitFromPayment);
router.get('/nfse/payment/:paymentId/context', auth, gestao, getPaymentFiscalContext);
router.get('/nfse', auth, gestao, listFiscalInvoices);
router.get('/nfse/:id', auth, gestao, getFiscalInvoice);
router.post('/nfse/:id/retry', auth, gestao, retryFiscalInvoice);
router.post('/nfse/:id/cancel', auth, gestao, cancelFiscalInvoice);

// Download
router.get('/nfse/:id/xml', auth, gestao, downloadFiscalInvoiceXml);
router.get('/nfse/:id/pdf', auth, gestao, downloadFiscalInvoicePdf);

export default router;
