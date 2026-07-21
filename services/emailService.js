// services/emailService.js
import { getEmailProvider } from './email/EmailProviderFactory.js';

function buildResetUrl(resetToken, role) {
  const isProd = process.env.NODE_ENV === 'production';
  const base =
    (isProd ? process.env.FRONTEND_URL_PRD : process.env.FRONTEND_URL_DEV) ||
    process.env.FRONTEND_URL ||
    '';
  return `${base}/reset-password/${resetToken}${role ? `?role=${role}` : ''}`;
}

function buildDefaultFrom(fromEmail, fromName) {
  const defaultFromEmail = process.env.EMAIL_FROM || 'no-reply@clinicafonoinova.com.br';
  const defaultFromName = process.env.EMAIL_FROM_NAME || 'Clinica Fono Inova';
  return {
    fromEmail: fromEmail || defaultFromEmail,
    fromName: fromName || defaultFromName
  };
}

/**
 * Envia e-mail de reset de senha.
 * @param {{ email:string, resetToken:string, role?:'admin'|'doctor' }} params
 * @returns {Promise<boolean>}
 */
export async function sendPasswordResetEmail({ email, resetToken, role }) {
  const { fromEmail, fromName } = buildDefaultFrom();
  const resetUrl = buildResetUrl(resetToken, role);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #f3f4f6; padding: 16px; text-align: center;">
        <img src="${process.env.LOGO_URL || 'https://app.clinicafonoinova.com.br/images/Logo-Fono-Inova-horizontal.png'}" alt="Fono Inova" style="height: 48px;">
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

  const text = `Redefina sua senha: ${resetUrl}\n\nLink válido por 10 minutos.`;
  const provider = getEmailProvider();

  const result = await provider.sendEmail({
    to: email,
    subject: 'Redefinição de Senha - Fono Inova',
    html,
    text,
    customId: `pwd-reset-${Date.now()}`,
    fromEmail,
    fromName
  });

  return result.success;
}

/**
 * Envia e-mail genérico com anexos via provider configurado (Resend/SMTP/Mailjet).
 * @param {{ to: string, subject: string, html: string, text?: string, attachments?: Array<{ url: string, name?: string, publicId?: string }>, customId?: string, fromEmail?: string, fromName?: string }} params
 * @returns {Promise<{ success: boolean, messageId?: string, protocol?: string }>}
 */
export async function sendEmailWithAttachments({
  to,
  subject,
  html,
  text = '',
  attachments = [],
  customId,
  fromEmail,
  fromName
}) {
  const provider = getEmailProvider();
  return provider.sendEmail({
    to,
    subject,
    html,
    text,
    attachments,
    customId,
    fromEmail,
    fromName
  });
}

export { getEmailProvider };
