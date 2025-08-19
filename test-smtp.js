import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

// Carrega variáveis do .env explicitamente
dotenv.config({ path: '.env' });

// Configuração direta com verificação
const emailConfig = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  },
  tls: { rejectUnauthorized: false }
};

// Verificação das credenciais ANTES de usar
if (!emailConfig.auth.user || !emailConfig.auth.pass) {
  console.error('❌ Credenciais faltando! Verifique seu .env');
  process.exit(1);
}

async function testSMTP() {
  try {
    console.log('🔧 Tentando conectar com:', {
      host: emailConfig.host,
      port: emailConfig.port,
      user: emailConfig.auth.user
    });

    const transporter = nodemailer.createTransport(emailConfig);
    await transporter.verify();

    const info = await transporter.sendMail({
      from: `"Teste" <${emailConfig.auth.user}>`,
      to: 'email-de-teste@example.com',
      subject: 'Teste SMTP',
      text: 'Funcionou!'
    });

    console.log('📨 Email enviado! ID:', info.messageId);
  } catch (error) {
    console.error('❌ Falha crítica:', {
      message: error.message,
      code: error.code
    });
    process.exit(1);
  }
}

testSMTP();