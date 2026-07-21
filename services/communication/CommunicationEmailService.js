// services/communication/CommunicationEmailService.js
import InsuranceCommunication, { CommunicationStatus } from '../../models/InsuranceCommunication.js';
import CommunicationEmailLog, { EmailLogStatus } from '../../models/CommunicationEmailLog.js';
import CommunicationPackage, { PackageStatus } from '../../models/CommunicationPackage.js';
import Convenio from '../../models/Convenio.js';
import { sendEmailWithAttachments } from '../emailService.js';
import { transition, CommunicationEvents } from './CommunicationStateMachine.js';
import {
  markPackageAsSending,
  markPackageAsSent,
  markPackageAsResent,
  markPackageAsFailed,
  validatePackageDocuments
} from './CommunicationPackageService.js';
import { getRequiredDocumentTypes } from './InsuranceRuleService.js';

const SUBJECT_BY_PURPOSE = {
  authorization: 'Solicitação de Autorização de Atendimento',
  billing: 'Solicitação de Faturamento',
  appeal: 'Solicitação de Recurso',
  documentation: 'Envio de Documentação'
};

function buildDefaultHtml({ patientName, insuranceName, guideNumber, purpose, message }) {
  const defaultBody = purpose === 'billing'
    ? `Prezados,<br><br>Segue em anexo a documentação para faturamento do paciente ${patientName}.<br><br>Aguardamos retorno.<br><br>Atenciosamente,<br>Clínica Fono Inova`
    : purpose === 'appeal'
    ? `Prezados,<br><br>Segue em anexo a documentação para recurso do paciente ${patientName}.<br><br>Aguardamos retorno.<br><br>Atenciosamente,<br>Clínica Fono Inova`
    : purpose === 'documentation'
    ? `Prezados,<br><br>Segue em anexo a documentação solicitada do paciente ${patientName}.<br><br>Atenciosamente,<br>Clínica Fono Inova`
    : `Prezados,<br><br>Segue em anexo a documentação para solicitação de autorização de atendimento do paciente ${patientName}.<br><br>Aguardamos retorno com o número de autorização para prosseguimento.<br><br>Atenciosamente,<br>Clínica Fono Inova`;

  const body = message || defaultBody;

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #f3f4f6; padding: 16px; text-align: center;">
        <img src="${process.env.LOGO_URL || 'https://app.clinicafonoinova.com.br/images/Logo-Fono-Inova-horizontal.png'}" alt="Fono Inova" style="height: 48px;">
      </div>
      <div style="padding: 24px;">
        <h2 style="color: #2563eb; margin: 0 0 8px;">${insuranceName || 'Convênio'}</h2>
        ${guideNumber ? `<p><strong>Guia:</strong> ${guideNumber}</p>` : ''}
        <div style="margin-top: 16px;">${body}</div>
      </div>
    </div>
  `;
}

/**
 * Processa o envio de e-mail de comunicação com convênio de forma síncrona (usado pelo worker).
 * Atualiza status via State Machine e registra log com snapshot dos anexos.
 */
export async function sendCommunicationEmail({
  communicationId,
  to,
  subject,
  message,
  template,
  userId
}) {
  const communication = await InsuranceCommunication.findById(communicationId)
    .populate('patientId', 'fullName')
    .populate('guideId', 'number')
    .lean();

  if (!communication) throw new Error('Comunicação não encontrada');

  const purpose = communication.purpose || 'authorization';
  const convenio = await Convenio.findOne({ code: communication.insuranceProvider }).select('name communicationRules authorizationRules guidePolicy').lean();

  const rules = convenio?.getCommunicationRules?.(purpose) || convenio?.communicationRules?.[purpose] || convenio?.authorizationRules || {};

  const defaultTo = rules?.defaultEmail ||
    convenio?.guidePolicy?.priorAuthEmail ||
    convenio?.guidePolicy?.billingEmail ||
    '';

  const destination = to || defaultTo;
  if (!destination) throw new Error('Destinatário não informado e convênio não possui e-mail padrão');

  const pkg = await CommunicationPackage.findOne({ communicationId }).lean();
  if (!pkg || pkg.attachments.length === 0) throw new Error('Pacote de envio não possui documentos');

  // Validação backend: documentos obrigatórios do convênio
  const requiredDocumentTypes = getRequiredDocumentTypes(rules);
  if (requiredDocumentTypes.length > 0) {
    const validation = await validatePackageDocuments(communicationId, requiredDocumentTypes);
    if (!validation.valid) {
      throw new Error(`Documentos obrigatórios pendentes: ${validation.missing.join(', ')}`);
    }
  }

  // Já estamos em SENDING (transicionado no endpoint); marcar tentativa no pacote
  const pkgAfterSending = await markPackageAsSending(communicationId);
  const attempt = pkgAfterSending.attempt || 1;
  const lastAttemptAt = pkgAfterSending.lastAttemptAt || new Date();

  const patientName = communication.patientId?.fullName || 'Paciente';
  const insuranceName = convenio?.name || communication.insuranceProvider;
  const guideNumber = communication.guideId?.number;

  const attachments = pkg.attachments.map(a => ({
    documentId: a.documentId?.toString(),
    url: a.url,
    name: a.filename,
    publicId: a.documentId?.publicId
  })).filter(a => a.url);

  const html = buildDefaultHtml({ patientName, insuranceName, guideNumber, purpose, message });
  const text = message || `${SUBJECT_BY_PURPOSE[purpose] || 'Solicitação'} para ${patientName}.`;

  let result;
  let logStatus = EmailLogStatus.SUCCESS;
  let errorMessage = null;
  const startTime = Date.now();

  try {
    result = await sendEmailWithAttachments({
      to: destination,
      subject: subject || rules?.defaultSubject || SUBJECT_BY_PURPOSE[purpose] || SUBJECT_BY_PURPOSE.authorization,
      html,
      text,
      attachments,
      customId: `communication-${communicationId}-${Date.now()}`
    });
  } catch (error) {
    logStatus = EmailLogStatus.ERROR;
    errorMessage = error?.message || 'Erro ao enviar e-mail';
    result = { success: false };
  }

  const durationMs = Date.now() - startTime;

  // Marcar pacote como enviado, reenviado ou falho
  if (logStatus === EmailLogStatus.SUCCESS) {
    if (pkg.status === PackageStatus.DRAFT || pkg.status === PackageStatus.FAILED) {
      await markPackageAsSent(communicationId);
    } else {
      await markPackageAsResent(communicationId);
    }
  } else {
    await markPackageAsFailed(communicationId);
  }

  // Atualizar status da comunicação via State Machine
  if (logStatus === EmailLogStatus.SUCCESS) {
    await transition(communicationId, CommunicationEvents.MARK_SENT);
  } else {
    await transition(communicationId, CommunicationEvents.FAIL);
  }

  // Registrar log com snapshot dos anexos
  const emailLog = await CommunicationEmailLog.create({
    communicationId,
    communicationPackageId: pkg._id,
    to: destination,
    subject: subject || rules?.defaultSubject || SUBJECT_BY_PURPOSE[purpose] || SUBJECT_BY_PURPOSE.authorization,
    template: template || null,
    message: message || null,
    attachments: pkg.attachments.map(a => ({
      documentId: a.documentId,
      publicId: a.documentId?.publicId,
      url: a.documentId?.url,
      name: a.filename || a.documentId?.name || a.documentId?.originalName,
      hash: a.hash,
      mimeType: a.mimeType,
      size: a.size
    })),
    attempt,
    lastAttemptAt,
    durationMs,
    protocol: result?.messageId || result?.protocol || null,
    status: logStatus,
    errorMessage,
    sentBy: userId
  });

  if (logStatus === EmailLogStatus.ERROR) {
    throw new Error(errorMessage);
  }

  return {
    success: true,
    logId: emailLog._id,
    protocol: emailLog.protocol,
    to: destination,
    attempt
  };
}

export async function getEmailLogs(communicationId) {
  return CommunicationEmailLog.find({ communicationId })
    .sort({ sentAt: -1 })
    .lean();
}

export async function getLatestEmailLog(communicationId) {
  return CommunicationEmailLog.findOne({ communicationId })
    .sort({ sentAt: -1 })
    .lean();
}
