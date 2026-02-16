// routes/convenioPackages.js
import express from 'express';
import {
  createConvenioPackage,
  getConvenioPackages,
  getConvenioPackageById,
  cancelConvenioSession,
  addConvenioSession,
  markConvenioSessionsAsPaid
} from '../controllers/convenioPackageController.js';

const router = express.Router();

/**
 * @route   POST /api/convenio-packages
 * @desc    Cria um pacote de convênio a partir de uma guia
 * @access  Private
 */
router.post('/', createConvenioPackage);

/**
 * @route   GET /api/convenio-packages
 * @desc    Lista pacotes de convênio de um paciente
 * @query   patientId (required)
 * @access  Private
 */
router.get('/', getConvenioPackages);

/**
 * @route   GET /api/convenio-packages/:id
 * @desc    Busca um pacote de convênio específico
 * @access  Private
 */
router.get('/:id', getConvenioPackageById);

/**
 * @route   PATCH /api/convenio-packages/:packageId/sessions/:sessionId/cancel
 * @desc    Cancela uma sessão do pacote (devolve à guia se consumida)
 * @access  Private
 */
router.patch('/:packageId/sessions/:sessionId/cancel', cancelConvenioSession);

/**
 * @route   POST /api/convenio-packages/:packageId/sessions
 * @desc    Adiciona nova sessão ao pacote de convênio
 * @access  Private
 */
router.post('/:packageId/sessions', addConvenioSession);

/**
 * @route   PATCH /api/convenio-packages/:packageId/mark-paid
 * @desc    Marca sessões como pagas quando convênio efetivamente paga (30 dias depois)
 * @access  Private
 */
router.patch('/:packageId/mark-paid', markConvenioSessionsAsPaid);

export default router;
