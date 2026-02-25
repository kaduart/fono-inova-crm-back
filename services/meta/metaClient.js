/**
 * 📘 Meta Ads API Client
 * SDK oficial do Facebook para Node.js
 */

import { FacebookAdsApi, AdAccount } from 'facebook-nodejs-business-sdk';
import logger from '../../utils/logger.js';

// Inicializa API apenas se token configurado
let api = null;
let account = null;

if (process.env.META_ACCESS_TOKEN) {
  try {
    api = FacebookAdsApi.init(process.env.META_ACCESS_TOKEN);
    
    if (process.env.NODE_ENV !== 'production') {
      api.setDebug(false);
    }

    if (process.env.META_AD_ACCOUNT_ID) {
      account = new AdAccount(process.env.META_AD_ACCOUNT_ID);
    }
    
    logger.info('[META CLIENT] API inicializada com sucesso');
  } catch (error) {
    logger.error('[META CLIENT] Erro ao inicializar:', error.message);
  }
} else {
  logger.warn('[META CLIENT] META_ACCESS_TOKEN não configurado');
}

export { api, account };
export default { api, account };
