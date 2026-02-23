/**
 * 🔍 Spy Controller - Análise de Concorrentes
 */

import AdSpy from '../models/AdSpy.js';
import * as adSpyService from '../services/adSpyService.js';

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
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Erro ao buscar anúncios' 
    });
  }
}

/**
 * Analisa um anúncio com IA
 */
export async function analyzeAd(req, res) {
  try {
    const { adText, pageName, adTitle } = req.body;
    
    if (!adText) {
      return res.status(400).json({ 
        success: false, 
        error: 'Texto do anúncio é obrigatório' 
      });
    }
    
    const analysis = await adSpyService.analyzeAd({ 
      adText, 
      pageName: pageName || 'Desconhecido', 
      adTitle: adTitle || '' 
    });
    
    res.json({ success: true, data: analysis });
  } catch (error) {
    console.error('Erro ao analisar anúncio:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Erro ao analisar anúncio' 
    });
  }
}

/**
 * Adapta um anúncio para a voz da Fono Inova
 */
export async function adaptAd(req, res) {
  try {
    const { adText, especialidade, funil, analysis } = req.body;
    
    if (!adText) {
      return res.status(400).json({ 
        success: false, 
        error: 'Texto do anúncio é obrigatório' 
      });
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
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Erro ao adaptar anúncio' 
    });
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
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
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
      return res.status(400).json({ 
        success: false, 
        error: 'Anúncio já salvo' 
      });
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
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
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
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
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
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
