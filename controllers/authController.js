// controllers/authController.js
import crypto from 'crypto';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import Doctor from '../models/Doctor.js';
import { sendPasswordResetEmail } from '../services/emailService.js';

dotenv.config();

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

      const Model = role === 'doctor' ? Doctor : role === 'admin' ? Admin : null;
      if (!Model) {
        return res.status(400).json({ success: false, message: 'Tipo de usuário inválido' });
      }

      const user = await Model.findOne({ email });

      // resposta genérica (não revela existência)
      if (!user) {
        return res.status(200).json({
          success: true,
          message: 'Se o email existir, você receberá instruções'
        });
      }

      // 1) token seguro
      const resetToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

      // 2) persiste token/expiração
      await Model.updateOne(
        { _id: user._id },
        {
          $set: {
            passwordResetToken: hashedToken,
            passwordResetExpires: new Date(Date.now() + 10 * 60 * 1000), // 10 min
          }
        }
      );

      // 3) envia email (Mailjet via SMTP)
      try {
        await sendPasswordResetEmail({
          email: user.email,
          resetToken,
          role, // mantém ?role=admin|doctor no link
        });
      } catch (sendErr) {
        // opcional: rollback do token para não deixar "órfão"
        await Model.updateOne(
          { _id: user._id },
          { $unset: { passwordResetToken: '', passwordResetExpires: '' } }
        );
        console.error('[forgotPassword][SMTP] falha:', sendErr?.message || sendErr);
        return res.status(502).json({
          success: false,
          message: 'Falha ao enviar e-mail de recuperação (SMTP/Mailjet)',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Instruções enviadas para seu email'
      });

    } catch (error) {
      console.error('Erro no processo de recuperação:', error);
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

      if (!role || !['doctor', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Tipo de usuário inválido' });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
      }

      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
      const Model = role === 'doctor' ? Doctor : Admin;

      const user = await Model.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() }
      }).select('+password');

      if (!user) {
        return res.status(400).json({
          error: 'Token inválido ou expirado',
          solution: 'Solicite um novo link de redefinição'
        });
      }

      user.password = password;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: true });

      const authToken = jwt.sign(
        { id: user._id.toString(), role },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      return res.json({
        success: true,
        message: 'Senha atualizada com sucesso!',
        token: authToken,
        user: { id: user._id, email: user.email, role }
      });

    } catch (error) {
      console.error('Erro no resetPassword:', error);
      return res.status(500).json({
        error: 'Erro ao atualizar senha',
        details: error.message
      });
    }
  },

  async verifyResetToken(req, res) {
    try {
      const { token } = req.params;
      const { role } = req.query;

      if (!role || !['doctor', 'admin'].includes(role)) {
        return res.status(400).json({
          success: false,
          valid: false,
          message: 'Tipo de usuário inválido'
        });
      }

      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
      const Model = role === 'doctor' ? Doctor : Admin;

      const user = await Model.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() }
      });

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
  },

  async manualResetStart(req, res) {
    try {
      const { email, role } = req.body;

      if (!email || !role || !['admin', 'doctor'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Email e role são obrigatórios (admin|doctor)' });
      }

      const Model = role === 'doctor' ? Doctor : Admin;
      const user = await Model.findOne({ email }).select('_id email');
      // resposta genérica (não revela existência)
      if (!user) {
        // ainda assim “finge” sucesso para não vazar cadastro
        return res.json({ success: true, resetUrl: makeUrl('<dummy>') });
      }

      // gera token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

      // salva token + expiração (10 min)
      await Model.updateOne(
        { _id: user._id },
        {
          $set: {
            passwordResetToken: hashedToken,
            passwordResetExpires: new Date(Date.now() + 10 * 60 * 1000),
          }
        }
      );

      const resetUrl = makeUrl(resetToken, role);
      return res.json({ success: true, resetUrl });

    } catch (e) {
      console.error('[manualResetStart]', e);
      return res.status(500).json({ success: false, message: 'Erro ao gerar link de redefinição' });
    }
  },

  async setPasswordNoToken(req, res) {
    try {
      const { email, newPassword, role } = req.body;
      if (!email || !newPassword || !role || !['doctor', 'admin'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Dados inválidos' });
      }
      const Model = role === 'doctor' ? Doctor : Admin;
      const user = await Model.findOne({ email }).select('+password +requiresPasswordCreation');

      if (!user) {
        // resposta genérica
        return res.status(200).json({ success: true, message: 'Senha definida (se a conta existir)' });
      }

      // Só permite **sem token** se for primeiro acesso/sem senha/flag
      const isFirstSet =
        !user.password || user.requiresPasswordCreation === true;

      if (!isFirstSet) {
        return res.status(400).json({
          success: false,
          message: 'Use o link de redefinição (token) para alterar a senha'
        });
      }

      user.password = newPassword;
      user.requiresPasswordCreation = false;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: true });

      const authToken = jwt.sign(
        { id: user._id.toString(), role },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      return res.json({
        success: true,
        message: 'Senha criada com sucesso!',
        token: authToken,
        user: { id: user._id, email: user.email, role }
      });
    } catch (err) {
      console.error('[setPasswordNoToken] erro:', err);
      return res.status(500).json({ success: false, message: 'Erro ao criar senha' });
    }
  }

};

// helper: monta a URL do front
function makeUrl(token, role = 'admin') {
  const isProd = process.env.NODE_ENV === 'production';
  const base =
    (isProd ? process.env.FRONTEND_URL_PRD : process.env.FRONTEND_URL_DEV) ||
    process.env.FRONTEND_URL ||
    'http://localhost:5173';
  return `${base}/reset-password/${token}?role=${role}`;
}

