import sgMail from '@sendgrid/mail';
import dotenv from 'dotenv';
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const msg = {
    to: 'ricardosantos.ti15@gmail.com', // 👈 Altere para seu email
    from: {
        email: process.env.EMAIL_FROM, // Email VERIFICADO
        name: process.env.EMAIL_FROM_NAME // Nome exibido
    },
    subject: 'Teste SendGrid - AGORA VAI!',
    text: 'Se receber isso, seu remetente está verificado!',
    html: '<h1 style="color: #2563eb;">✅ Sucesso!</h1><p>Configuração completa!</p>'
};

sgMail.send(msg)
    .then(() => console.log('🎉 Email enviado com sucesso!'))
    .catch(error => {
        console.error('🔥 ERRO:', {
            status: error.response?.statusCode,
            errors: error.response?.body?.errors.map(e => e.message)
        });
    });