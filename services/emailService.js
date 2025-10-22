// services/emailService.js
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
  const user = process.env.SMTP_USER;   // = Mailjet API Key
  const pass = process.env.SMTP_PASS;   // = Mailjet Secret Key

  if (!user || !pass) {
    throw new Error('SMTP_USER/SMTP_PASS ausentes (Mailjet).');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,          // 465 = SSL; 587 = STARTTLS
    auth: { user, pass },
    tls: { rejectUnauthorized: true },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    socketTimeout: 20000,
    connectionTimeout: 15000,
  });
}

/**
 * Envia e-mail de reset de senha usando Mailjet (SMTP).
 * @param {{ email:string, resetToken:string, role?:'admin'|'doctor' }} params
 * @returns {Promise<boolean>}
 */
export async function sendPasswordResetEmail({ email, resetToken, role }) {
  const transporter = createTransporter();
  await transporter.verify(); // falha rápido se credencial/porta erradas

  const fromEmail = process.env.EMAIL_FROM || 'no-reply@clinicafonoinova.com.br';
  const fromName = process.env.EMAIL_FROM_NAME || 'Clinica Fono Inova';

  const resetUrl = buildResetUrl(resetToken, role);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #f3f4f6; padding: 16px; text-align: center;">
        <img src="${process.env.LOGO_URL || 'https://via.placeholder.com/150'}"
             alt="Logo" style="height: 48px;">
      </div>
      <div style="padding: 24px;">
        <h2 style="color: #2563eb; margin: 0 0 8px;">Redefina sua senha</h2>
        <p style="margin: 0 0 16px;">Clique no botão abaixo para redefinir sua senha:</p>
        <a href="${resetUrl}"
           style="display:inline-block;background:#2563eb;color:#fff;padding:12px 18px;
                  text-decoration:none;border-radius:6px;margin: 8px 0;">
          Redefinir Senha
        </a>
        <p style="color:#6b7280;font-size:12px;margin-top:16px;">
          Este link expira em 10 minutos. Se não foi você quem solicitou, ignore este e-mail.
        </p>
      </div>
    </div>
  `;

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: email,
    subject: 'Redefinição de Senha - Fono Inova',
    text: `Redefina sua senha: ${resetUrl}\n\nLink válido por 10 minutos.`,
    html,
  };

  const info = await transporter.sendMail(mailOptions);
  // opcional: console.log('[Mailjet SMTP] enviado:', info?.messageId);
  return Boolean(info?.messageId);
}
