// routes/patientDocuments.routes.js
// Rotas isoladas para gerenciamento de documentos de pacientes (Document Center).
import express from 'express';
import { auth } from '../middleware/auth.js';
import { uploadMiddleware } from '../services/media/mediaUploadService.js';
import {
  createPatientDocument,
  createPatientDocumentFromBase64,
  listPatientDocuments
} from '../services/communication/PatientDocumentService.js';

const router = express.Router();

// GET /api/v2/patient-documents/patient/:patientId
router.get('/patient/:patientId', auth, async (req, res) => {
  try {
    const { type, page, limit } = req.query;
    const result = await listPatientDocuments({
      patientId: req.params.patientId,
      type,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 100
    });
    res.json({ success: true, data: result.data, pagination: result.pagination });
  } catch (error) {
    console.error('[PatientDocumentsRoutes] list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/v2/patient-documents
router.post('/', auth, uploadMiddleware, async (req, res) => {
  try {
    if (!req.file) throw new Error('Nenhum arquivo enviado');
    const { patientId, type, tags } = req.body;
    const doc = await createPatientDocument({
      patientId,
      type,
      name: req.file.originalname,
      originalName: req.file.originalname,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      size: req.file.size,
      extension: req.file.originalname.split('.').pop(),
      tags: tags ? JSON.parse(tags) : [],
      uploadedBy: req.user.id
    });
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    console.error('[PatientDocumentsRoutes] upload:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/v2/patient-documents/paste
router.post('/paste', auth, async (req, res) => {
  try {
    const { patientId, type, name, base64Image, mimeType, tags } = req.body;
    const doc = await createPatientDocumentFromBase64({
      patientId,
      type,
      name: name || 'print',
      base64Image,
      mimeType,
      tags: tags || [],
      uploadedBy: req.user.id
    });
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    console.error('[PatientDocumentsRoutes] paste:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
