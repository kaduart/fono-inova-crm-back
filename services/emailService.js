import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const transporter = nodemailer.createTransport({
  service: 'Gmail', // Ou outro serviço (Mailgun, SendGrid, etc)
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});


export const sendPasswordResetEmail = async (email, resetToken) => {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

  const mailOptions = {
    from: `"FonoInova" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Redefinição de Senha - FonoInova',
    html: `
      <div style="font-family: Arial, sans-serif;">
        <h2 style="color: #2563eb;">Redefina sua senha</h2>
        <p>Clique no link abaixo para redefinir sua senha:</p>
        <a href="${resetUrl}" 
           style="background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
           Redefinir Senha
        </a>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">
          Este link expira em 10 minutos. Se não foi você quem solicitou, ignore este email.
        </p>
      </div>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('❌ Erro ao enviar:', {
      to: email,
      error: error.message,
      code: error.code
    });
    return false;
  }
};