// controllers/insuranceBatchController.js
// Controller de Faturamento de Convênio V2

import mongoose from 'mongoose';
import { createBatch, sendBatch, processReturn, listBatches } from '../services/insuranceBatchService.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

/**
 * POST /api/v2/insurance-batches
 * Cria um novo lote de faturamento
 */
export async function createBatchController(req, res) {
  try {
    const { insuranceProvider, startDate, endDate } = req.body;
    const userId = req.user?._id;
    
    // Validações
    if (!insuranceProvider || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'insuranceProvider, startDate e endDate são obrigatórios'
      });
    }
    
    const batch = await createBatch({
      insuranceProvider,
      startDate,
      endDate,
      userId
    });
    
    res.status(201).json({
      success: true,
      message: `Lote criado com ${batch.totalSessions} sessões`,
      data: batch
    });
    
  } catch (error) {
    console.error('[InsuranceBatchController] Erro ao criar lote:', error);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * POST /api/v2/insurance-batches/:id/send
 * Envia lote para o convênio
 */
export async function sendBatchController(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    
    const batch = await sendBatch(id, userId);
    
    res.json({
      success: true,
      message: 'Lote enviado com sucesso',
      data: batch
    });
    
  } catch (error) {
    console.error('[InsuranceBatchController] Erro ao enviar lote:', error);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * POST /api/v2/insurance-batches/:id/return
 * Processa retorno do convênio
 */
export async function processReturnController(req, res) {
  try {
    const { id } = req.params;
    const returnData = req.body;
    
    const batch = await processReturn(id, returnData);
    
    res.json({
      success: true,
      message: 'Retorno processado com sucesso',
      data: batch
    });
    
  } catch (error) {
    console.error('[InsuranceBatchController] Erro ao processar retorno:', error);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * GET /api/v2/insurance-batches
 * Lista lotes de faturamento
 */
export async function listBatchesController(req, res) {
  try {
    const { insuranceProvider, status, page, limit } = req.query;
    
    const result = await listBatches({
      insuranceProvider,
      status,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20
    });
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('[InsuranceBatchController] Erro ao listar lotes:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * GET /api/v2/insurance-batches/:id
 * Detalhes de um lote
 */
export async function getBatchByIdController(req, res) {
  try {
    const { id } = req.params;
    
    const batch = await InsuranceBatch.findById(id)
      .populate('sessions.session', 'date time patient specialty status')
      .populate('sessions.appointment', 'date time operationalStatus')
      .populate('sessions.guide', 'number insurance');
    
    if (!batch) {
      return res.status(404).json({
        success: false,
        message: 'Lote não encontrado'
      });
    }
    
    res.json({
      success: true,
      data: batch
    });
    
  } catch (error) {
    console.error('[InsuranceBatchController] Erro ao buscar lote:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

export default {
  createBatch: createBatchController,
  sendBatch: sendBatchController,
  processReturn: processReturnController,
  listBatches: listBatchesController,
  getBatchById: getBatchByIdController
};
