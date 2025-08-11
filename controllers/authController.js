import sgMail from '@sendgrid/mail';
import crypto from 'crypto';
import dotenv from 'dotenv';
import Doctor from '../models/Doctor.js';

dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export const authController = {
  async forgotPassword(req, res) {
    try {
      const { email } = req.body;

      // 1. Validação básica
      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email é obrigatório'
        });
      }

      // 2. Busca o médico
      const doctor = await Doctor.findOne({ email });
      if (!doctor) {
        console.warn(`Tentativa de recuperação para email não cadastrado: ${email}`);
        // Não revelar que o email não existe por segurança
        return res.status(200).json({
          success: true,
          message: 'Se o email existir, você receberá instruções'
        });
      }

      // 3. Gera token seguro
      const resetToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
      const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

      // 4. Atualiza o médico
      doctor.passwordResetToken = hashedToken;
      doctor.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutos
      await doctor.save({ validateBeforeSave: false });

      // 5. Envia email com template profissional
      const msg = {
        to: doctor.email,
        from: {
          email: process.env.EMAIL_FROM,
          name: "Clinica FonoInova"
        },
        subject: 'Redefinição de Senha',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #f3f4f6; padding: 20px; text-align: center;">
              <img src="${process.env.LOGO_URL || 'https://via.placeholder.com/150'}" alt="Logo" style="height: 50px;">
            </div>
            <div style="padding: 30px;">
              <h2 style="color: #2563eb;">Redefina sua senha</h2>
              <p>Clique no botão abaixo para redefinir sua senha:</p>
              <a href="${resetUrl}" 
                 style="display: inline-block; background: #2563eb; color: white; 
                        padding: 12px 24px; text-decoration: none; border-radius: 4px;
                        margin: 15px 0;">
                 Redefinir Senha
              </a>
              <p style="color: #6b7280; font-size: 14px;">
                Este link expira em 10 minutos. Se não foi você quem solicitou, ignore este email.
              </p>
            </div>
          </div>
        `,
        text: `Para redefinir sua senha, acesse: ${resetUrl}\n\nLink válido por 10 minutos.`
      };

      await sgMail.send(msg);
      console.log(`Email de recuperação enviado para: ${doctor.email}`);

      return res.status(200).json({
        success: true,
        message: 'Instruções enviadas para seu email'
      });

    } catch (error) {
      console.error('Erro no processo de recuperação:', {
        error: error.message,
        stack: error.stack,
        requestBody: req.body,
        sendGridError: error.response?.body?.errors
      });

      return res.status(500).json({
        success: false,
        message: 'Erro ao processar solicitação'
      });
    }
  },

  async resetPassword(req, res) {
    try {
      const { token } = req.params;
      const { password } = req.body;

      // 1. Validação
      if (!password || password.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'Senha deve ter no mínimo 6 caracteres'
        });
      }

      // 2. Hash do token para comparação
      const hashedToken = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

      // 3. Busca médico com token válido
      const doctor = await Doctor.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() }
      });

      if (!doctor) {
        return res.status(400).json({
          success: false,
          message: 'Token inválido ou expirado'
        });
      }

      // 4. Atualiza a senha
      doctor.password = password;
      doctor.passwordResetToken = undefined;
      doctor.passwordResetExpires = undefined;
      await doctor.save();

      // 5. Opcional: Envia email de confirmação
      await sgMail.send({
        to: doctor.email,
        from: process.env.EMAIL_FROM,
        subject: 'Senha alterada com sucesso',
        text: 'Sua senha foi alterada com sucesso.'
      });

      return res.status(200).json({
        success: true,
        message: 'Senha atualizada com sucesso!'
      });

    } catch (error) {
      console.error('Erro ao resetar senha:', error);
      return res.status(500).json({
        success: false,
        message: 'Erro ao atualizar senha'
      });
    }
  }
};