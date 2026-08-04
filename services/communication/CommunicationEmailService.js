// services/communication/CommunicationEmailService.js
import InsuranceCommunication, { CommunicationStatus } from '../../models/InsuranceCommunication.js';
import CommunicationEmailLog, { EmailLogStatus, EmailLogType } from '../../models/CommunicationEmailLog.js';
import CommunicationPackage, { PackageStatus } from '../../models/CommunicationPackage.js';
import Convenio from '../../models/Convenio.js';
import { sendEmailWithAttachments } from '../emailService.js';
import { getEmailProviderName } from '../email/EmailProviderFactory.js';
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

  // Mensagens customizadas (digitadas no Wizard) vêm com quebra de linha "\n" normal,
  // mas HTML ignora "\n" solto — sem isso, o corpo do e-mail sai tudo grudado num
  // parágrafo só (achado em produção 2026-07-27, e-mail real recebido sem quebras).
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
  userId,
  sendType,
  ip,
  reason,
  jobId
}) {
  // Guarda de idempotência: BullMQ garante "at-least-once", não "exactly-once" — um
  // job pode ser reprocessado (retry após falha tardia, stalled-job) mesmo depois de
  // já ter enviado o e-mail de verdade com sucesso. Sem isso, cada reprocessamento do
  // MESMO job disparava um novo e-mail real (achado em produção 2026-08-04: 5 e-mails
  // duplicados enviados, `attempts:5` da fila, zero logs persistidos — algo travava
  // depois do envio, o BullMQ via como falha e reenviava de verdade a cada tentativa).
  // jobId é estável entre essas re-execuções do mesmo job, então um log de sucesso já
  // gravado com este jobId prova que o e-mail já saiu — não enviar de novo.
  if (jobId) {
    const existing = await CommunicationEmailLog.findOne({ jobId }).sort({ createdAt: -1 }).lean();
    if (existing?.status === EmailLogStatus.SUCCESS) {
      return {
        success: true,
        logId: existing._id,
        protocol: existing.protocol,
        to: existing.to,
        attempt: existing.attempt
      };
    }
    // PENDING = uma execução anterior deste MESMO job chegou a chamar o Resend mas
    // nunca voltou pra confirmar sucesso/erro (travou, worker reiniciou, etc.) — não
    // sabemos se o e-mail saiu de verdade, então nunca reenviamos às cegas aqui.
    // ERROR não bloqueia: significa que o Resend foi chamado e recusou/falhou de forma
    // limpa, então tentar de novo é seguro (nada foi entregue).
    if (existing?.status === EmailLogStatus.PENDING) {
      throw new Error(`Job ${jobId} já iniciou um envio anterior cujo resultado é incerto (travou antes de confirmar sucesso ou erro). Bloqueado para evitar duplicidade — verifique manualmente (ex.: caixa do destinatário) antes de tentar de novo.`);
    }
  }

  const communication = await InsuranceCommunication.findById(communicationId)
    .populate('patientId', 'fullName')
    .populate('guideId', 'number')
    .lean();

  if (!communication) throw new Error('Comunicação não encontrada');

  // Reenvio/complemento (comunicação já em sent/approved) nunca passam pela máquina de
  // estados — sent/approved descreve "o convênio recebeu/aprovou", não "quantas vezes
  // foi enviado" (isso é o CommunicationEmailLog.attempt/type). Só o primeiro envio real
  // (a partir de READY) transiciona o status; daí guardamos essa condição pra também
  // decidir, no fim da função, se fechamos o ciclo SENDING → SENT/READY ou não.
  const isFirstSend = communication.status === CommunicationStatus.READY;
  if (isFirstSend) {
    await transition(communicationId, CommunicationEvents.SEND);
  }

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
    name: a.filename
  })).filter(a => a.url);

  const html = buildDefaultHtml({ patientName, insuranceName, guideNumber, purpose, message });
  const text = message || `${SUBJECT_BY_PURPOSE[purpose] || 'Solicitação'} para ${patientName}.`;
  const resolvedSubject = subject || rules?.defaultSubject || SUBJECT_BY_PURPOSE[purpose] || SUBJECT_BY_PURPOSE.authorization;
  const resolvedType = sendType || (isFirstSend ? EmailLogType.FIRST_SEND : EmailLogType.RESEND);
  const attachmentsSnapshot = pkg.attachments.map(a => ({
    documentId: a.documentId,
    url: a.url,
    name: a.filename,
    hash: a.hash,
    mimeType: a.mimeType,
    size: a.size
  }));

  // Marcador gravado ANTES de chamar o Resend — é o que permite o guard de idempotência
  // acima detectar "este job já tentou enviar" mesmo se o processo travar/reiniciar
  // logo depois desta chamada, antes de conseguirmos confirmar sucesso ou erro.
  let pendingLog = null;
  if (jobId) {
    pendingLog = await CommunicationEmailLog.create({
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
      reason: reason || undefined,
      ip: ip || undefined,
      lastAttemptAt,
      provider: getEmailProviderName(),
      status: EmailLogStatus.PENDING,
      sentBy: userId
    });
  }

  let result;
  let logStatus = EmailLogStatus.SUCCESS;
  let errorMessage = null;
  const startTime = Date.now();

  try {
    result = await sendEmailWithAttachments({
      to: destination,
      subject: resolvedSubject,
      html,
      text,
      attachments,
      customId: `communication-${communicationId}-${Date.now()}`,
      // Remetente dedicado deste fluxo (envio de documentação/faturamento a convênio) —
      // usa env var própria em vez do EMAIL_FROM genérico, que outros e-mails do sistema
      // (reset de senha, etc.) também usam. Evita que uma troca aqui afete o resto do
      // sistema, ou vice-versa (achado em produção 2026-07-27).
      fromEmail: process.env.BILLING_EMAIL_FROM || 'financeiro@clinicafonoinova.com.br',
      fromName: process.env.BILLING_EMAIL_FROM_NAME || 'Financeiro - Clínica Fono Inova'
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

  // Atualizar status da comunicação via State Machine — só se este ciclo realmente
  // passou por SENDING (1º envio). Reenvio/complemento deixam status como estava.
  if (isFirstSend) {
    if (logStatus === EmailLogStatus.SUCCESS) {
      await transition(communicationId, CommunicationEvents.MARK_SENT);
    } else {
      await transition(communicationId, CommunicationEvents.FAIL);
    }
  }

  // Fecha o registro: atualiza o MESMO marcador 'pending' criado antes do Resend (não
  // cria um segundo documento) — isso é o que faz o guard de idempotência funcionar,
  // já que o registro final continua tendo o mesmo jobId da tentativa.
  const finalFields = {
    protocol: result?.messageId || result?.protocol || null,
    durationMs,
    status: logStatus,
    errorMessage
  };

  const emailLog = pendingLog
    ? await CommunicationEmailLog.findByIdAndUpdate(pendingLog._id, { $set: finalFields }, { new: true })
    : await CommunicationEmailLog.create({
        communicationId,
        communicationPackageId: pkg._id,
        to: destination,
        subject: resolvedSubject,
        template: template || null,
        message: message || null,
        attachments: attachmentsSnapshot,
        attempt,
        type: resolvedType,
        reason: reason || undefined,
        ip: ip || undefined,
        lastAttemptAt,
        provider: getEmailProviderName(),
        sentBy: userId,
        ...finalFields
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

/**
 * Lista CADA tentativa de envio (1 log = 1 linha), não só a última por comunicação.
 * É o que alimenta a aba "Envios" — histórico/auditoria completo, não um resumo.
 */
export async function listCommunicationEmailLogs({
  purpose,
  insuranceProvider,
  patientId,
  page = 1,
  limit = 100
} = {}) {
  const commQuery = {};
  if (purpose) commQuery.purpose = purpose;
  if (insuranceProvider) commQuery.insuranceProvider = insuranceProvider.toLowerCase();
  if (patientId) commQuery.patientId = patientId;

  const communications = await InsuranceCommunication.find(commQuery)
    .populate('patientId', 'fullName')
    .populate('guideId', 'number')
    .lean();

  if (communications.length === 0) {
    return { data: [], pagination: { total: 0, page, limit, pages: 0 } };
  }

  const commIds = communications.map(c => c._id);
  const commById = new Map(communications.map(c => [c._id.toString(), c]));

  const convenioCodes = [...new Set(communications.map(c => c.insuranceProvider))];
  const convenios = await Convenio.find({ code: { $in: convenioCodes } }).select('code name').lean();
  const convenioMap = new Map(convenios.map(c => [c.code, c.name]));

  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    CommunicationEmailLog.find({ communicationId: { $in: commIds } })
      .sort({ sentAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CommunicationEmailLog.countDocuments({ communicationId: { $in: commIds } })
  ]);

  const data = logs.map(log => {
    const comm = commById.get(log.communicationId.toString());
    return {
      ...log,
      patientId: comm?.patientId?._id || comm?.patientId,
      patientName: comm?.patientId?.fullName || '',
      insuranceProvider: comm?.insuranceProvider,
      insuranceName: convenioMap.get(comm?.insuranceProvider) || comm?.insuranceProvider,
      guideNumber: comm?.guideId?.number || null,
      purpose: comm?.purpose,
      communicationStatus: comm?.status
    };
  });

  return { data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

export async function getLatestEmailLog(communicationId) {
  return CommunicationEmailLog.findOne({ communicationId })
    .sort({ sentAt: -1 })
    .lean();
}
