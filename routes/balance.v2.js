// routes/balance.v2.js
/**
 * Rotas V2 para Balance - Event-driven
 * 
 * GET  /v2/balance/:patientId           → Lista saldo e transações
 * POST /v2/balance/:patientId/debit     → Adiciona débito (event)
 * PATCH /v2/balance/:patientId/:transactionId → Edita transação (event)
 * DELETE /v2/balance/:patientId/:transactionId → Remove transação (event)
 */

import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import PatientBalance from '../models/PatientBalance.js';

const router = express.Router();

// Helper para resolver patientId (pode vir do patients_view)
async function resolvePatientId(patientId) {
  if (!mongoose.Types.ObjectId.isValid(patientId)) {
    return patientId;
  }
  
  let resolvedPatientId = patientId;
  const patientExists = await mongoose.connection.db.collection('patients').findOne(
    { _id: new mongoose.Types.ObjectId(patientId) },
    { projection: { _id: 1 } }
  );
  if (!patientExists) {
    const viewDoc = await mongoose.connection.db.collection('patients_view').findOne(
      { _id: new mongoose.Types.ObjectId(patientId) },
      { projection: { patientId: 1 } }
    );
    if (viewDoc?.patientId) {
      resolvedPatientId = viewDoc.patientId.toString();
    }
  }
  return resolvedPatientId;
}

// ======================================================
// GET /v2/balance/:patientId - Lista saldo e transações
// ======================================================
router.get('/:patientId', auth, async (req, res) => {
    try {
        const { patientId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({
                success: false,
                error: 'ID de paciente inválido'
            });
        }

        // Resolver patientId (pode vir do patients_view)
        const resolvedPatientId = await resolvePatientId(patientId);

        // Busca ou cria balance
        let balance = await PatientBalance.findOne({ patient: resolvedPatientId })
            .populate('transactions.registeredBy', 'fullName')
            .lean();

        if (!balance) {
            // Retorna vazio se não existe
            return res.json({
                success: true,
                data: {
                    patientId: resolvedPatientId,
                    currentBalance: 0,
                    totalDebited: 0,
                    totalCredited: 0,
                    transactions: []
                }
            });
        }

        res.json({
            success: true,
            data: {
                patientId,
                currentBalance: balance.currentBalance,
                totalDebited: balance.totalDebited || 0,
                totalCredited: balance.totalCredited || 0,
                transactions: balance.transactions || []
            }
        });

    } catch (error) {
        console.error('[BalanceV2] Erro ao buscar saldo:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar saldo: ' + error.message
        });
    }
});

// ======================================================
// POST /v2/balance/:patientId/debit - Adiciona débito (event-driven, otimizado)
// ======================================================
router.post('/:patientId/debit', auth, async (req, res) => {
    try {
        const { patientId } = req.params;
        const { amount, description, sessionId, appointmentId } = req.body;

        // 🛡️ VALIDAÇÃO (fail fast)
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({
                success: false,
                error: 'ID de paciente inválido'
            });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Valor deve ser maior que zero'
            });
        }

        // Resolver patientId
        const resolvedPatientId = await resolvePatientId(patientId);

        // 🚀 VERIFICAÇÃO LEVE (sem transaction)
        const balance = await PatientBalance.findOne(
            { patient: resolvedPatientId },
            { processingStatus: 1 }
        ).lean();
        
        if (balance?.processingStatus === 'updating') {
            return res.status(409).json({
                success: false,
                error: 'Saldo está sendo processado, tente novamente'
            });
        }

        // Publica evento para processamento async
        const correlationId = `balance_debit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const eventResult = await publishEvent(
            EventTypes.BALANCE_DEBIT_REQUESTED,
            {
                patientId: resolvedPatientId,
                amount,
                description,
                sessionId,
                appointmentId,
                type: 'debit',
                requestedBy: req.user?._id?.toString(),
                requestedAt: new Date().toISOString()
            },
            {
                correlationId,
                aggregateType: 'balance',
                aggregateId: resolvedPatientId,
                metadata: {
                    source: 'balance_api_v2',
                    userId: req.user?._id?.toString()
                }
            }
        );

        console.log(`[BalanceV2] Débito enfileirado: ${eventResult.eventId}`, {
            patientId: resolvedPatientId,
            amount,
            correlationId
        });

        res.status(202).json({
            success: true,
            message: 'Débito enfileirado para processamento',
            data: {
                eventId: eventResult.eventId,
                correlationId,
                patientId: resolvedPatientId,
                amount,
                status: 'pending',
                checkStatusUrl: `/api/v2/payments/status/${eventResult.eventId}`
            }
        });

    } catch (error) {
        console.error('[BalanceV2] Erro ao criar débito:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao criar débito: ' + error.message
        });
    }
});

export default router;
