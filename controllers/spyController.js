/**
 * 🔍 Spy Controller - Análise de Concorrentes
 */

import AdSpy from '../models/AdSpy.js';
import * as adSpyService from '../services/adSpyService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

/**
 * Busca anúncios na Meta Ad Library
 */
export async function searchAds(req, res) {
  try {
    const { keyword, especialidade, limit = 20 } = req.query;
    
    const ads = await adSpyService.searchAds({ 
      keyword, 
      especialidade, 
      limit: parseInt(limit) 
    });
    
    res.json({ success: true, data: ads });
  } catch (error) {
    console.error('Erro ao buscar anúncios:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message || 'Erro ao buscar anúncios', {
        status: 500,
      }),
      req
    );
  }
}

/**
 * Analisa um anúncio com IA
 */
export async function analyzeAd(req, res) {
  try {
    const { adText, pageName, adTitle } = req.body;
    
    if (!adText) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Texto do anúncio é obrigatório', { status: 400 }), req);
    }
    
    const analysis = await adSpyService.analyzeAd({ 
      adText, 
      pageName: pageName || 'Desconhecido', 
      adTitle: adTitle || '' 
    });
    
    res.json({ success: true, data: analysis });
  } catch (error) {
    console.error('Erro ao analisar anúncio:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message || 'Erro ao analisar anúncio', {
        status: 500,
      }),
      req
    );
  }
}

/**
 * Adapta um anúncio para a voz da Fono Inova
 */
export async function adaptAd(req, res) {
  try {
    const { adText, especialidade, funil, analysis } = req.body;
    
    if (!adText) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Texto do anúncio é obrigatório', { status: 400 }), req);
    }
    
    const adaptedPost = await adSpyService.adaptAdForClinica({
      adText,
      especialidade: especialidade || 'geral',
      funil: funil || 'top',
      analysis
    });
    
    res.json({ 
      success: true, 
      data: { adaptedPost } 
    });
  } catch (error) {
    console.error('Erro ao adaptar anúncio:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', error.message || 'Erro ao adaptar anúncio', {
        status: 500,
      }),
      req
    );
  }
}

/**
 * Lista anúncios salvos
 */
export async function listSaved(req, res) {
  try {
    const userId = req.user._id;
    const { especialidade } = req.query;
    
    const query = { createdBy: userId, saved: true };
    if (especialidade) {
      query.especialidade = especialidade;
    }
    
    const ads = await AdSpy.find(query)
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json({ success: true, data: ads });
  } catch (error) {
    console.error('Erro ao listar salvos:', error);
    sendApiError(res, error, req);
  }
}

/**
 * Salva um anúncio como referência
 */
export async function saveAd(req, res) {
  try {
    const userId = req.user._id;
    const adData = req.body;
    
    // Verifica se já existe
    const existing = await AdSpy.findOne({ 
      adId: adData.adId, 
      createdBy: userId 
    });
    
    if (existing) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Anúncio já salvo', { status: 400 }), req);
    }
    
    const ad = new AdSpy({
      ...adData,
      saved: true,
      createdBy: userId
    });
    
    await ad.save();
    
    res.json({ success: true, data: ad });
  } catch (error) {
    console.error('Erro ao salvar anúncio:', error);
    sendApiError(res, error, req);
  }
}

/**
 * Remove um anúncio salvo
 */
export async function deleteSaved(req, res) {
  try {
    const userId = req.user._id;
    const { id } = req.params;
    
    await AdSpy.findOneAndDelete({ 
      _id: id, 
      createdBy: userId 
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao deletar:', error);
    sendApiError(res, error, req);
  }
}

/**
 * Busca keywords sugeridas por especialidade
 */
export async function getKeywords(req, res) {
  try {
    res.json({ 
      success: true, 
      data: adSpyService.KEYWORDS_BY_ESPECIALIDADE 
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
}
