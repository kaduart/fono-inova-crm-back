/**
 * 📘 Meta Video Publisher — Upload e criação de campanhas
 * 
 * Prioridade 3: Meta Ads API integration
 * - Upload vídeo como AdVideo
 * - Criar AdCreative (Click-to-WhatsApp)
 * - Criar Campaign + AdSet + Ad (PAUSED)
 * 
 * ⚠️ REQUER: facebook-nodejs-business-sdk
 * npm install facebook-nodejs-business-sdk
 */

import { account } from './metaClient.js';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import logger from '../../utils/logger.js';

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT   = process.env.META_AD_ACCOUNT_ID;
const PAGE_ID      = process.env.META_PAGE_ID;
const API_VERSION  = process.env.META_API_VERSION || 'v21.0';

/**
 * Publica vídeo na Meta e cria campanha completa
 * @param {Object} params
 * @param {string} params.videoPath - Caminho local do vídeo final
 * @param {Object} params.copy - { texto_primario, headline, descricao }
 * @param {string} params.nomeCampanha - Nome da campanha
 * @param {Object} params.targeting - Configurações de targeting (opcional)
 * @returns {Object} IDs da campanha criada
 */
export async function publicarVideo({ videoPath, copy, nomeCampanha, targeting = {} }) {
  if (!ACCESS_TOKEN || !AD_ACCOUNT) {
    throw new Error('Meta Ads não configurado (META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID)');
  }

  logger.info(`[META] Iniciando publicação: ${nomeCampanha}`);

  // 1. Upload do vídeo
  logger.info('[META] 1/4 Upload do vídeo...');
  const videoId = await _uploadVideo(videoPath, nomeCampanha);
  logger.info(`[META] ✅ Video ID: ${videoId}`);

  // 2. Aguardar processamento
  await _aguardarProcessamentoVideo(videoId);

  // 3. Criar AdCreative (Click-to-WhatsApp)
  logger.info('[META] 2/4 Criando AdCreative...');
  const creativeId = await _criarAdCreative(videoId, copy);
  logger.info(`[META] ✅ Creative ID: ${creativeId}`);

  // 4. Criar Campanha
  logger.info('[META] 3/4 Criando Campanha...');
  const campaignId = await _criarCampanha(nomeCampanha, targeting);
  logger.info(`[META] ✅ Campaign ID: ${campaignId}`);

  // 5. Criar AdSet
  logger.info('[META] 4/4 Criando AdSet e Ad...');
  const { adsetId, adId } = await _criarAdSetEAd(campaignId, creativeId, targeting);
  logger.info(`[META] ✅ AdSet: ${adsetId} | Ad: ${adId}`);

  return {
    video_id: videoId,
    creative_id: creativeId,
    campaign_id: campaignId,
    adset_id: adsetId,
    ad_id: adId,
    status: 'PAUSED',
    nome: nomeCampanha
  };
}

/**
 * Upload do vídeo para a Meta
 */
async function _uploadVideo(filePath, titulo) {
  const form = new FormData();
  form.append('source', fs.createReadStream(filePath));
  form.append('title', titulo.substring(0, 100));
  form.append('access_token', ACCESS_TOKEN);

  const url = `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT}/advideos`;
  
  const { data } = await axios.post(url, form, {
    headers: { ...form.getHeaders() },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 300000  // 5 minutos
  });

  if (!data.id) {
    throw new Error(`Upload falhou: ${JSON.stringify(data)}`);
  }

  return data.id;
}

/**
 * Aguarda processamento do vídeo na Meta
 */
async function _aguardarProcessamentoVideo(videoId, maxTentativas = 30) {
  for (let i = 0; i < maxTentativas; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const { data } = await axios.get(
      `https://graph.facebook.com/${API_VERSION}/${videoId}`,
      { params: { fields: 'status', access_token: ACCESS_TOKEN } }
    );

    if (data.status?.video_status === 'ready') {
      return;
    }
  }

  logger.warn('[META] Vídeo não processou em tempo, tentando mesmo assim...');
}

/**
 * Cria AdCreative com Click-to-WhatsApp
 */
async function _criarAdCreative(videoId, copy) {
  // Usar SDK se disponível, senão API REST
  if (account) {
    const creative = await account.createAdCreative([], {
      name: `Creative_${Date.now()}`,
      object_story_spec: {
        page_id: PAGE_ID,
        video_data: {
          video_id: videoId,
          message: copy.texto_primario?.substring(0, 500),
          title: copy.headline?.substring(0, 255),
          link_description: copy.descricao?.substring(0, 255),
          call_to_action: {
            type: 'WHATSAPP_MESSAGE',
            value: { 
              whatsapp_number: process.env.WHATSAPP_NUMBER || '+5562993377726' 
            }
          }
        }
      }
    });
    return creative.id;
  }

  // Fallback: API REST
  const url = `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT}/adcreatives`;
  
  const { data } = await axios.post(url, {
    name: `Creative_${Date.now()}`,
    object_story_spec: {
      page_id: PAGE_ID,
      video_data: {
        video_id: videoId,
        message: copy.texto_primario,
        title: copy.headline,
        link_description: copy.descricao,
        call_to_action: {
          type: 'WHATSAPP_MESSAGE',
          value: { 
            whatsapp_number: process.env.WHATSAPP_NUMBER || '+5562993377726' 
          }
        }
      }
    },
    access_token: ACCESS_TOKEN
  });

  return data.id;
}

/**
 * Cria Campanha
 */
async function _criarCampanha(nome, targeting) {
  const url = `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT}/campaigns`;
  
  const { data } = await axios.post(url, {
    name: nome,
    objective: targeting?.objetivo || 'OUTCOME_ENGAGEMENT',
    status: 'PAUSED',
    special_ad_categories: ['NONE'],
    access_token: ACCESS_TOKEN
  });

  return data.id;
}

/**
 * Cria AdSet e Ad
 */
async function _criarAdSetEAd(campaignId, creativeId, targeting) {
  // 1. Criar AdSet
  const adsetUrl = `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT}/adsets`;
  
  const adsetParams = {
    name: `${targeting?.nomeCampanha || 'Campanha'}_CONJ01`,
    campaign_id: campaignId,
    daily_budget: (targeting?.orcamento_diario || 30) * 100,  // em centavos
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'THRUPLAY',  // otimizar pra quem assiste
    targeting: {
      age_min: targeting?.idade_min || 25,
      age_max: targeting?.idade_max || 45,
      genders: [2],  // Mulheres
      geo_locations: targeting?.geo || {
        cities: [{ key: '2510794', radius: 40, distance_unit: 'kilometer' }]  // Anápolis
      },
      ...(targeting?.interesses && {
        flexible_spec: [{
          interests: targeting.interesses.map(i => ({ name: i }))
        }]
      })
    },
    status: 'PAUSED',
    access_token: ACCESS_TOKEN
  };

  const { data: adsetData } = await axios.post(adsetUrl, adsetParams);
  const adsetId = adsetData.id;

  // 2. Criar Ad
  const adUrl = `https://graph.facebook.com/${API_VERSION}/${AD_ACCOUNT}/ads`;
  
  const { data: adData } = await axios.post(adUrl, {
    name: `Ad_${Date.now()}`,
    adset_id: adsetId,
    creative: { creative_id: creativeId },
    status: 'PAUSED',
    access_token: ACCESS_TOKEN
  });

  return { adsetId, adId: adData.id };
}

export default { publicarVideo };
