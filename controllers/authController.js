import sgMail from '@sendgrid/mail';
import crypto from 'crypto';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import Doctor from '../models/Doctor.js';

dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

console.log('SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'OK' : 'undefined');
console.log('EMAIL_FROM:', process.env.EMAIL_FROM ? 'OK' : 'undefined');
console.log('FRONTEND_URL_PRD:', process.env.FRONTEND_URL_PRD ? 'OK' : 'undefined');

export const authController = {
  async forgotPassword(req, res) {
    try {
      const { email, role } = req.body;

      if (!email || !role) {
        return res.status(400).json({
          success: false,
          message: 'Email e tipo de usuário são obrigatórios'
        });
      }
      let user;
      if (role === 'doctor') {
        user = await Doctor.findOne({ email });
      } else if (role === 'admin') {
        user = await Admin.findOne({ email });
      } else {
        return res.status(400).json({
          success: false,
          message: 'Tipo de usuário inválido'
        });
      }

      if (!user) {
        console.warn(`Tentativa de recuperação para email não cadastrado: ${email}`);
        return res.status(200).json({
          success: true,
          message: 'Se o email existir, você receberá instruções'
        });
      }


      // 3. Gera token seguro
      const resetToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
      const resetUrl = `${process.env.NODE_ENV === 'production'
        ? process.env.FRONTEND_URL_PRD
        : process.env.FRONTEND_URL_DEV
        }/reset-password/${resetToken}?role=${role}`;

      console.log('ssssssssssúrl', resetUrl)
      // 4. Atualiza o médico
      user.passwordResetToken = hashedToken;
      user.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutos
      await user.save({ validateBeforeSave: false });

      // 5. Envia email com template profissional
      const msg = {
        to: user.email,
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
      const { password, role } = req.body;

      // Validações
      if (!role || !['doctor', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Tipo de usuário inválido' });
      }

      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
      }

      // Hash do token
      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

      // Busca o usuário
      let user;
      if (role === 'doctor') {
        user = await Doctor.findOne({
          passwordResetToken: hashedToken,
          passwordResetExpires: { $gt: Date.now() }
        }).select('+password');
      } else if (role === 'admin') {
        user = await Admin.findOne({
          passwordResetToken: hashedToken,
          passwordResetExpires: { $gt: Date.now() }
        }).select('+password');
      }

      if (!user) {
        return res.status(400).json({
          error: 'Token inválido ou expirado',
          solution: 'Solicite um novo link de redefinição'
        });
      }

      // Atualiza a senha (com hash)
      user.password = password;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;

      // Salva garantindo que os hooks são executados
      await user.save({ validateBeforeSave: true });

      // Gera novo token JWT válido
      const authToken = jwt.sign(
        {
          id: user._id.toString(),
          role
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      return res.json({
        success: true,
        message: 'Senha atualizada com sucesso!',
        token: authToken, // Envia o novo token
        user: {
          id: user._id,
          email: user.email,
          role
        }
      });

    } catch (error) {
      console.error('Erro no resetPassword:', error);
      return res.status(500).json({
        error: 'Erro ao atualizar senha',
        details: error.message
      });
    }
  },

  // Adicione este método no seu authController para verificar tokens
  async verifyResetToken(req, res) {

    try {
      const { token } = req.params;
      const { role } = req.query; // 👈 vem da URL: ?role=admin|doctor
      console.log('verifyResetToken', token, role);

      if (!role || !['doctor', 'admin'].includes(role)) {
        return res.status(400).json({
          success: false,
          valid: false,
          message: 'Tipo de usuário inválido'
        });
      }

      const hashedToken = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

      let user;
      if (role === 'doctor') {
        user = await Doctor.findOne({
          passwordResetToken: hashedToken,
          passwordResetExpires: { $gt: Date.now() }
        });
      } else {
        user = await Admin.findOne({
          passwordResetToken: hashedToken,
          passwordResetExpires: { $gt: Date.now() }
        });
      }

      if (!user) {
        return res.status(400).json({
          success: false,
          valid: false,
          message: 'Token inválido ou expirado'
        });
      }

      return res.status(200).json({
        success: true,
        valid: true,
        message: 'Token válido'
      });

    } catch (error) {
      console.error('Erro ao verificar token:', error);
      return res.status(500).json({
        success: false,
        message: 'Erro ao verificar token'
      });
    }
  }

};