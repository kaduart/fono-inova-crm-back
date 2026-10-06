/**
 * 🖼️ ImageBank Routes
 * API para gerenciar banco de imagens reutilizáveis
 */

import express from 'express';
import ImageBank from '../models/ImageBank.js';
import * as imageBankService from '../services/imageBankService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

/**
 * 🔍 GET /api/imagebank/search
 * Busca imagens por especialidade e tema
 */
router.get('/search', async (req, res) => {
  try {
    const { especialidade, tema, limit = 10 } = req.query;
    
    const images = await ImageBank.findByEspecialidadeETema(
      especialidade,
      tema,
      { limit: parseInt(limit) }
    );
    
    res.json({
      success: true,
      count: images.length,
      images
    });
  } catch (error) {
    console.error('❌ Erro ao buscar imagens:', error);
    sendApiError(res, error, req);
  }
});

/**
 * 📊 GET /api/imagebank/stats
 * Estatísticas do banco de imagens
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await imageBankService.getBankStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('❌ Erro ao buscar estatísticas:', error);
    sendApiError(res, error, req);
  }
});

/**
 * 💾 POST /api/imagebank/add
 * Adiciona nova imagem manualmente
 */
router.post('/add', async (req, res) => {
  try {
    const { url, publicId, especialidade, tema, provider, tags } = req.body;
    
    const image = await imageBankService.saveImageToBank({
      url,
      publicId,
      especialidade,
      tema,
      provider,
      tags
    });
    
    res.json({
      success: true,
      image
    });
  } catch (error) {
    console.error('❌ Erro ao adicionar imagem:', error);
    sendApiError(res, error, req);
  }
});

/**
 * 🔄 POST /api/imagebank/migrate
 * Migra imagens existentes do Cloudinary
 */
router.post('/migrate', async (req, res) => {
  try {
    const { especialidade, folder } = req.body;
    
    const count = await imageBankService.migrateExistingImages(especialidade, folder);
    
    res.json({
      success: true,
      message: `${count} imagens migradas com sucesso`,
      count
    });
  } catch (error) {
    console.error('❌ Erro ao migrar imagens:', error);
    sendApiError(res, error, req);
  }
});

/**
 * 🎯 GET /api/imagebank/random
 * Pega uma imagem aleatória
 */
router.get('/random', async (req, res) => {
  try {
    const { especialidade, tema } = req.query;
    
    const image = await ImageBank.getRandomImage(especialidade, tema);
    
    if (!image) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Nenhuma imagem encontrada', { status: 404 }), req);
    }
    
    res.json({
      success: true,
      image
    });
  } catch (error) {
    console.error('❌ Erro ao buscar imagem:', error);
    sendApiError(res, error, req);
  }
});

/**
 * 🗑️ DELETE /api/imagebank/:publicId
 * Arquiva uma imagem
 */
router.delete('/:publicId', async (req, res) => {
  try {
    const { publicId } = req.params;
    
    const image = await imageBankService.archiveImage(publicId);
    
    if (!image) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Imagem não encontrada', { status: 404 }), req);
    }
    
    res.json({
      success: true,
      message: 'Imagem arquivada',
      image
    });
  } catch (error) {
    console.error('❌ Erro ao arquivar imagem:', error);
    sendApiError(res, error, req);
  }
});

/**
 * 📋 GET /api/imagebank
 * Lista todas as imagens ativas
 */
router.get('/', async (req, res) => {
  try {
    const { especialidade, limit = 50, skip = 0 } = req.query;
    
    const query = { status: 'active' };
    if (especialidade) query.especialidade = especialidade;
    
    const images = await ImageBank.find(query)
      .sort({ createdAt: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit));
    
    const total = await ImageBank.countDocuments(query);
    
    res.json({
      success: true,
      total,
      count: images.length,
      images
    });
  } catch (error) {
    console.error('❌ Erro ao listar imagens:', error);
    sendApiError(res, error, req);
  }
});

export default router;
