// services/communication/CommunicationService.js
//
// Orquestrador central do módulo de comunicação com convênios.
//
// Responsabilidades:
//   - Carregar a comunicação e o package.
//   - Escolher o canal de entrega (DeliveryProvider) a partir do deliveryMethod.
//   - Coordenar transições de estado da InsuranceCommunication.
//   - Registrar auditoria (CommunicationEmailLog) e atualizar CommunicationPackage.
//
// O "como" entregar fica exclusivamente nos providers em delivery/*. O orquestrador
// só sabe se o provider é síncrono ou assíncrono e reage ao resultado.

import InsuranceCommunication, { CommunicationStatus } from '../../models/InsuranceCommunication.js';
import CommunicationPackage, { PackageStatus } from '../../models/CommunicationPackage.js';
import { transition, CommunicationEvents } from './CommunicationStateMachine.js';
import {
  markPackageAsSent,
  markPackageAsResent,
  markPackageAsFailed
} from './CommunicationPackageService.js';
import { resolveProvider, getDefaultDeliveryMethod, isDeliveryMethodSupported } from './delivery/DeliveryProviderFactory.js';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('communication_service');

/**
 * Carrega comunicação e package vinculado.
 */
async function loadCommunicationContext(communicationId) {
  const [communication, pkg] = await Promise.all([
    InsuranceCommunication.findById(communicationId).lean(),
    CommunicationPackage.findOne({ communicationId }).lean()
  ]);

  if (!communication) {
    throw new Error('Comunicação não encontrada');
  }

  return { communication, package: pkg };
}

/**
 * Determina o deliveryMethod efetivo: usa o payload, senão o persistido na
 * comunicação, senão o padrão.
 */
function resolveDeliveryMethod(communication, payload = {}) {
  return payload.deliveryMethod || communication.deliveryMethod || getDefaultDeliveryMethod();
}

/**
 * Validações comuns independentes do canal.
 * Canais específicos podem ter validações extras nos próprios providers.
 *
 * Regras:
 *   - denied: não pode ser reenviada.
 *   - sent/approved: permite reenvio (registra novo log, não muda estado final).
 */
function validateSendContext({ communication }) {
  if (communication.status === 'denied') {
    throw new Error(`Comunicação já finalizada (${communication.status})`);
  }
}

/**
 * Indica se a comunicação já atingiu um estado final de entrega,
 * ou seja, reenvios devem apenas criar novos logs, não transicionar estado.
 */
function isAlreadyDelivered(status) {
  return ['sent', 'approved'].includes(status);
}

/**
 * Envia/entrega uma comunicação.
 *
 * @param {string} communicationId
 * @param {Object} payload
 * @param {string} [payload.deliveryMethod] - 'email' | 'external' | 'portal'
 * @param {string} [payload.to] - destinatário
 * @param {string} [payload.subject] - assunto
 * @param {string} [payload.message] - corpo/mensagem
 * @param {string} [payload.template] - template
 * @param {string} [payload.sendType] - tipo de envio (email)
 * @param {string} [payload.reason] - motivo (especialmente external)
 * @param {string} [payload.userId] - usuário
 * @param {string} [payload.ip] - IP da requisição
 *
 * @returns {Promise<{status: 'queued'|'sent'|'failed', jobId?: string, log?: Object, error?: string}>}
 */
export async function sendCommunication(communicationId, payload = {}) {
  let { communication, package: pkg } = await loadCommunicationContext(communicationId);
  validateSendContext({ communication });

  const deliveryMethod = resolveDeliveryMethod(communication, payload);

  if (!isDeliveryMethodSupported(deliveryMethod)) {
    throw new Error(`DELIVERY_METHOD_NOT_SUPPORTED: ${deliveryMethod}`);
  }

  // Persiste o deliveryMethod na comunicação quando veio explícito no payload.
  if (payload.deliveryMethod && payload.deliveryMethod !== communication.deliveryMethod) {
    await InsuranceCommunication.findByIdAndUpdate(
      communicationId,
      { $set: { deliveryMethod: payload.deliveryMethod } },
      { runValidators: true }
    );
    communication = await InsuranceCommunication.findById(communicationId).lean();
  }

  const provider = resolveProvider(deliveryMethod);
  const isResend = isAlreadyDelivered(communication.status);
  const context = {
    communicationId,
    communication,
    package: pkg,
    to: payload.to,
    subject: payload.subject,
    message: payload.message,
    template: payload.template,
    userId: payload.userId,
    sendType: payload.sendType,
    reason: payload.reason,
    ip: payload.ip
  };

  // Transiciona para SENDING apenas se a entrega for assíncrona (ex.: e-mail)
  // e a comunicação ainda não estiver em estado final.
  // Canais síncronos pulam esse estado e vão direto para SENT.
  if (!isResend) {
    if (provider.isAsync) {
      if (communication.status === CommunicationStatus.DRAFT) {
        await transition(communicationId, CommunicationEvents.MARK_READY);
      }
      await transition(communicationId, CommunicationEvents.SEND);
    } else {
      if (communication.status === CommunicationStatus.DRAFT) {
        await transition(communicationId, CommunicationEvents.MARK_READY);
      }
    }
  }

  const result = await provider.deliver(context);

  if (result.error) {
    // Se o provider for síncrono e falhou, tenta transicionar para FAILED,
    // mas apenas se a comunicação não estiver em estado final.
    if (!provider.isAsync && !isResend) {
      try {
        await transition(communicationId, CommunicationEvents.FAIL);
      } catch (failErr) {
        logger.warn('state_machine_fail_ignored', 'Falha ao transicionar após erro do provider', {
          communicationId,
          error: failErr.message
        });
      }
    }
    throw result.error;
  }

  // Provider assíncnico: o job processará e o worker chamará handleDeliveryResult.
  if (result.async) {
    return {
      status: 'queued',
      jobId: result.jobId
    };
  }

  // Provider síncrono: finaliza o ciclo imediatamente.
  await finalizeDeliverySuccess(communicationId, result.log, { isResend });

  return {
    status: 'sent',
    log: result.log
  };
}

/**
 * Finaliza uma entrega bem-sucedida: atualiza package e transiciona comunicação.
 * Chamado tanto para providers síncronos quanto pelo worker após job assíncrono.
 *
 * @param {string} communicationId
 * @param {Object} log - CommunicationEmailLog
 * @param {Object} options
 * @param {boolean} options.isFirstSend
 */
export async function finalizeDeliverySuccess(communicationId, log, options = {}) {
  const { isResend = false } = options;

  const communication = await InsuranceCommunication.findById(communicationId).select('status').lean();
  if (!communication) return;

  const pkg = await CommunicationPackage.findOne({ communicationId }).lean();

  // Marca package como sent/resent conforme o estado anterior.
  if (pkg) {
    if (pkg.status === PackageStatus.DRAFT || pkg.status === PackageStatus.FAILED) {
      await markPackageAsSent(communicationId);
    } else {
      await markPackageAsResent(communicationId);
    }
  }

  // Transiciona comunicação para sent apenas no primeiro envio.
  if (!isResend && !isAlreadyDelivered(communication.status)) {
    try {
      await transition(communicationId, CommunicationEvents.MARK_SENT);
    } catch (err) {
      logger.warn('mark_sent_transition_ignored', 'Estado não permitia MARK_SENT', {
        communicationId,
        currentStatus: communication.status,
        error: err.message
      });
    }
  }
}

/**
 * Finaliza uma entrega com falha (apenas providers assíncnicos).
 * Chamado pelo worker quando o job de e-mail falha.
 *
 * @param {string} communicationId
 * @param {Error} error
 */
export async function finalizeDeliveryFailure(communicationId, error) {
  const communication = await InsuranceCommunication.findById(communicationId).select('status').lean();
  if (!communication) return;

  try {
    await markPackageAsFailed(communicationId);
    if (communication.status === CommunicationStatus.SENDING) {
      await transition(communicationId, CommunicationEvents.FAIL);
    }
  } catch (err) {
    logger.warn('finalize_failure_ignored', 'Falha ao finalizar entrega com erro', {
      communicationId,
      error: err.message
    });
  }
}

/**
 * Processa o resultado de um provider assíncnico.
 * Usado pelo worker após executar EmailDeliveryProvider.executeDelivery.
 *
 * @param {string} communicationId
 * @param {Object} result - { success: boolean, log?: Object, error?: Error }
 */
export async function handleDeliveryResult(communicationId, result) {
  if (result.success) {
    await finalizeDeliverySuccess(communicationId, result.log, { isResend: false });
  } else {
    await finalizeDeliveryFailure(communicationId, result.error);
  }
}
