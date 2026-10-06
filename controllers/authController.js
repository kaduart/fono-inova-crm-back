// controllers/authController.js
import crypto from 'crypto';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import Doctor from '../models/Doctor.js';
import { sendPasswordResetEmail } from '../services/emailService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

dotenv.config();

export const authController = {
  async forgotPassword(req, res) {
    try {
      const { email, role } = req.body;

      if (!email || !role) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Email e tipo de usuário são obrigatórios', {
            status: 400,
          }),
          req
        );
      }

      const Model = role === 'doctor' ? Doctor : role === 'admin' ? Admin : null;
      if (!Model) {
        return sendApiError(res, new AppError('BAD_REQUEST', 'Tipo de usuário inválido', { status: 400 }), req);
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
        return sendApiError(
          res,
          new AppError('INTERNAL_ERROR', 'Falha ao enviar e-mail de recuperação (SMTP/Mailjet)', {
            status: 502,
          }),
          req
        );
      }

      return res.status(200).json({
        success: true,
        message: 'Instruções enviadas para seu email'
      });

    } catch (error) {
      console.error('Erro no processo de recuperação:', error);
      return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao processar solicitação', { status: 500 }), req);
    }
  },

  async resetPassword(req, res) {
    try {
      const { token } = req.params;
      const { password, role } = req.body;

      if (!role || !['doctor', 'admin'].includes(role)) {
        return sendApiError(res, new AppError('BAD_REQUEST', 'Tipo de usuário inválido', { status: 400 }), req);
      }
      if (!password || password.length < 6) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Senha deve ter no mínimo 6 caracteres', {
            status: 400,
          }),
          req
        );
      }

      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
      const Model = role === 'doctor' ? Doctor : Admin;

      const user = await Model.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() }
      }).select('+password');

      if (!user) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Token inválido ou expirado', {
            status: 400,
            extra: { solution: 'Solicite um novo link de redefinição' },
          }),
          req
        );
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
      return sendApiError(
        res,
        new AppError('INTERNAL_ERROR', 'Erro ao atualizar senha', {
          status: 500,
          details: error.message,
        }),
        req
      );
    }
  },

  async verifyResetToken(req, res) {
    try {
      const { token } = req.params;
      const { role } = req.query;

      if (!role || !['doctor', 'admin'].includes(role)) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Tipo de usuário inválido', {
            status: 400,
            extra: { valid: false },
          }),
          req
        );
      }

      const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
      const Model = role === 'doctor' ? Doctor : Admin;

      const user = await Model.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() }
      });

      if (!user) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Token inválido ou expirado', {
            status: 400,
            extra: { valid: false },
          }),
          req
        );
      }

      return res.status(200).json({
        success: true,
        valid: true,
        message: 'Token válido'
      });

    } catch (error) {
      console.error('Erro ao verificar token:', error);
      return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao verificar token', { status: 500 }), req);
    }
  },

  async manualResetStart(req, res) {
    try {
      const { email, role } = req.body;

      if (!email || !role || !['admin', 'doctor'].includes(role)) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Email e role são obrigatórios (admin|doctor)', {
            status: 400,
          }),
          req
        );
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
      return sendApiError(
        res,
        new AppError('INTERNAL_ERROR', 'Erro ao gerar link de redefinição', {
          status: 500,
        }),
        req
      );
    }
  },

  async setPasswordNoToken(req, res) {
    try {
      const { email, newPassword, role } = req.body;
      if (!email || !newPassword || !role || !['doctor', 'admin'].includes(role)) {
        return sendApiError(res, new AppError('BAD_REQUEST', 'Dados inválidos', { status: 400 }), req);
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
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Use o link de redefinição (token) para alterar a senha', {
            status: 400,
          }),
          req
        );
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
      return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao criar senha', { status: 500 }), req);
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

