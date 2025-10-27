// services/emailService.js
import axios from 'axios';
import nodemailer from 'nodemailer';

function buildResetUrl(resetToken, role) {
  const isProd = process.env.NODE_ENV === 'production';
  const base =
    (isProd ? process.env.FRONTEND_URL_PRD : process.env.FRONTEND_URL_DEV) ||
    process.env.FRONTEND_URL ||
    '';
  return `${base}/reset-password/${resetToken}${role ? `?role=${role}` : ''}`;
}

function createTransporter() {
  const host = process.env.SMTP_HOST || 'in-v3.mailjet.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;   // Mailjet API Key
  const pass = process.env.SMTP_PASS;   // Mailjet Secret Key

  if (!user || !pass) {
    throw new Error('SMTP_USER/SMTP_PASS ausentes (Mailjet).');
  }

  return nodemailer.createTransport({
    host,
    port,
    // 587 => STARTTLS; 465 => SSL
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user, pass },
    // Em alguns ambientes o certificado intermediário quebra a verificação.
    // Mantém true por padrão, mas permite desativar por env se necessário.
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
    // authMethod: 'LOGIN', // comente/ative se seu provedor exigir
  });
}

function parseFrom(fromEmail, fromName) {
  if (fromName) return `"${fromName}" <${fromEmail}>`;
  return fromEmail;
}

/**
 * Fallback Mailjet REST
 */
async function sendViaMailjetREST({ to, subject, html, text }) {
  const key = process.env.SMTP_USER;   // Mailjet API Key
  const secret = process.env.SMTP_PASS; // Mailjet Secret
  if (!key || !secret) throw new Error('Mailjet REST sem credenciais');

  const fromEmail = process.env.EMAIL_FROM || 'no-reply@clinicafonoinova.com.br';
  const fromName = process.env.EMAIL_FROM_NAME || 'Clinica Fono Inova';

  const res = await axios.post(
    'https://api.mailjet.com/v3.1/send',
    {
      Messages: [
        {
          From: { Email: fromEmail, Name: fromName },
          To: [{ Email: to }],
          Subject: subject,
          HTMLPart: html,
          TextPart: text,
          CustomID: `pwd-reset-${Date.now()}`,
        },
      ],
    },
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

/**
 * Envia e-mail de reset de senha usando Mailjet (SMTP). Se falhar, usa REST.
 * @param {{ email:string, resetToken:string, role?:'admin'|'doctor' }} params
 * @returns {Promise<boolean>}
 */
export async function sendPasswordResetEmail({ email, resetToken, role }) {
  const transporter = createTransporter();

  // ⚠️ verify() só para log — não aborta o fluxo se falhar
  try {
    await transporter.verify();
  } catch (e) {
    console.warn('[Mailjet SMTP] verify falhou (seguindo para sendMail):', e?.code || e?.message || e);
  }

  const fromEmail = process.env.EMAIL_FROM || 'no-reply@clinicafonoinova.com.br';
  const fromName = process.env.EMAIL_FROM_NAME || 'Clinica Fono Inova';

  const resetUrl = buildResetUrl(resetToken, role);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #f3f4f6; padding: 16px; text-align: center;">
        <img src="${process.env.LOGO_URL || 'https://via.placeholder.com/150'}" alt="Logo" style="height: 48px;">
      </div>
      <div style="padding: 24px;">
        <h2 style="color: #2563eb; margin: 0 0 8px;">Redefina sua senha</h2>
        <p style="margin: 0 0 16px;">Clique no botão abaixo para redefinir sua senha:</p>
        <a href="${resetUrl}"
           style="display:inline-block;background:#2563eb;color:#fff;padding:12px 18px;text-decoration:none;border-radius:6px;margin: 8px 0;">
          Redefinir Senha
        </a>
        <p style="color:#6b7280;font-size:12px;margin-top:16px;">
          Este link expira em 10 minutos. Se não foi você quem solicitou, ignore este e-mail.
        </p>
      </div>
    </div>
  `;

  const mailOptions = {
    from: parseFrom(fromEmail, fromName),
    to: email,
    subject: 'Redefinição de Senha - Fono Inova',
    text: `Redefina sua senha: ${resetUrl}\n\nLink válido por 10 minutos.`,
    html,
    headers: { 'X-Entity-Ref-ID': `pwd-reset-${Date.now()}` },
  };

  // 1) Tenta SMTP
  try {
    const info = await transporter.sendMail(mailOptions);
    if (!info?.messageId) throw new Error('SMTP: envio sem messageId');
    return true;
  } catch (smtpErr) {
    console.error('[Mailjet SMTP] sendMail falhou:', smtpErr?.code, smtpErr?.response?.toString?.() || smtpErr?.message || smtpErr);
    // 2) Fallback REST
    try {
      await sendViaMailjetREST({
        to: email,
        subject: mailOptions.subject,
        html: mailOptions.html,
        text: mailOptions.text,
      });
      return true;
    } catch (restErr) {
      console.error('[Mailjet REST] falhou:', restErr?.response?.data || restErr?.message || restErr);
      // Propaga para o controller retornar 502 (mantendo tua regra)
      throw restErr;
    }
  }
}
