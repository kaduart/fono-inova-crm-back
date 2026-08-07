// services/communication/delivery/ExternalDeliveryProvider.js
//
// Provider para comunicações entregues fora da aplicação (portal do convênio,
// Outlook, Gmail, WhatsApp de secretária, etc.).
//
// Diferente do EmailDeliveryProvider, este provider:
//   - não enfileira job na fila BullMQ;
//   - não chama o provedor Resend;
//   - não exige destinatário nem anexos obrigatórios;
//   - registra imediatamente a comunicação como entregue;
//   - grava auditoria de quem confirmou o envio externo.

import CommunicationEmailLog, { EmailLogStatus, EmailLogType } from '../../../models/CommunicationEmailLog.js';
import CommunicationPackage, { PackageStatus } from '../../../models/CommunicationPackage.js';
import { SUBJECT_BY_PURPOSE } from './_deliveryUtils.js';

// NOTA: este provider NÃO atualiza o status do CommunicationPackage.
// A marcação como sent/resent fica com o orquestrador (CommunicationService),
// mantendo a separação de responsabilidades entre provider e orquestrador.

export class ExternalDeliveryProvider {
  constructor() {
    this.name = 'external';
    this.isAsync = false;
  }

  /**
   * Executa a entrega externa de forma síncrona.
   *
   * @param {Object} context
   * @param {Object} context.communication - InsuranceCommunication
   * @param {Object} [context.package] - CommunicationPackage (opcional)
   * @param {string} [context.to] - Destinatário informado manualmente (opcional)
   * @param {string} [context.subject] - Assunto informado manualmente (opcional)
   * @param {string} [context.message] - Observação/justificativa do envio externo
   * @param {string} [context.reason] - Motivo do envio externo
   * @param {string} [context.userId] - Usuário que confirmou o envio
   * @param {string} [context.ip] - IP da requisição
   *
   * @returns {Promise<{success: true, async: false, log: Object}>}
   */
  async deliver(context) {
    const { communication, package: pkg, to, subject, message, reason, userId, ip } = context;

    // Garante um package vinculado para auditoria, mesmo sem anexos.
    const packageDoc = pkg || (await this._ensurePackage(communication, userId));

    const resolvedSubject = subject || communication.invoiceNumber
      ? `Documentação para Faturamento - NF ${communication.invoiceNumber}`
      : SUBJECT_BY_PURPOSE[communication.purpose] || SUBJECT_BY_PURPOSE.authorization;

    const log = await CommunicationEmailLog.create({
      communicationId: communication._id,
      communicationPackageId: packageDoc._id,
      to: to || 'external',
      subject: resolvedSubject,
      message: message || null,
      attachments: [],
      attempt: 1,
      type: EmailLogType.EXTERNAL,
      channel: 'external',
      reason: reason || 'Documentação enviada externamente à aplicação',
      ip: ip || undefined,
      sentBy: userId,
      sentAt: new Date(),
      lastAttemptAt: new Date(),
      status: EmailLogStatus.SUCCESS,
      provider: 'external',
      durationMs: 0
    });

    // NÃO atualiza o CommunicationPackage aqui. O orquestrador chama
    // finalizeDeliverySuccess, que marca o package como sent/resent conforme
    // o estado anterior, mantendo consistência com o canal email.

    return {
      success: true,
      async: false,
      log
    };
  }

  async _ensurePackage(communication, userId) {
    const existing = await CommunicationPackage.findOne({ communicationId: communication._id });
    if (existing) return existing;

    return CommunicationPackage.create({
      communicationId: communication._id,
      attachments: [],
      status: PackageStatus.DRAFT,
      createdBy: userId || communication.createdBy
    });
  }
}
