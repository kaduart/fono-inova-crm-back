// domain/insurance/createInsuranceBatch.js
// Migration 2: Cria lote de faturamento convênio

import InsuranceBatch from '../../models/InsuranceBatch.js';
import Appointment from '../../models/Appointment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import { publishEvent, EventTypes } from '../../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../../utils/logger.js';

/**
 * Cria um novo lote de faturamento convênio
 */
export async function createInsuranceBatch(data) {
  const {
    insuranceProvider,
    startDate,
    endDate,
    createdBy = null,
    correlationId = null
  } = data;

  const log = createContextLogger(correlationId, 'insurance_batch');

  log.info('create_start', 'Criando lote convênio', {
    insuranceProvider,
    startDate,
    endDate
  });

  try {
    // Validações
    if (!insuranceProvider) {
      throw new Error('INSURANCE_PROVIDER_REQUIRED');
    }

    // Gera número do lote
    const batchNumber = await generateBatchNumber(insuranceProvider);

    // Cria o lote vazio
    const batch = new InsuranceBatch({
      batchNumber,
      insuranceProvider,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      status: 'building',
      correlationId
    });

    await batch.save();

    log.info('create_success', 'Lote criado', {
      batchId: batch._id,
      batchNumber
    });

    return {
      success: true,
      batch,
      batchNumber
    };

  } catch (error) {
    log.error('create_error', 'Erro ao criar lote', {
      error: error.message
    });
    throw error;
  }
}

/**
 * Adiciona sessões ao lote
 */
export async function addSessionsToBatch(batchId, sessionData) {
  const { sessions = [] } = sessionData;

  const log = createContextLogger(null, 'insurance_batch');

  log.info('add_sessions_start', 'Adicionando sessões ao lote', {
    batchId,
    sessionsCount: sessions.length
  });

  try {
    const batch = await InsuranceBatch.findById(batchId);
    if (!batch) {
      throw new Error('BATCH_NOT_FOUND');
    }

    if (batch.status !== 'building') {
      throw new Error('BATCH_NOT_BUILDING');
    }

    // Busca dados completos das sessões
    const appointments = await Appointment.find({
      _id: { $in: sessions.map(s => s.appointmentId) }
    }).populate('session package insuranceGuide');

    const appointmentMap = new Map(appointments.map(a => [a._id.toString(), a]));

    // Monta itens do lote
    const newSessions = [];
    let totalGross = 0;

    for (const session of sessions) {
      const apt = appointmentMap.get(session.appointmentId);
      if (!apt) continue;

      const grossAmount = session.grossAmount || 
                         apt.insuranceGrossAmount || 
                         apt.sessionValue || 0;

      newSessions.push({
        session: apt.session?._id,
        appointment: apt._id,
        guide: apt.insuranceGuide?._id,
        grossAmount,
        status: 'pending'
      });

      totalGross += grossAmount;
    }

    // Adiciona ao lote
    batch.sessions.push(...newSessions);
    batch.totalGross += totalGross;
    batch.totalSessions = batch.sessions.length;
    batch.totalNet = batch.totalGross; // Inicialmente = bruto

    await batch.save();

    log.info('add_sessions_success', 'Sessões adicionadas', {
      added: newSessions.length,
      totalGross: batch.totalGross
    });

    return {
      success: true,
      batch,
      added: newSessions.length
    };

  } catch (error) {
    log.error('add_sessions_error', 'Erro ao adicionar sessões', {
      error: error.message
    });
    throw error;
  }
}

/**
 * Envia lote para o convênio
 */
export async function sendBatchToInsurance(batchId, data = {}) {
  const { xmlContent, sentBy = null } = data;

  const log = createContextLogger(null, 'insurance_batch');

  log.info('send_start', 'Enviando lote para convênio', { batchId });

  try {
    const batch = await InsuranceBatch.findById(batchId);
    if (!batch) {
      throw new Error('BATCH_NOT_FOUND');
    }

    if (batch.status !== 'building' && batch.status !== 'ready') {
      throw new Error('BATCH_CANNOT_BE_SENT');
    }

    // Atualiza status
    batch.status = 'sent';
    batch.sentDate = new Date();
    batch.xmlFile = xmlContent;

    // Atualiza todas as sessões
    for (const session of batch.sessions) {
      session.status = 'sent';
      session.sentAt = new Date();
    }

    await batch.save();

    // Publica evento
    await publishEvent(
      EventTypes.INSURANCE_BATCH_SENT,
      {
        batchId: batch._id.toString(),
        batchNumber: batch.batchNumber,
        insuranceProvider: batch.insuranceProvider,
        totalSessions: batch.totalSessions,
        totalGross: batch.totalGross
      }
    );

    log.info('send_success', 'Lote enviado', {
      batchNumber: batch.batchNumber
    });

    return {
      success: true,
      batch
    };

  } catch (error) {
    log.error('send_error', 'Erro ao enviar lote', {
      error: error.message
    });
    throw error;
  }
}

/**
 * Processa retorno do convênio
 */
export async function processInsuranceReturn(batchId, returnData) {
  const { 
    returnFile,
    sessionResults = [],
    processedBy = null 
  } = returnData;

  const log = createContextLogger(null, 'insurance_batch');

  log.info('process_return_start', 'Processando retorno do convênio', { batchId });

  try {
    const batch = await InsuranceBatch.findById(batchId);
    if (!batch) {
      throw new Error('BATCH_NOT_FOUND');
    }

    let totalReceived = 0;
    let totalGlosa = 0;

    // Processa cada sessão
    for (const result of sessionResults) {
      const session = batch.sessions.find(
        s => s.appointment.toString() === result.appointmentId
      );

      if (!session) continue;

      session.status = result.status;
      session.returnAmount = result.paidAmount || 0;
      session.glosaAmount = result.glosaAmount || 0;
      session.glosaReason = result.glosaReason;
      session.protocolNumber = result.protocolNumber;
      session.processedAt = new Date();

      totalReceived += session.returnAmount;
      totalGlosa += session.glosaAmount;
    }

    // Atualiza totais
    batch.receivedAmount = totalReceived;
    batch.totalGlosa = totalGlosa;
    batch.returnFile = returnFile;
    batch.status = 'received';
    batch.processedAt = new Date();
    batch.processedBy = processedBy;

    await batch.save();

    // Publica evento
    await publishEvent(
      EventTypes.INSURANCE_BATCH_RECEIVED,
      {
        batchId: batch._id.toString(),
        batchNumber: batch.batchNumber,
        totalSessions: batch.sessions.length,
        totalReceived,
        totalGlosa
      }
    );

    log.info('process_return_success', 'Retorno processado', {
      totalReceived,
      totalGlosa
    });

    return {
      success: true,
      batch,
      totalReceived,
      totalGlosa
    };

  } catch (error) {
    log.error('process_return_error', 'Erro ao processar retorno', {
      error: error.message
    });
    throw error;
  }
}

// Helper: gera número do lote
async function generateBatchNumber(insuranceProvider) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  
  // Conta lotes do mês
  const count = await InsuranceBatch.countDocuments({
    insuranceProvider,
    createdAt: {
      $gte: new Date(year, now.getMonth(), 1),
      $lt: new Date(year, now.getMonth() + 1, 1)
    }
  });

  const prefix = insuranceProvider.substring(0, 3).toUpperCase();
  const seq = String(count + 1).padStart(4, '0');
  
  return `${prefix}-${year}${month}-${seq}`;
}
