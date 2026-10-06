import express from 'express';
import { auth } from '../middleware/auth.js'; // Seu middleware de autenticação
import Admin from '../models/Admin.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

// Endpoint para obter informações do usuário logado
router.get('/me', auth, async (req, res) => {
    try {
        let user;
        const role = req.user.role; // Obtido do token decodificado pelo middleware auth

        // Busca o usuário no modelo correspondente
        switch (role) {
            case 'admin':
                user = await Admin.findById(req.user.id).select('-password');
                break;
            case 'doctor':
                user = await Doctor.findById(req.user.id)
                    .select('-password')
                    .populate('specialties', 'name'); // Exemplo de populate
                break;
            case 'patient':
                user = await Patient.findById(req.user.id)
                    .select('-password')
                    .populate('appointments');
                break;
            default:
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'Tipo de usuário inválido', {
                    status: 400,
                  }),
                  req
                );
        }

        if (!user) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Usuário não encontrado', { status: 404 }), req);
        }

        // Adiciona o role aos dados do usuário
        const userData = user.toObject ? user.toObject() : user;
        userData.role = role;

        res.json(userData);
    } catch (error) {
        console.error('Erro ao buscar perfil do usuário:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro interno no servidor',
          }),
          req
        );
    }
});

export default router;