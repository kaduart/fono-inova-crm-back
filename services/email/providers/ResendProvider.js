// services/email/providers/ResendProvider.js
import { Resend } from 'resend';
import axios from 'axios';
import path from 'path';
import { BaseEmailProvider } from './BaseEmailProvider.js';

export class ResendProvider extends BaseEmailProvider {
  constructor(config = {}) {
    super(config);
    const apiKey = config.apiKey || process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY não configurada');
    }
    this.resend = new Resend(apiKey);
  }

  async downloadAttachment({ url, name, publicId }) {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const buffer = Buffer.from(response.data, 'binary');
    const contentType = response.headers['content-type'] || 'application/pdf';

    let filename = name;
    if (!filename) {
      const ext = publicId ? path.extname(publicId.split('/').pop() || '') : '';
      filename = `anexo${ext || '.pdf'}`;
    }

    return { filename, content: buffer.toString('base64'), contentType };
  }

  async sendEmail({
    to,
    subject,
    html,
    text = '',
    attachments = [],
    customId,
    idempotencyKey,
    threadMessageId,
    inReplyTo,
    fromEmail,
    fromName
  }) {
    const defaultFromEmail = process.env.EMAIL_FROM || 'no-reply@clinicafonoinova.com.br';
    const defaultFromName = process.env.EMAIL_FROM_NAME || 'Clínica Fono Inova';

    const resolvedFromEmail = fromEmail || defaultFromEmail;
    const resolvedFromName = fromName || defaultFromName;

    const from = `"${resolvedFromName}" <${resolvedFromEmail}>`;

    let resendAttachments = [];
    if (attachments.length > 0) {
      const downloaded = await Promise.all(attachments.map(a => this.downloadAttachment(a)));
      resendAttachments = downloaded.map(att => ({
        filename: att.filename,
        content: att.content,
        contentType: att.contentType
      }));
    }

    // Header interno de rastreamento. O Idempotency-Key é passado pelo segundo
    // argumento do resend.emails.send() para garantir que a SDK o coloque no header
    // HTTP corretamente (evita duplicar no payload e conflitar).
    const headers = {};
    if (customId) headers['X-Entity-Ref-ID'] = customId;

    // Mantém reenvios/complementos no mesmo thread de conversa (Gmail/Outlook).
    // O primeiro envio não recebe header de thread; o Message-ID real é obtido via
    // GET /emails/:id após o envio e salvo no log. Reenvios usam In-Reply-To/
    // References apontando para esse Message-ID real.
    if (inReplyTo) {
      headers['In-Reply-To'] = inReplyTo;
      headers['References'] = inReplyTo;
    }

    const finalHeaders = Object.keys(headers).length > 0 ? headers : undefined;

    const payload = {
      from,
      to,
      subject,
      html,
      text: text || undefined,
      attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
      headers: finalHeaders
    };

    console.log('[ResendProvider] Enviando e-mail:', { from, to: payload.to, subject: payload.subject, attachments: resendAttachments.length, idempotencyKey: idempotencyKey || null });

    let data, error;
    try {
      // idempotencyKey é passado no segundo argumento (options), não no payload.
      // A Resend SDK seta o header Idempotency-Key corretamente dessa forma
      // (verificado no source: resend.post(options.idempotencyKey)).
      const result = await this.resend.emails.send(payload, { idempotencyKey });
      data = result.data;
      error = result.error;
    } catch (err) {
      console.error('[ResendProvider] Exceção na chamada Resend:', err.response?.data || err.message || err);
      throw err;
    }

    if (error) {
      console.error('[ResendProvider] Erro detalhado:', JSON.stringify(error, null, 2));
      throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
    }

    // Busca o Message-ID real (SMTP) gerado pela Resend. O id retornado no send é
    // o ID interno da API; para threading correto precisamos do message_id que os
    // clientes de email (Gmail/Outlook) usam em In-Reply-To/References. O message_id
    // pode demorar algumas centenas de ms para ficar disponível no retrieve.
    let messageId = null;
    console.log('[RESEND THREAD DEBUG] send response data.id:', data?.id);
    if (data?.id) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`[RESEND THREAD DEBUG] retrieving email ${data.id}, attempt ${attempt}/3`);
          const retrieved = await this.resend.emails.get(data.id);
          console.log('[RESEND THREAD DEBUG] retrieved:', JSON.stringify(retrieved));
          messageId = retrieved?.data?.message_id || null;
          if (messageId) {
            console.log('[RESEND THREAD DEBUG] message_id found:', messageId);
            break;
          }
          console.log('[RESEND THREAD DEBUG] message_id empty, retrying...');
        } catch (lookupErr) {
          console.error(`[ResendProvider] Tentativa ${attempt}/3 falha ao obter message_id do email enviado:`, lookupErr?.response?.data || lookupErr.message || lookupErr);
        }
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } else {
      console.log('[RESEND THREAD DEBUG] no data.id from send response');
    }

    return {
      success: true,
      messageId: data?.id,
      protocol: data?.id,
      resendMessageId: messageId || undefined
    };
  }
}

export default ResendProvider;
