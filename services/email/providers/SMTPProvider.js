// services/email/providers/SMTPProvider.js
import axios from 'axios';
import nodemailer from 'nodemailer';
import path from 'path';
import { BaseEmailProvider } from './BaseEmailProvider.js';

export class SMTPProvider extends BaseEmailProvider {
  constructor(config = {}) {
    super(config);
  }

  createTransporter() {
    const host = this.config.host || process.env.SMTP_HOST || 'in-v3.mailjet.com';
    const port = Number(this.config.port || process.env.SMTP_PORT || 587);
    const user = this.config.user || process.env.SMTP_USER;
    const pass = this.config.pass || process.env.SMTP_PASS;

    if (!user || !pass) {
      throw new Error('SMTP_USER/SMTP_PASS ausentes.');
    }

    return nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
        ciphers: 'TLSv1.2',
        minVersion: 'TLSv1.2',
      },
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      socketTimeout: 20000,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
    });
  }

  async downloadAttachment({ url, name, publicId }) {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const buffer = Buffer.from(response.data, 'binary');
    const contentType = response.headers['content-type'];

    let filename = name;
    if (!filename) {
      const ext = publicId ? path.extname(publicId.split('/').pop() || '') : '';
      filename = `anexo${ext || '.pdf'}`;
    }

    return { filename, content: buffer, contentType };
  }

  parseFrom(fromEmail, fromName) {
    if (fromName) return `"${fromName}" <${fromEmail}>`;
    return fromEmail;
  }

  async sendViaMailjetREST({ to, subject, html, text, attachments = [], customId }) {
    const key = process.env.SMTP_USER;
    const secret = process.env.SMTP_PASS;
    if (!key || !secret) throw new Error('Mailjet REST sem credenciais');

    const fromEmail = process.env.EMAIL_FROM || 'no-reply@clinicafonoinova.com.br';
    const fromName = process.env.EMAIL_FROM_NAME || 'Clinica Fono Inova';

    const message = {
      From: { Email: fromEmail, Name: fromName },
      To: [{ Email: to }],
      Subject: subject,
      HTMLPart: html,
      TextPart: text,
      CustomID: customId || `crm-${Date.now()}`,
    };

    if (attachments.length > 0) {
      message.Attachments = attachments.map(att => ({
        ContentType: att.contentType || 'application/pdf',
        Filename: att.filename,
        Base64Content: att.content.toString('base64')
      }));
    }

    const res = await axios.post(
      'https://api.mailjet.com/v3.1/send',
      { Messages: [message] },
      {
        auth: { username: key, password: secret },
        timeout: 15000,
      }
    );

    const status = res?.data?.Messages?.[0]?.Status;
    if (status !== 'success') {
      throw new Error(`Mailjet REST retorno: ${status || 'desconhecido'}`);
    }
    return true;
  }

  async sendEmail({
    to,
    subject,
    html,
    text = '',
    attachments = [],
    customId,
    fromEmail,
    fromName
  }) {
    const transporter = this.createTransporter();

    try {
      await transporter.verify();
    } catch (e) {
      console.warn('[SMTPProvider] verify falhou (seguindo para sendMail):', e?.code || e?.message || e);
    }

    const defaultFromEmail = process.env.EMAIL_FROM || 'no-reply@clinicafonoinova.com.br';
    const defaultFromName = process.env.EMAIL_FROM_NAME || 'Clinica Fono Inova';

    const resolvedFromEmail = fromEmail || defaultFromEmail;
    const resolvedFromName = fromName || defaultFromName;

    const downloadedAttachments = attachments.length > 0
      ? await Promise.all(attachments.map(a => this.downloadAttachment(a)))
      : [];

    const nodemailerAttachments = downloadedAttachments.map(att => ({
      filename: att.filename,
      content: att.content,
      contentType: att.contentType
    }));

    const mailOptions = {
      from: this.parseFrom(resolvedFromEmail, resolvedFromName),
      to,
      subject,
      text,
      html,
      attachments: nodemailerAttachments,
      headers: { 'X-Entity-Ref-ID': customId || `crm-${Date.now()}` }
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      if (!info?.messageId) throw new Error('SMTP: envio sem messageId');
      return { success: true, messageId: info.messageId, protocol: info.messageId };
    } catch (smtpErr) {
      console.error('[SMTPProvider] sendMail falhou:', smtpErr?.code, smtpErr?.response?.toString?.() || smtpErr?.message || smtpErr);
      try {
        await this.sendViaMailjetREST({ to, subject, html, text, attachments: downloadedAttachments, customId });
        return { success: true, protocol: `mailjet-rest-${Date.now()}` };
      } catch (restErr) {
        console.error('[SMTPProvider] Mailjet REST falhou:', restErr?.response?.data || restErr?.message || restErr);
        throw restErr;
      }
    }
  }
}

export default SMTPProvider;
