/**
 * Auth State para Baileys usando MongoDB
 * Persiste sessão entre reinícios do servidor
 */

import BaileysSession from '../models/BaileysSession.js';
import { initAuthCreds } from '@whiskeysockets/baileys';

/**
 * Converte Buffer para string base64 para salvar no MongoDB
 */
function bufferToBase64(buffer) {
  if (!buffer) return null;
  if (Buffer.isBuffer(buffer)) return buffer.toString('base64');
  return buffer;
}

/**
 * Converte string base64 de volta para Buffer
 */
function base64ToBuffer(base64) {
  if (!base64) return null;
  return Buffer.from(base64, 'base64');
}

/**
 * Prepara credenciais para salvar no MongoDB
 */
function prepareCredsForMongo(creds) {
  if (!creds) return null;
  
  const prepared = JSON.parse(JSON.stringify(creds));
  
  // Converte Buffers para base64
  if (prepared.noiseKey) {
    if (prepared.noiseKey.private) prepared.noiseKey.private = bufferToBase64(prepared.noiseKey.private);
    if (prepared.noiseKey.public) prepared.noiseKey.public = bufferToBase64(prepared.noiseKey.public);
  }
  
  if (prepared.signedIdentityKey) {
    if (prepared.signedIdentityKey.private) prepared.signedIdentityKey.private = bufferToBase64(prepared.signedIdentityKey.private);
    if (prepared.signedIdentityKey.public) prepared.signedIdentityKey.public = bufferToBase64(prepared.signedIdentityKey.public);
  }
  
  if (prepared.signedPreKey) {
    if (prepared.signedPreKey.keyPair) {
      prepared.signedPreKey.keyPair.private = bufferToBase64(prepared.signedPreKey.keyPair.private);
      prepared.signedPreKey.keyPair.public = bufferToBase64(prepared.signedPreKey.keyPair.public);
    }
    prepared.signedPreKey.signature = bufferToBase64(prepared.signedPreKey.signature);
  }
  
  if (prepared.identityKey) {
    prepared.identityKey.private = bufferToBase64(prepared.identityKey.private);
    prepared.identityKey.public = bufferToBase64(prepared.identityKey.public);
  }
  
  return prepared;
}

/**
 * Restaura credenciais do MongoDB
 */
function restoreCredsFromMongo(creds) {
  if (!creds) return null;
  
  const restored = { ...creds };
  
  if (restored.noiseKey) {
    if (restored.noiseKey.private) restored.noiseKey.private = base64ToBuffer(restored.noiseKey.private);
    if (restored.noiseKey.public) restored.noiseKey.public = base64ToBuffer(restored.noiseKey.public);
  }
  
  if (restored.signedIdentityKey) {
    if (restored.signedIdentityKey.private) restored.signedIdentityKey.private = base64ToBuffer(restored.signedIdentityKey.private);
    if (restored.signedIdentityKey.public) restored.signedIdentityKey.public = base64ToBuffer(restored.signedIdentityKey.public);
  }
  
  if (restored.signedPreKey) {
    if (restored.signedPreKey.keyPair) {
      restored.signedPreKey.keyPair.private = base64ToBuffer(restored.signedPreKey.keyPair.private);
      restored.signedPreKey.keyPair.public = base64ToBuffer(restored.signedPreKey.keyPair.public);
    }
    restored.signedPreKey.signature = base64ToBuffer(restored.signedPreKey.signature);
  }
  
  if (restored.identityKey) {
    restored.identityKey.private = base64ToBuffer(restored.identityKey.private);
    restored.identityKey.public = base64ToBuffer(restored.identityKey.public);
  }
  
  return restored;
}

/**
 * Auth State usando MongoDB
 */
export async function useMongoAuthState(sessionId = 'default') {
  // Busca sessão no MongoDB
  let sessionDoc = await BaileysSession.findOne({ sessionId });
  
  // Verifica se as credenciais são válidas (precisa ter 'me' e 'noiseKey')
  const hasValidCreds = sessionDoc?.creds && sessionDoc.creds.me && sessionDoc.creds.noiseKey;
  
  if (!hasValidCreds) {
    console.log("[BaileysAuth] Sem sessão válida, criando novas credenciais...");
    // Cria nova sessão ou atualiza existente
    if (!sessionDoc) {
      sessionDoc = await BaileysSession.create({
        sessionId,
        creds: null,
        keys: {}
      });
    }
  }

  // Estado atual - usa initAuthCreds se não tiver credenciais válidas
  const creds = hasValidCreds ? restoreCredsFromMongo(sessionDoc.creds) : initAuthCreds();
  const keys = new Map(Object.entries(sessionDoc?.keys || {}));
  
  console.log("[BaileysAuth] Estado:", { 
    hasSessionDoc: !!sessionDoc, 
    hasValidCreds, 
    hasMe: !!creds?.me 
  });

  const state = { creds, keys };

  /**
   * Salva credenciais
   */
  const saveCreds = async (newCreds) => {
    state.creds = newCreds;
    await BaileysSession.updateOne(
      { sessionId },
      { 
        creds: prepareCredsForMongo(newCreds),
        updatedAt: new Date()
      }
    );
  };

  /**
   * Manipula chaves (keys)
   */
  const keyOperations = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        const key = `${type}-${id}`;
        const value = state.keys.get(key);
        if (value) {
          data[id] = base64ToBuffer(value);
        }
      }
      return data;
    },
    set: async (data) => {
      for (const type in data) {
        for (const id in data[type]) {
          const key = `${type}-${id}`;
          const value = data[type][id];
          if (value) {
            state.keys.set(key, bufferToBase64(value));
          }
        }
      }
      
      // Salva no MongoDB
      const keysObj = {};
      state.keys.forEach((value, key) => {
        keysObj[key] = value;
      });
      
      await BaileysSession.updateOne(
        { sessionId },
        { 
          keys: keysObj,
          updatedAt: new Date()
        }
      );
    }
  };

  return {
    state,
    saveCreds,
    keys: keyOperations
  };
}

export default useMongoAuthState;
