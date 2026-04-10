/**
 * 🏦 ROTAS DO LEDGER FINANCEIRO
 * 
 * Endpoints para consulta e auditoria financeira
 */

import express from 'express';
import FinancialLedger from '../models/FinancialLedger.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { generateCashflowReport, reconcileLedger } from '../services/financialLedgerService.js';

const router = express.Router();

/**
 * 🏦 GET /api/ledger/cashflow
 * 
 * Relatório de cashflow por período
 * Query params: startDate, endDate, groupBy (day|week|month)
 */
router.get('/cashflow', flexibleAuth, asyncHandler(async (req, res) => {
    const { startDate, endDate, groupBy = 'day' } = req.query;
    
    if (!startDate || !endDate) {
        return res.status(400).json({
            success: false,
            error: 'startDate e endDate são obrigatórios'
        });
    }
    
    const report = await generateCashflowReport(
        new Date(startDate),
        new Date(endDate),
        groupBy
    );
    
    res.json({
        success: true,
        data: report
    });
}));

/**
 * 🏦 GET /api/ledger/reconcile
 * 
 * Reconciliação financeira (compara Ledger com Payments)
 */
router.get('/reconcile', flexibleAuth, asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const filters = {};
    if (startDate && endDate) {
        filters.occurredAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        };
    }
    
    const result = await reconcileLedger(filters);
    
    res.json({
        success: true,
        data: result
    });
}));

/**
 * 🏦 GET /api/ledger/entries
 * 
 * Lista lançamentos do ledger (com filtros)
 * Query params: patientId, startDate, endDate, type, limit, page
 */
router.get('/entries', flexibleAuth, asyncHandler(async (req, res) => {
    const { 
        patientId, 
        startDate, 
        endDate, 
        type, 
        direction,
        limit = 50, 
        page = 1 
    } = req.query;
    
    const query = {};
    
    if (patientId) query.patient = patientId;
    if (type) query.type = type;
    if (direction) query.direction = direction;
    
    if (startDate && endDate) {
        query.occurredAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [entries, total] = await Promise.all([
        FinancialLedger.find(query)
            .populate('patient', 'name')
            .populate('appointment', 'date')
            .populate('payment', 'amount status')
            .sort({ occurredAt: -1 })
            .limit(parseInt(limit))
            .skip(skip)
            .lean(),
        FinancialLedger.countDocuments(query)
    ]);
    
    res.json({
        success: true,
        data: {
            entries,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        }
    });
}));

/**
 * 🏦 GET /api/ledger/patient/:patientId/balance
 * 
 * Saldo financeiro de um paciente
 */
router.get('/patient/:patientId/balance', flexibleAuth, asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    
    const result = await FinancialLedger.reconcile({ patient: patientId });
    
    // Busca também pendente (fiado)
    const pendingSessions = await mongoose.model('Session').countDocuments({
        patient: patientId,
        paymentStatus: 'pending'
    });
    
    res.json({
        success: true,
        data: {
            patientId,
            totalPaid: result.credit,
            totalRefunded: result.debit,
            netBalance: result.balance,
            pendingSessions,
            status: result.balance >= 0 ? 'ok' : 'debit'
        }
    });
}));

export default router;
