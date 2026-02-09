/**
 * 🧠 ContextManager - Gerenciamento inteligente de contexto conversacional
 * Responsável por fazer merge de entidades preservando dados válidos
 * 
 * Versão 2.0 - Com logs estruturados para monitoramento
 */

import {
  isValidName,
  isValidAge,
  isValidTherapy,
  isValidPeriod,
  cleanName,
  shouldAcceptNewEntity,
  getValidationStats,
  calculateNameConfidence
} from './EntityValidator.js';
import Leads from '../../models/Leads.js';

// =============================================================================
// 📊 ESTATÍSTICAS DE CONTEXTO
// =============================================================================
const contextStats = {
  totalMerges: 0,
  namesPreserved: 0,
  namesUpdated: 0,
  namesRejected: 0,
  errors: 0
};

/**
 * Retorna estatísticas de contexto
 */
export function getContextStats() {
  return { ...contextStats, validatorStats: getValidationStats() };
}

/**
 * Reseta estatísticas
 */
export function resetContextStats() {
  contextStats.totalMerges = 0;
  contextStats.namesPreserved = 0;
  contextStats.namesUpdated = 0;
  contextStats.namesRejected = 0;
  contextStats.errors = 0;
}

// =============================================================================
// 🏗️ ESTRUTURA DE DADOS
// =============================================================================

export const DEFAULT_CONTEXT = {
  therapy: null,
  complaint: null,
  age: null,
  period: null,
  patientName: null,
  tipo_paciente: null,
  intencao: null,
  isConfirmation: false,
  isNegation: false,
  flags: {},
  
  // Metadados
  messageCount: 0,
  lastMessage: null,
  lastExtracted: [],
  lastAction: null,
  lastIntencao: null,
  currentStep: null,
  filledSlots: [],
  
  // Tracking de histórico de mudanças (para audit)
  changeHistory: [],
  
  // Timestamp
  lastUpdatedAt: null
};

// =============================================================================
// 💾 PERSISTÊNCIA
// =============================================================================

/**
 * Carrega contexto do banco de dados
 */
export async function loadContext(leadId) {
  try {
    const id = leadId?.toString?.() || leadId;

    if (!id || id === 'unknown') {
      console.log('[ContextManager] LeadId inválido, retornando contexto vazio');
      return { ...DEFAULT_CONTEXT };
    }

    const lead = await Leads.findById(id).lean();

    if (lead?.autoBookingContext) {
      const ctx = lead.autoBookingContext;

      // Log seguro (sem expor dados sensíveis)
      console.log('[ContextManager] Contexto carregado de Lead:', {
        leadId: id,
        hasPatientName: !!ctx.patientInfo?.fullName,
        hasAge: !!ctx.patientInfo?.age,
        hasTherapy: !!ctx.therapyArea,
        messageCount: ctx.messageCount || 0
      });

      // Mapear campos de Lead.autoBookingContext para formato do ContextManager
      return {
        ...DEFAULT_CONTEXT,
        therapy: ctx.therapyArea || ctx.mappedTherapyArea,
        complaint: ctx.complaint,
        patientName: ctx.patientInfo?.fullName,
        age: ctx.patientInfo?.age,
        period: ctx.preferredPeriod?.replace('ã', 'a'), // 'manhã' → 'manha'
        schedulingRequested: ctx.schedulingRequested,
        schedulingRequestedAt: ctx.schedulingRequestedAt,
        pendingSchedulingSlots: ctx.pendingSchedulingSlots || ctx.lastOfferedSlots,
        waitlistRequested: ctx.waitlistRequested,
        waitlistPreferences: ctx.waitlistPreferences,
        messageCount: ctx.messageCount,
        lastMessage: ctx.lastMessage,
        lastAction: ctx.lastAction,
        currentStep: ctx.currentStep,
        lastUpdatedAt: ctx.lastUpdatedAt
      };
    }

    console.log('[ContextManager] Novo contexto para lead:', id);
    return { ...DEFAULT_CONTEXT };

  } catch (error) {
    console.error('[ContextManager] Erro ao carregar:', error.message);
    contextStats.errors++;
    return { ...DEFAULT_CONTEXT };
  }
}

/**
 * Salva contexto no banco de dados
 */
export async function saveContext(leadId, context) {
  try {
    const id = leadId?.toString?.() || leadId;

    if (!id || id === 'unknown') {
      console.warn('[ContextManager] Não pode salvar sem leadId');
      return;
    }

    // Mapear de volta para Lead.autoBookingContext
    const autoBookingUpdate = {
      active: true,
      therapyArea: context.therapy,
      mappedTherapyArea: context.therapy,
      complaint: context.complaint,
      preferredPeriod: context.period?.replace('a', 'ã'), // 'manha' → 'manhã'
      patientInfo: {
        fullName: context.patientName,
        age: context.age
      },
      schedulingRequested: context.schedulingRequested,
      schedulingRequestedAt: context.schedulingRequestedAt,
      pendingSchedulingSlots: context.pendingSchedulingSlots,
      lastSlotsShownAt: context.lastSlotsShownAt,
      waitlistRequested: context.waitlistRequested,
      waitlistPreferences: context.waitlistPreferences,
      messageCount: context.messageCount,
      lastMessage: context.lastMessage,
      lastAction: context.lastAction,
      currentStep: context.currentStep,
      lastUpdatedAt: new Date()
    };

    await Leads.findByIdAndUpdate(
      id,
      {
        $set: {
          autoBookingContext: autoBookingUpdate
        }
      },
      { upsert: false } // Não cria Lead se não existir
    );

    console.log('[ContextManager] Contexto salvo em Lead:', {
      leadId: id,
      patientName: context.patientName ? '***' : null,  // Privacy
      age: context.age,
      therapy: context.therapy
    });

  } catch (error) {
    console.error('[ContextManager] Erro ao salvar:', error.message);
    contextStats.errors++;
  }
}

// =============================================================================
// 🔄 MERGE INTELIGENTE
// =============================================================================

/**
 * Faz merge inteligente de entidades extraídas com contexto existente
 * PRESERVA valores válidos existentes e só substitui quando apropriado
 */
export function mergeContext(existing, extracted) {
  contextStats.totalMerges++;
  
  const merged = { ...existing };
  const changes = [];
  
  // Incrementa contador
  merged.messageCount = (existing.messageCount || 0) + 1;
  merged.lastMessage = extracted.lastMessage || existing.lastMessage;
  merged.lastExtracted = Object.keys(extracted).filter(k => 
    !['lastMessage', 'rawText', '_ageExtractedFrom', '_nameExtractionMethod', 'flags'].includes(k) && 
    extracted[k] !== null && 
    extracted[k] !== undefined
  );
  
  // Merge de flags
  if (extracted.flags || existing.flags) {
    const oldFlags = { ...existing.flags };
    merged.flags = { ...existing.flags, ...(extracted.flags || {}) };
    
    // Detecta novas flags
    const newFlags = Object.keys(merged.flags).filter(k => !oldFlags[k]);
    if (newFlags.length > 0) {
      changes.push({ field: 'flags', added: newFlags });
    }
  }
  
  // ═══════════════════════════════════════════════════════════
  // MERGE DE CADA CAMPO
  // ═══════════════════════════════════════════════════════════
  
  // THERAPY
  if (shouldAcceptNewEntity('therapy', extracted.therapy, existing.therapy, extracted)) {
    if (existing.therapy !== extracted.therapy) {
      changes.push({ 
        field: 'therapy', 
        old: existing.therapy, 
        new: extracted.therapy,
        action: 'updated'
      });
      merged.therapy = extracted.therapy;
      addFilledSlot(merged, 'therapy');
    }
  }
  
  // COMPLAINT
  if (extracted.complaint && extracted.complaint !== existing.complaint) {
    changes.push({ 
      field: 'complaint', 
      old: existing.complaint ? '***' : null,  // Privacy
      new: '***',
      action: 'updated'
    });
    merged.complaint = extracted.complaint;
    addFilledSlot(merged, 'complaint');
  }
  
  // AGE (sempre atualiza se válida)
  if (isValidAge(extracted.age)) {
    if (existing.age !== extracted.age) {
      changes.push({ 
        field: 'age', 
        old: existing.age, 
        new: extracted.age,
        action: existing.age ? 'corrected' : 'added'
      });
      merged.age = extracted.age;
      merged.idadeRange = getIdadeRange(extracted.age);
      addFilledSlot(merged, 'age');
    }
  }
  
  // PERIOD
  if (isValidPeriod(extracted.period)) {
    if (existing.period !== extracted.period) {
      changes.push({ 
        field: 'period', 
        old: existing.period, 
        new: extracted.period,
        action: existing.period ? 'changed' : 'added'
      });
      merged.period = extracted.period;
      addFilledSlot(merged, 'period');
    }
  }
  
  // PATIENT NAME (lógica crítica)
  if (extracted.patientName) {
    const cleanedNewName = cleanName(extracted.patientName);
    
    if (cleanedNewName) {
      // Prepara contexto completo para validação
      const validationContext = {
        ...existing,
        rawText: extracted.rawText,
        hasAgeInMessage: extracted.age !== undefined
      };
      const shouldAccept = shouldAcceptNewEntity('patientName', cleanedNewName, existing.patientName, extracted, validationContext);
      
      if (shouldAccept) {
        if (existing.patientName && existing.patientName !== cleanedNewName) {
          // Atualização
          changes.push({ 
            field: 'patientName', 
            old: '***',  // Privacy
            new: '***',
            action: 'updated',
            reason: 'new_name_better'
          });
          contextStats.namesUpdated++;
        } else if (!existing.patientName) {
          // Novo nome
          changes.push({ 
            field: 'patientName', 
            old: null, 
            new: '***',
            action: 'added'
          });
        }
        
        merged.patientName = cleanedNewName;
        addFilledSlot(merged, 'patientName');
      } else {
        // Rejeitado
        changes.push({ 
          field: 'patientName', 
          attempted: '***',
          existing: existing.patientName ? '***' : null,
          action: 'rejected',
          reason: extracted.age !== undefined ? 'message_contains_age' : 'validation_failed'
        });
        contextStats.namesRejected++;
        
        if (existing.patientName) {
          contextStats.namesPreserved++;
        }
        
        console.log(`[ContextManager] Nome rejeitado: "${cleanedNewName}" (mantendo: "${existing.patientName}")`);
      }
    }
  }
  
  // TIPO PACIENTE
  if (extracted.tipo_paciente && extracted.tipo_paciente !== existing.tipo_paciente) {
    merged.tipo_paciente = extracted.tipo_paciente;
  }
  
  // INTENCAO
  if (extracted.intencao) {
    merged.intencao = extracted.intencao;
    merged.lastIntencao = extracted.intencao;
  }
  
  // FLAGS BOOLEANAS
  if (extracted.isConfirmation !== undefined) {
    merged.isConfirmation = extracted.isConfirmation;
  }
  if (extracted.isNegation !== undefined) {
    merged.isNegation = extracted.isNegation;
  }
  
  // Timestamp
  merged.lastUpdatedAt = new Date();
  
  // Adiciona ao histórico (limitado)
  if (changes.length > 0) {
    merged.changeHistory = [
      ...(existing.changeHistory || []),
      {
        timestamp: new Date().toISOString(),
        messageCount: merged.messageCount,
        changes
      }
    ].slice(-10); // Mantém só últimas 10
  }
  
  // Log resumido
  console.log('[ContextManager] Merge completo:', {
    patientName: merged.patientName ? '***' : null,
    age: merged.age,
    therapy: merged.therapy,
    changes: changes.length
  });
  
  return merged;
}

// =============================================================================
// 🛠️ HELPERS
// =============================================================================

function addFilledSlot(context, slot) {
  if (!context.filledSlots) {
    context.filledSlots = [];
  }
  if (!context.filledSlots.includes(slot)) {
    context.filledSlots.push(slot);
  }
}

function getIdadeRange(age) {
  if (age < 1) return 'bebe';
  if (age < 3) return 'bebe_1a3';
  if (age < 6) return 'crianca_3a6';
  if (age < 12) return 'crianca';
  if (age < 18) return 'adolescente';
  return 'adulto';
}

export function getMissingSlots(context) {
  const required = [
    { field: 'therapy', question: 'specialty', priority: 1 },
    { field: 'complaint', question: 'complaint', priority: 2 },
    { field: 'patientName', question: 'name', priority: 3 },
    { field: 'age', question: 'age', priority: 4 },
    { field: 'period', question: 'period', priority: 5 }
  ];
  
  return required
    .filter(r => !context[r.field])
    .sort((a, b) => a.priority - b.priority);
}

export function hasCompleteInfo(context) {
  const criticalFields = ['therapy', 'patientName', 'age'];
  return criticalFields.every(f => context[f]);
}

export async function resetContext(leadId) {
  try {
    const id = leadId?.toString?.() || leadId;

    await Leads.findByIdAndUpdate(
      id,
      {
        $set: {
          'autoBookingContext.active': false,
          'autoBookingContext.therapyArea': null,
          'autoBookingContext.complaint': null,
          'autoBookingContext.patientInfo': null,
          'autoBookingContext.preferredPeriod': null,
          'autoBookingContext.schedulingRequested': false,
          'autoBookingContext.schedulingRequestedAt': null,
          'autoBookingContext.pendingSchedulingSlots': null,
          'autoBookingContext.waitlistRequested': false,
          'autoBookingContext.waitlistPreferences': null,
          'autoBookingContext.messageCount': 0,
          'autoBookingContext.lastMessage': null,
          'autoBookingContext.lastAction': null,
          'autoBookingContext.currentStep': null
        }
      }
    );

    console.log('[ContextManager] Contexto resetado em Lead:', id);

  } catch (error) {
    console.error('[ContextManager] Erro ao resetar:', error.message);
    contextStats.errors++;
  }
}

export default {
  loadContext,
  saveContext,
  mergeContext,
  getMissingSlots,
  hasCompleteInfo,
  resetContext,
  DEFAULT_CONTEXT,
  getContextStats,
  resetContextStats
};
