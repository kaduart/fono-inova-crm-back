/**
 * 📦 Routes V2 - Package Contract API
 * 
 * Endpoints:
 * - POST /api/v2/packages - Criar contrato
 * - GET /api/v2/packages - Listar pacotes
 * - GET /api/v2/packages/:id - Detalhe
 * 
 * Integra com:
 * - Appointment V2 (para criar agendamentos)
 * - Financial Guard (para consumo de sessões)
 */

import express from 'express';
import { createPackageV2, listPackagesV2, getPackageV2, addLiminarCredit, cancelLiminarPackage } from '../controllers/packageController.v2.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { formatSuccess, formatError } from '../utils/apiMessages.js';
import { createContextLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createContextLogger('PackageRoutesV2');

// ============================================
// POST /api/v2/packages
// Criar novo contrato de pacote
// ============================================

/**
 * @swagger
 * /api/v2/packages:
 *   post:
 *     summary: Criar contrato de pacote V2
 *     description: |
 *       Cria um pacote (contrato financeiro) SEM side effects.
 *       NÃO cria sessões, appointments ou payments (exceto pré-pago).
 *     tags: [Packages V2]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [patientId, doctorId, specialty, totalSessions, type]
 *             properties:
 *               # Campos comuns
 *               patientId: { type: string, example: "507f1f77bcf86cd799439011" }
 *               doctorId: { type: string }
 *               specialty: { type: string, enum: [fonoaudiologia, psicologia, fisioterapia] }
 *               sessionType: { type: string }
 *               totalSessions: { type: number, minimum: 1 }
 *               sessionValue: { type: number }
 *               totalValue: { type: number }
 *               notes: { type: string }
 *               
 *               # Tipo
 *               type: { 
 *                 type: string, 
 *                 enum: [insurance, package, legal],
 *                 description: "insurance=convênio, package=particular, legal=liminar"
 *               }
 *               model: { 
 *                 type: string, 
 *                 enum: [prepaid, per_session],
 *                 description: "Obrigatório quando type=package"
 *               }
 *               
 *               # Convênio
 *               insuranceGuideId: { type: string }
 *               insuranceProvider: { type: string }
 *               
 *               # Liminar
 *               liminarProcessNumber: { type: string }
 *               liminarCourt: { type: string }
 *               liminarExpirationDate: { type: string, format: date }
 *               liminarMode: { type: string, enum: [hybrid, credit_only] }
 *               
 *               # Agenda completa (opcional)
 *               schedule:
 *                 type: array
 *                 description: Lista de datas/horas para criar appointments
 *                 items:
 *                   type: object
 *                   properties:
 *                     date: { type: string, format: date, example: "2026-05-15" }
 *                     time: { type: string, example: "14:00" }
 *               
 *               # Idempotência (recomendado para WhatsApp/Amanda)
 *               idempotencyKey:
 *                 type: string
 *                 description: Chave única para evitar duplicação
 *               
 *               # Pagamentos (só para pré-pago)
 *               payments:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     amount: { type: number }
 *                     method: { type: string, enum: [pix, dinheiro, cartao] }
 *                     date: { type: string, format: date }
 *                     description: { type: string }
 *           examples:
 *             prepaid:
 *               summary: Pacote Pré-pago (com agenda)
 *               value:
 *                 patientId: "507f1f77bcf86cd799439011"
 *                 doctorId: "507f1f77bcf86cd799439012"
 *                 specialty: "fonoaudiologia"
 *                 totalSessions: 4
 *                 sessionValue: 150
 *                 type: "package"
 *                 model: "prepaid"
 *                 schedule:
 *                   - date: "2026-05-01"
 *                     time: "14:00"
 *                   - date: "2026-05-08"
 *                     time: "14:00"
 *                   - date: "2026-05-15"
 *                     time: "14:00"
 *                   - date: "2026-05-22"
 *                     time: "14:00"
 *                 payments:
 *                   - amount: 600
 *                     method: "pix"
 *                 idempotencyKey: "whatsapp_12345"
 *             per_session:
 *               summary: Pacote Pagar no Dia
 *               value:
 *                 patientId: "507f1f77bcf86cd799439011"
 *                 doctorId: "507f1f77bcf86cd799439012"
 *                 specialty: "psicologia"
 *                 totalSessions: 8
 *                 sessionValue: 200
 *                 type: "package"
 *                 model: "per_session"
 *                 schedule:
 *                   - date: "2026-05-20"
 *                     time: "10:00"
 *                   - date: "2026-05-27"
 *                     time: "10:00"
 *             insurance:
 *               summary: Pacote Convênio
 *               value:
 *                 patientId: "507f1f77bcf86cd799439011"
 *                 doctorId: "507f1f77bcf86cd799439012"
 *                 specialty: "fisioterapia"
 *                 totalSessions: 12
 *                 type: "insurance"
 *                 insuranceGuideId: "507f1f77bcf86cd799439020"
 *                 insuranceProvider: "Unimed"
 *                 schedule:
 *                   - date: "2026-05-18"
 *                     time: "09:00"
 *                   - date: "2026-05-25"
 *                     time: "09:00"
 *             legal:
 *               summary: Pacote Liminar
 *               value:
 *                 patientId: "507f1f77bcf86cd799439011"
 *                 doctorId: "507f1f77bcf86cd799439012"
 *                 specialty: "fonoaudiologia"
 *                 totalSessions: 20
 *                 sessionValue: 150
 *                 totalValue: 3000
 *                 type: "legal"
 *                 liminarProcessNumber: "1234567-89.2023.8.26.0100"
 *                 liminarCourt: "3ª Vara Cível"
 *                 schedule:
 *                   - date: "2026-05-22"
 *                     time: "15:30"
 *                   - date: "2026-05-29"
 *                     time: "15:30"
 */
router.post('/', flexibleAuth, async (req, res) => {
  const startTime = Date.now();
  try {
    await createPackageV2(req, res);
  } catch (error) {
    logger.error('[PackageV2] Unexpected error', { error: error.message });
    res.status(500).json(formatError('Erro interno', 500));
  }
});

// ============================================
// GET /api/v2/packages
// Listar pacotes do paciente
// ============================================

/**
 * @swagger
 * /api/v2/packages:
 *   get:
 *     summary: Listar pacotes do paciente
 *     tags: [Packages V2]
 *     parameters:
 *       - name: patientId
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: type
 *         in: query
 *         schema: { type: string, enum: [convenio, therapy, liminar] }
 *       - name: status
 *         in: query
 *         schema: { type: string, enum: [active, finished, canceled] }
 */
router.get('/', flexibleAuth, listPackagesV2);

// ============================================
// GET /api/v2/packages/:id
// Detalhe do pacote
// ============================================

/**
 * @swagger
 * /api/v2/packages/{id}:
 *   get:
 *     summary: Detalhe do pacote
 *     tags: [Packages V2]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 */
router.get('/:id', flexibleAuth, getPackageV2);

// ============================================
// PATCH /api/v2/packages/:id/credit
// Recarga de crédito em pacote liminar
// ============================================
router.patch('/:id/credit', flexibleAuth, addLiminarCredit);

// ============================================
// PATCH /api/v2/packages/:id/cancel
// Cancelamento seguro de pacote liminar (com estorno de crédito das sessões completed)
// ============================================
router.patch('/:id/cancel', flexibleAuth, cancelLiminarPackage);

// ============================================
// POST /api/v2/packages/:id/consume-session
// [FUTURO] Consumir sessão manualmente
// ============================================
// router.post('/:id/consume-session', flexibleAuth, ...);

export default router;
