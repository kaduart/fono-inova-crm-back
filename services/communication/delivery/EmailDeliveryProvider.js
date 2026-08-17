// services/communication/delivery/EmailDeliveryProvider.js
//
// Provider de entrega por e-mail. Responsável exclusivamente por executar o envio
// real (via Resend) e retornar o resultado. NÃO transiciona status da comunicação
// nem marca o package como sent — isso fica com CommunicationService.
//
// O provider expõe duas operações:
//   - deliver(context):     chamado pelo orquestrador; enfileira o job BullMQ.
//   - executeDelivery(jobData): chamado pelo worker; chama Resend e grava log.

import { getQueue } from '../../../infrastructure/queue/queueConfig.js';
import InsuranceCommunication, { CommunicationStatus } from '../../../models/InsuranceCommunication.js';
import CommunicationEmailLog, { EmailLogStatus, EmailLogType } from '../../../models/CommunicationEmailLog.js';
import CommunicationPackage from '../../../models/CommunicationPackage.js';
import Convenio from '../../../models/Convenio.js';
import { sendEmailWithAttachments } from '../../emailService.js';
import { getEmailProviderName } from '../../email/EmailProviderFactory.js';
import { SUBJECT_BY_PURPOSE } from './_deliveryUtils.js';

const QUEUE_NAME = 'communication-email';

function buildDefaultHtml({ patientName, insuranceName, guideNumber, purpose, message }) {
  const defaultBody = purpose === 'billing'
    ? `Prezados,<br><br>Segue em anexo a documentação para faturamento do paciente ${patientName}.<br><br>Aguardamos retorno.<br><br>Atenciosamente,<br>Clínica Fono Inova`
    : purpose === 'appeal'
    ? `Prezados,<br><br>Segue em anexo a documentação para recurso do paciente ${patientName}.<br><br>Aguardamos retorno.<br><br>Atenciosamente,<br>Clínica Fono Inova`
    : purpose === 'documentation'
    ? `Prezados,<br><br>Segue em anexo a documentação solicitada do paciente ${patientName}.<br><br>Atenciosamente,<br>Clínica Fono Inova`
    : `Prezados,<br><br>Segue em anexo a documentação para solicitação de autorização de atendimento do paciente ${patientName}.<br><br>Aguardamos retorno com o número de autorização para prosseguimento.<br><br>Atenciosamente,<br>Clínica Fono Inova`;

  const rawBody = message || defaultBody;
  const body = message ? rawBody.replace(/\n/g, '<br>') : rawBody;

  return `
    <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #1f2937;">
      <div style="background: linear-gradient(135deg, #068c67 0%, #068c67 100%); padding: 22px 20px; text-align: center;">
        <span style="display: inline-block; background: #ffffff; border-radius: 10px; padding: 0px 72px;">
          <img src="${process.env.LOGO_URL || 'https://app.clinicafonoinova.com.br/images/Logo-Fono-Inova-horizontal.png'}" alt="Fono Inova" style="height: 108px; display: block;">
        </span>
      </div>
      <div style="padding: 32px 28px;">
        <h2 style="color: #2563eb; margin: 0 0 4px; font-size: 18px;">${insuranceName || 'Convênio'}</h2>
        ${guideNumber ? `<p style="margin: 0 0 16px; color: #4b5563;"><strong>Guia:</strong> ${guideNumber}</p>` : ''}
        <div style="margin-top: 16px; line-height: 1.6; font-size: 14px;">${body}</div>
      </div>
      <div style="padding: 18px 28px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af;">
        Clínica Fono Inova — este e-mail foi enviado automaticamente a partir do sistema de gestão da clínica.
      </div>
    </div>
  `;
}

export class EmailDeliveryProvider {
  constructor() {
    this.name = 'email';
    this.isAsync = true;
  }

  /**
   * Enfileira o job de envio de e-mail. Chamado pelo orquestrador.
   *
   * @param {Object} context
   * @param {Object} context.communication - InsuranceCommunication (fonte do id)
   * @param {string} [context.communicationId] - fallback quando o chamador só tem o id
   * @param {string} context.to
   * @param {string} context.subject
   * @param {string} [context.message]
   * @param {string} [context.template]
   * @param {string} [context.userId]
   * @param {string} [context.sendType]
   * @param {string} [context.ip]
   * @param {string} [context.reason]
   *
   * @returns {Promise<{success: true, async: true, jobId: string}>}
   */
  async deliver(context) {
    const {
      communication,
      to,
      subject,
      message,
      template,
      userId,
      sendType,
      ip,
      reason
    } = context;

    // O contrato do orquestrador (CommunicationService.sendCommunication) entrega a
    // comunicação inteira em `context.communication` — é assim que o ExternalDeliveryProvider
    // lê o id. Este provider lia `context.communicationId`, que nunca existiu, e por isso
    // enfileirava todo envio de e-mail com communicationId undefined: o worker fazia
    // findById(undefined), errava com "Comunicação não encontrada", retentava 5x e caía na
    // DLQ — sem nunca gravar log, o que deixava a falha invisível na aba "Envios"
    // (caso Ícaro 2026-08-10). `context.communicationId` fica aceito como fallback.
    const communicationId = communication?._id?.toString() || context.communicationId;

    if (!communicationId) {
      throw new Error('communicationId ausente no contexto de entrega — envio não enfileirado');
    }

    const queue = getQueue(QUEUE_NAME);
    const emailJobId = `communication-email-${communicationId}-${Date.now()}`;

    const job = await queue.add(
      'send-communication-email',
      {
        communicationId,
        to,
        subject,
        message,
        template,
        sendType: sendType || undefined,
        reason: reason || undefined,
        ip,
        userId,
        jobId: emailJobId,
        channel: 'email'
      },
      {
        jobId: emailJobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 }
      }
    );

    return {
      success: true,
      async: true,
      jobId: job.id
    };
  }

  /**
   * Executa o envio real de e-mail. Chamado pelo worker.
   * NÃO transiciona status da comunicação nem atualiza o package.
   * Apenas chama o provedor e retorna o log para o orquestrador.
   *
   * @param {Object} jobData
   *
   * @returns {Promise<{success: boolean, log: Object, error?: Error}>}
   */
  async executeDelivery(jobData) {
    const {
      communicationId,
      to,
      subject,
      message,
      template,
      userId,
      sendType,
      ip,
      reason,
      jobId
    } = jobData;

    // Guarda de idempotência: se este jobId já teve sucesso, não reenvia.
    // Se já existe um log de ERRO deste mesmo jobId, ele é REAPROVEITADO em vez de
    // gerar uma linha nova: o BullMQ retenta o mesmo job até 5x, e uma linha por
    // retry enchia a aba "Envios" com 5 cards idênticos de "Falha no envio" para
    // um único envio pedido pelo usuário.
    let logToReuse = null;
    if (jobId) {
      const existing = await CommunicationEmailLog.findOne({ jobId }).sort({ createdAt: -1 }).lean();
      if (existing?.status === EmailLogStatus.SUCCESS) {
        return { success: true, log: existing };
      }
      if (existing?.status === EmailLogStatus.PENDING) {
        return {
          success: false,
          error: new Error(`Job ${jobId} já iniciou um envio anterior cujo resultado é incerto. Bloqueado para evitar duplicidade.`)
        };
      }
      logToReuse = existing || null;
    }

    const communication = await InsuranceCommunication.findById(communicationId)
      .populate('patientId', 'fullName')
      .populate('guideId', 'number')
      .lean();

    if (!communication) {
      return { success: false, error: new Error('Comunicação não encontrada') };
    }

    const isFirstSend = communication.status === CommunicationStatus.READY;
    const purpose = communication.purpose || 'authorization';
    const convenio = await Convenio.findOne({ code: communication.insuranceProvider }).select('name communicationRules authorizationRules guidePolicy').lean();
    const rules = convenio?.getCommunicationRules?.(purpose) || convenio?.communicationRules?.[purpose] || convenio?.authorizationRules || {};
    const defaultTo = rules?.defaultEmail || convenio?.guidePolicy?.priorAuthEmail || convenio?.guidePolicy?.billingEmail || '';
    const destination = to || defaultTo;

    const pkg = await CommunicationPackage.findOne({ communicationId }).lean();
    // Precisamos do package para criar o log de auditoria; sem ele não há como
    // rastrear a tentativa. Em produção isso não deve acontecer porque o wizard
    // sempre cria o package antes de enfileirar o envio.
    if (!pkg) {
      return { success: false, error: new Error('Pacote de envio não encontrado') };
    }

    const resolvedSubject = subject || rules?.defaultSubject || SUBJECT_BY_PURPOSE[purpose] || SUBJECT_BY_PURPOSE.authorization;
    const resolvedType = sendType || (isFirstSend ? EmailLogType.FIRST_SEND : EmailLogType.RESEND);
    const patientName = communication.patientId?.fullName || 'Paciente';
    const insuranceName = convenio?.name || communication.insuranceProvider;
    const guideNumber = communication.guideId?.number;
    const attachmentsSnapshot = pkg.attachments.map(a => ({
      documentId: a.documentId,
      url: a.url,
      name: a.filename,
      hash: a.hash,
      mimeType: a.mimeType,
      size: a.size
    }));

    const pkgAfterSending = await this._markPackageAttempt(communicationId);
    const attempt = pkgAfterSending.attempt || 1;
    const lastAttemptAt = pkgAfterSending.lastAttemptAt || new Date();

    // Cria o log de auditoria o mais cedo possível. Assim, mesmo que alguma
    // validação ou o provedor de e-mail falhe, a aba "Envios" mostra a
    // tentativa com o erro correspondente (caso Ícaro 2026-08-10: envio
    // falhou mas o log não aparecia porque era criado tarde demais).
    let pendingLog = null;
    if (jobId) {
      const logFields = {
        communicationId,
        communicationPackageId: pkg._id,
        jobId,
        to: destination || defaultTo,
        subject: resolvedSubject,
        template: template || null,
        message: message || null,
        attachments: attachmentsSnapshot,
        attempt,
        type: resolvedType,
        channel: 'email',
        reason: reason || undefined,
        ip: ip || undefined,
        lastAttemptAt,
        provider: getEmailProviderName(),
        status: EmailLogStatus.PENDING,
        sentBy: userId
      };

      pendingLog = logToReuse
        ? await CommunicationEmailLog.findByIdAndUpdate(
            logToReuse._id,
            { $set: { ...logFields, errorMessage: null, sentAt: new Date() } },
            { new: true }
          )
        : await CommunicationEmailLog.create(logFields);
    }

    // Helper para registrar erro no log previamente criado e retornar.
    const fail = async (message) => {
      if (pendingLog) {
        await CommunicationEmailLog.findByIdAndUpdate(pendingLog._id, {
          $set: { status: EmailLogStatus.ERROR, errorMessage: message }
        });
      }
      return { success: false, log: pendingLog, error: new Error(message) };
    };

    if (!destination) {
      return await fail('Destinatário não informado e convênio não possui e-mail padrão');
    }

    // Documentos (obrigatórios ou não) são só um checklist informativo no front —
    // o usuário pode querer mandar só o corpo do e-mail, sem nenhum anexo, então o
    // envio não pode ser bloqueado aqui por pacote vazio ou por documento obrigatório
    // faltando (pedido 2026-08-17: botão de envio sempre ativo/aceita).
    const attachments = pkg.attachments.map(a => ({
      documentId: a.documentId?.toString(),
      url: a.url,
      name: a.filename
    })).filter(a => a.url);

    const html = buildDefaultHtml({ patientName, insuranceName, guideNumber, purpose, message });
    const text = message || `${SUBJECT_BY_PURPOSE[purpose] || 'Solicitação'} para ${patientName}.`;

    const lastSuccessLog = await CommunicationEmailLog.findOne({
      communicationId,
      status: EmailLogStatus.SUCCESS,
      messageId: { $regex: /^</ }
    }).sort({ sentAt: -1 }).lean();
    const inReplyTo = lastSuccessLog?.messageId || undefined;

    const emailIdempotencyKey = jobId || `communication-${communicationId}-${Date.now()}`;
    const startTime = Date.now();

    let result;
    let logStatus = EmailLogStatus.SUCCESS;
    let errorMessage = null;

    try {
      result = await sendEmailWithAttachments({
        to: destination,
        subject: resolvedSubject,
        html,
        text,
        attachments,
        customId: emailIdempotencyKey,
        idempotencyKey: emailIdempotencyKey,
        inReplyTo,
        fromEmail: process.env.BILLING_EMAIL_FROM || 'financeiro@clinicafonoinova.com.br',
        fromName: process.env.BILLING_EMAIL_FROM_NAME || 'Financeiro - Clínica Fono Inova',
        cc: 'clinicafonoinova@gmail.com'
      });
    } catch (error) {
      logStatus = EmailLogStatus.ERROR;
      errorMessage = error?.message || 'Erro ao enviar e-mail';
      result = { success: false };
    }

    const durationMs = Date.now() - startTime;

    let messageId = result?.resendMessageId || null;
    if (!messageId && pendingLog && result?.messageId) {
      const current = await CommunicationEmailLog.findById(pendingLog._id).select('messageId').lean();
      messageId = current?.messageId || result.messageId;
    } else if (!messageId && result?.messageId) {
      messageId = result.messageId;
    }

    const finalFields = {
      protocol: result?.messageId || result?.protocol || null,
      messageId,
      durationMs,
      status: logStatus,
      errorMessage
    };

    const emailLog = pendingLog
      ? await CommunicationEmailLog.findByIdAndUpdate(pendingLog._id, { $set: finalFields }, { new: true })
      : await CommunicationEmailLog.create({
          communicationId,
          communicationPackageId: pkg._id,
          jobId,
          to: destination,
          subject: resolvedSubject,
          template: template || null,
          message: message || null,
          attachments: attachmentsSnapshot,
          attempt,
          type: resolvedType,
          channel: 'email',
          reason: reason || undefined,
          ip: ip || undefined,
          lastAttemptAt,
          provider: getEmailProviderName(),
          sentBy: userId,
          ...finalFields
        });

    if (logStatus === EmailLogStatus.ERROR) {
      return { success: false, log: emailLog, error: new Error(errorMessage) };
    }

    return { success: true, log: emailLog };
  }

  async _markPackageAttempt(communicationId) {
    const now = new Date();
    return CommunicationPackage.findOneAndUpdate(
      { communicationId },
      {
        $set: { lastAttemptAt: now },
        $inc: { attempt: 1 }
      },
      { new: true, upsert: true }
    );
  }
}
