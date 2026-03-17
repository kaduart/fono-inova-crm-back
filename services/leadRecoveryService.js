// services/leadRecoveryService.js
// Recuperação automática de leads que não agendaram (Lead Recovery)
// Fase 1: 2 estágios (6h + 24h) - otimizado para conversão sem spam

import Leads from '../models/Leads.js';
import Message from '../models/Message.js';
import { sendTextMessage, sendTemplateMessage } from './whatsappService.js';
import { detectSpecialtyFromMessage } from '../utils/campaignDetector.js';

// Templates de mensagens por especialidade
const RECOVERY_MESSAGES = {
  psicologia: {
    stage1: 'Oi! Vi que você perguntou sobre avaliação de psicologia 😊\n\nAinda quer que eu veja horários para você?',
    stage2: 'Oi! Consegui verificar alguns horários para avaliação de psicologia.\n\nQuer que eu te mostre as opções disponíveis? 😊'
  },
  fono: {
    stage1: 'Oi! Vi que você perguntou sobre avaliação de fonoaudiologia 😊\n\nQuer que eu veja horários disponíveis?',
    stage2: 'Oi! Consegui verificar alguns horários para avaliação de fonoaudiologia.\n\nQuer que eu te mostre as opções? 😊'
  },
  fisio: {
    stage1: 'Oi! Vi que você perguntou sobre avaliação de fisioterapia 😊\n\nAinda quer que eu veja opções de horário?',
    stage2: 'Oi! Consegui verificar alguns horários para avaliação de fisioterapia.\n\nQuer que eu te mostre as opções disponíveis? 😊'
  },
  neuropsicologia: {
    stage1: 'Oi! Vi que você perguntou sobre avaliação neuropsicológica 😊\n\nAinda quer que eu veja horários para você?',
    stage2: 'Oi! Consegui verificar alguns horários para avaliação neuropsicológica.\n\nQuer que eu te mostre as opções? 😊'
  },
  psicopedagogia: {
    stage1: 'Oi! Vi que você perguntou sobre avaliação psicopedagógica 😊\n\nAinda quer que eu veja horários?',
    stage2: 'Oi! Consegui verificar alguns horários para avaliação psicopedagógica.\n\nQuer que eu te mostre as opções? 😊'
  },
  geral: {
    stage1: 'Oi! Vi que você perguntou sobre avaliação 😊\n\nAinda quer que eu veja horários para você?',
    stage2: 'Oi! Consegui verificar alguns horários para avaliação.\n\nQuer que eu te mostre as opções disponíveis? 😊'
  }
};

/**
 * Inicia o processo de recovery para um lead recém-criado
 * Chamado quando um lead entra no sistema
 */
export async function startRecoveryForLead(leadId) {
  try {
    const nextAttemptAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // +6 horas

    await Leads.findByIdAndUpdate(leadId, {
      $set: {
        'recovery.stage': 0,
        'recovery.nextAttemptAt': nextAttemptAt,
        'recovery.startedAt': new Date(),
        'recovery.cancelledAt': null,
        'recovery.finishedAt': null,
        'recovery.lastAttemptAt': null
      }
    });

    console.log(`🔁 Lead Recovery iniciado para ${leadId}, próximo envio: ${nextAttemptAt.toISOString()}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Erro ao iniciar recovery:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Processa a fila de leads para recovery
 * Chamado pelo cron a cada 30 minutos
 * Limite: 20 leads por execução
 */
export async function processRecoveryQueue() {
  const now = new Date();
  const THREE_HOURS_AGO = new Date(now.getTime() - 3 * 60 * 60 * 1000);

  try {
    // Query otimizada com todos os filtros de segurança
    const leads = await Leads.find({
      // Recovery habilitado
      recoveryEnabled: true,

      // Não convertido em paciente
      convertedToPatient: null,

      // Status não é agendado
      status: { $ne: 'agendado' },

      // Recovery não cancelado nem finalizado
      'recovery.cancelledAt': null,
      'recovery.finishedAt': null,

      // Hora do próximo envio chegou
      'recovery.nextAttemptAt': { $lte: now },

      // Sem interação nos últimos 3h (evita spam em conversa ativa)
      lastInteractionAt: { $lte: THREE_HOURS_AGO },

      // Amanda não está esperando resposta
      awaitingResponse: null,

      // Não está em controle manual (humano atendendo)
      'manualControl.active': { $ne: true }
    })
    .limit(20)
    .sort({ 'recovery.nextAttemptAt': 1 });

    if (leads.length === 0) {
      return { processed: 0, message: 'Nenhum lead para recovery' };
    }

    console.log(`🔁 Processando ${leads.length} leads para recovery...`);

    const results = [];
    for (const lead of leads) {
      const result = await sendRecoveryMessage(lead);
      results.push(result);
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`✅ Recovery concluído: ${successCount}/${leads.length} enviados`);

    return {
      processed: leads.length,
      successful: successCount,
      failed: leads.length - successCount,
      results
    };

  } catch (error) {
    console.error('❌ Erro no processRecoveryQueue:', error);
    return { processed: 0, error: error.message };
  }
}

/**
 * Verifica se lead está dentro da janela de 24h do WhatsApp
 */
async function isWithin24hWindow(leadId) {
  const lastInbound = await Message.findOne({
    lead: leadId,
    direction: 'inbound'
  }).sort({ timestamp: -1 }).lean();
  
  if (!lastInbound) return false;
  
  const hoursSince = (Date.now() - new Date(lastInbound.timestamp).getTime()) / (1000 * 60 * 60);
  return hoursSince < 24;
}

/**
 * Envia mensagem de recovery para um lead específico
 */
async function sendRecoveryMessage(lead) {
  try {
    const currentStage = lead.recovery?.stage || 0;
    const nextStage = currentStage + 1;

    // Determina a especialidade para personalização
    const specialty = lead.metaTracking?.specialty || detectSpecialtyFromMessage(lead.metaTracking?.firstMessage || '') || 'geral';

    // Seleciona template de mensagem
    const templates = RECOVERY_MESSAGES[specialty] || RECOVERY_MESSAGES.geral;
    const messageKey = nextStage === 1 ? 'stage1' : 'stage2';
    const message = templates[messageKey];

    if (!message) {
      return { success: false, error: 'Template não encontrado', leadId: lead._id };
    }

    // Envia mensagem via WhatsApp
    const phone = lead.contact?.phone;
    if (!phone) {
      return { success: false, error: 'Telefone não encontrado', leadId: lead._id };
    }

    // 🎯 VERIFICA JANELA DE 24h ANTES DE ENVIAR
    const in24hWindow = await isWithin24hWindow(lead._id);
    
    if (in24hWindow) {
      // Dentro da janela: envia texto normal
      console.log(`[RECOVERY] Lead ${lead._id} dentro da janela 24h - enviando texto`);
      await sendTextMessage({
        to: phone,
        text: message,
        lead: lead._id,
        sentBy: 'amanda'
      });
    } else {
      // Fora da janela: envia template de recontato primeiro
      console.log(`[RECOVERY] Lead ${lead._id} FORA da janela 24h - enviando template recontato`);
      await sendTemplateMessage({
        to: phone,
        template: 'recontato_clinica',
        params: [],
        lead: lead._id,
        sentBy: 'amanda_recovery'
      });
      
      // Se stage 2, envia também o texto como follow-up (após template abrir a janela)
      if (nextStage === 2) {
        console.log(`[RECOVERY] Stage 2 - enviando texto complementar após template`);
        // Pequeno delay para garantir que o template chegue primeiro
        await new Promise(r => setTimeout(r, 2000));
        await sendTextMessage({
          to: phone,
          text: message,
          lead: lead._id,
          sentBy: 'amanda'
        });
      }
    }

    // Atualiza estado do recovery
    const updateData = {
      'recovery.stage': nextStage,
      'recovery.lastAttemptAt': new Date()
    };

    if (nextStage === 1) {
      // Stage 1 enviado, agenda stage 2 para +18h (total 24h desde o início)
      updateData['recovery.nextAttemptAt'] = new Date(Date.now() + 18 * 60 * 60 * 1000);
    } else if (nextStage >= 2) {
      // Stage 2 enviado, finaliza recovery
      updateData['recovery.finishedAt'] = new Date();
      updateData['recovery.nextAttemptAt'] = null;
    }

    await Leads.findByIdAndUpdate(lead._id, { $set: updateData });

    console.log(`✅ Recovery Stage ${nextStage} enviado para ${lead.name || phone} (${specialty})`);

    return {
      success: true,
      leadId: lead._id,
      stage: nextStage,
      specialty,
      phone
    };

  } catch (error) {
    console.error(`❌ Erro ao enviar recovery para ${lead._id}:`, error);
    return { success: false, error: error.message, leadId: lead._id };
  }
}

/**
 * Cancela o recovery de um lead (quando ele responde)
 */
export async function cancelRecovery(leadId, reason = 'lead_respondeu') {
  try {
    const lead = await Leads.findById(leadId);

    if (!lead || !lead.recovery || lead.recovery.finishedAt || lead.recovery.cancelledAt) {
      return { success: false, message: 'Recovery não está ativo' };
    }

    await Leads.findByIdAndUpdate(leadId, {
      $set: {
        'recovery.cancelledAt': new Date(),
        'recovery.finishedAt': new Date(),
        'recovery.nextAttemptAt': null
      }
    });

    console.log(`🛑 Recovery cancelado para ${leadId}: ${reason}`);
    return { success: true, reason };

  } catch (error) {
    console.error('❌ Erro ao cancelar recovery:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Força o início do recovery para leads antigos (migração)
 * Útil para ativar recovery em leads existentes
 */
export async function enableRecoveryForExistingLeads(hoursSinceCreation = 24) {
  try {
    const cutoffDate = new Date(Date.now() - hoursSinceCreation * 60 * 60 * 1000);

    const result = await Leads.updateMany(
      {
        createdAt: { $gte: cutoffDate },
        convertedToPatient: null,
        status: { $ne: 'agendado' },
        $or: [
          { recovery: { $exists: false } },
          { 'recovery.stage': { $exists: false } }
        ]
      },
      {
        $set: {
          recoveryEnabled: true,
          'recovery.stage': 0,
          'recovery.nextAttemptAt': new Date(Date.now() + 6 * 60 * 60 * 1000),
          'recovery.startedAt': new Date()
        }
      }
    );

    console.log(`🔁 Recovery habilitado para ${result.modifiedCount} leads existentes`);
    return { success: true, modifiedCount: result.modifiedCount };

  } catch (error) {
    console.error('❌ Erro na migração:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Retorna estatísticas do recovery
 */
export async function getRecoveryStats(days = 7) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const stats = await Leads.aggregate([
      {
        $match: {
          'recovery.startedAt': { $gte: since }
        }
      },
      {
        $group: {
          _id: null,
          totalStarted: { $sum: 1 },
          stage1Sent: { $sum: { $cond: [{ $gte: ['$recovery.stage', 1] }, 1, 0] } },
          stage2Sent: { $sum: { $cond: [{ $gte: ['$recovery.stage', 2] }, 1, 0] } },
          cancelled: { $sum: { $cond: ['$recovery.cancelledAt', 1, 0] } },
          finished: { $sum: { $cond: ['$recovery.finishedAt', 1, 0] } },
          convertedAfterRecovery: {
            $sum: {
              $cond: [
                { $and: ['$recovery.stage', { $ne: ['$convertedToPatient', null] }] },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    return stats[0] || {
      totalStarted: 0,
      stage1Sent: 0,
      stage2Sent: 0,
      cancelled: 0,
      finished: 0,
      convertedAfterRecovery: 0
    };

  } catch (error) {
    console.error('❌ Erro nas estatísticas:', error);
    return { error: error.message };
  }
}

export default {
  startRecoveryForLead,
  processRecoveryQueue,
  cancelRecovery,
  enableRecoveryForExistingLeads,
  getRecoveryStats
};
