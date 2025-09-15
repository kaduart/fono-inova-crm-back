import sgMail from '@sendgrid/mail';
import dotenv from 'dotenv';

dotenv.config();

// Usa a mesma API Key que você configurou no Render
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function sendTestEmail() {
  try {
    const msg = {
      to: 'ricardosantos.ti51@gmail.com', // <- coloque seu email para teste
      from: {
        email: process.env.EMAIL_FROM,
        name: process.env.EMAIL_FROM_NAME || 'Clinica FonoInova',
      },
      subject: 'Teste SendGrid Produção',
      text: 'Este é um teste para verificar se o SendGrid está funcionando em produção.',
      html: '<p>Este é um <strong>teste</strong> para verificar o SendGrid em produção.</p>',
    };

    const response = await sgMail.send(msg);
    console.log('✅ Email enviado com sucesso!', response);
  } catch (error) {
    console.error('❌ Erro ao enviar email:', error.response?.body || error);
  }
}

// Executa o teste
sendTestEmail();
