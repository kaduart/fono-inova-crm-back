import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

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
  console.log('Variáveis carregadas:', {
    EMAIL_USER: process.env.EMAIL_USER,
    EMAIL_PASSWORD: process.env.EMAIL_PASSWORD ? '***' : undefined
  });
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
    console.log('✅ SMTP autenticado com sucesso!');
    
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