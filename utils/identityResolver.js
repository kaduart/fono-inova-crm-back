/**
 * 🔑 Identity Resolver - Centralizador de identidade de pacientes
 * 
 * Regra V2: Sempre usar patientId (ObjectId real do Patient)
 * Nunca usar _id da patients_view diretamente
 */

import mongoose from 'mongoose';
import logger from './logger.js';

const PatientsView = mongoose.model('PatientsView');
const Patient = mongoose.model('Patient');

/**
 * Resolve qualquer identificador de paciente para o patientId canônico
 * 
 * @param {string} inputId - Pode ser patientId real ou _id da patients_view
 * @param {Object} options - Opções
 * @param {string} options.correlationId - Para logs
 * @param {boolean} options.throwIfNotFound - Lançar erro se não encontrar (default: true)
 * @returns {Promise<string|null>} - patientId canônico ou null
 */
export async function resolvePatientId(inputId, options = {}) {
  const { correlationId = 'identity_resolve', throwIfNotFound = true } = options;
  
  if (!inputId) {
    if (throwIfNotFound) {
      throw new Error('IDENTITY_MISSING: patientId é obrigatório');
    }
    return null;
  }
  
  // Se não for ObjectId válido, retorna como está (pode ser string legada)
  if (!mongoose.Types.ObjectId.isValid(inputId)) {
    logger.warn(`[${correlationId}] ⚠️ ID inválido recebido: ${inputId}`);
    if (throwIfNotFound) {
      throw new Error('IDENTITY_INVALID: ID não é um ObjectId válido');
    }
    return inputId; // Fallback para compatibilidade
  }
  
  const objectId = new mongoose.Types.ObjectId(inputId);
  
  // 1. Verifica se é um patientId real (collection patients)
  const patientExists = await Patient.exists({ _id: objectId });
  if (patientExists) {
    logger.debug(`[${correlationId}] ✅ ID é patientId real: ${inputId}`);
    return inputId;
  }
  
  // 2. Verifica se é _id da patients_view
  const viewDoc = await PatientsView.findById(objectId).select('patientId').lean();
  if (viewDoc?.patientId) {
    logger.info(`[${correlationId}] 🔄 Resolvido _id da view para patientId: ${viewDoc.patientId}`);
    return viewDoc.patientId.toString();
  }
  
  // 3. Tenta buscar na view por patientId (caso o input já seja patientId mas não exista mais)
  const viewByPatientId = await PatientsView.findOne({ patientId: inputId }).select('patientId').lean();
  if (viewByPatientId?.patientId) {
    logger.debug(`[${correlationId}] ✅ ID encontrado na view por patientId: ${inputId}`);
    return inputId;
  }
  
  // Não encontrou em lugar nenhum
  logger.error(`[${correlationId}] ❌ Paciente não encontrado: ${inputId}`);
  if (throwIfNotFound) {
    throw new Error('IDENTITY_NOT_FOUND: Paciente não encontrado');
  }
  return null;
}

/**
 * Resolve múltiplos IDs em batch (mais eficiente)
 * 
 * @param {string[]} inputIds - Array de IDs
 * @param {Object} options - Opções
 * @returns {Promise<string[]>} - Array de patientIds canônicos
 */
export async function resolvePatientIds(inputIds, options = {}) {
  const { correlationId = 'identity_resolve_batch' } = options;
  
  if (!inputIds || !Array.isArray(inputIds)) {
    return [];
  }
  
  // Remove duplicados e invalidos
  const uniqueIds = [...new Set(inputIds)].filter(id => 
    mongoose.Types.ObjectId.isValid(id)
  );
  
  if (uniqueIds.length === 0) {
    return [];
  }
  
  // Busca todos de uma vez na view
  const views = await PatientsView.find({
    $or: [
      { _id: { $in: uniqueIds.map(id => new mongoose.Types.ObjectId(id)) } },
      { patientId: { $in: uniqueIds } }
    ]
  }).select('_id patientId').lean();
  
  // Cria mapa de resolução
  const resolutionMap = new Map();
  
  for (const view of views) {
    // Mapeia _id da view para patientId
    resolutionMap.set(view._id.toString(), view.patientId.toString());
    // Mapeia patientId para ele mesmo
    resolutionMap.set(view.patientId.toString(), view.patientId.toString());
  }
  
  // Resolve cada input
  const resolved = uniqueIds.map(id => {
    const resolvedId = resolutionMap.get(id);
    if (!resolvedId) {
      logger.warn(`[${correlationId}] ⚠️ Não resolvido: ${id}`);
    }
    return resolvedId || id; // Se não achou, retorna o original
  });
  
  return [...new Set(resolved)]; // Remove duplicados
}

/**
 * Middleware Express para auto-resolver patientId
 * Adiciona req.resolvedPatientId
 */
export function patientIdResolverMiddleware() {
  return async (req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || `identity_${Date.now()}`;
    
    // Resolve de body, query ou params
    const inputId = req.body?.patientId || req.query?.patientId || req.params?.patientId;
    
    if (inputId) {
      try {
        req.resolvedPatientId = await resolvePatientId(inputId, { correlationId });
        logger.debug(`[${correlationId}] 🔑 Middleware resolveu: ${inputId} -> ${req.resolvedPatientId}`);
      } catch (error) {
        logger.error(`[${correlationId}] ❌ Falha ao resolver patientId: ${error.message}`);
        return res.status(400).json({
          success: false,
          errorCode: 'IDENTITY_RESOLUTION_FAILED',
          message: error.message
        });
      }
    }
    
    next();
  };
}

/**
 * Valida se o ID é um patientId canônico (não _id de view)
 * Útil para validações estritas na V2
 */
export async function assertCanonicalPatientId(inputId, options = {}) {
  const { correlationId = 'identity_assert' } = options;
  
  const resolved = await resolvePatientId(inputId, { correlationId });
  
  // Verifica se o resolved é de fato um patient real
  const exists = await Patient.exists({ _id: new mongoose.Types.ObjectId(resolved) });
  
  if (!exists) {
    throw new Error('IDENTITY_INVALID: ID não corresponde a um paciente válido');
  }
  
  return resolved;
}

export default {
  resolvePatientId,
  resolvePatientIds,
  patientIdResolverMiddleware,
  assertCanonicalPatientId
};
