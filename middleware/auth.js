import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

export const auth = async (req, res, next) => {
    try {
        // Verificar token no cookie ou header
        const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
        console.log('[AUTH] Headers recebidos:', req.headers);
    console.log('[AUTH] Cookies recebidos:', req.cookies);
        if (!token) {
            return res.status(401).json({
                code: 'TOKEN_REQUIRED',
                message: 'Token não fornecido',
                redirect: true
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secreta');

        // Validação reforçada do payload
        if (!decoded.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
            return res.status(401).json({
                code: 'INVALID_TOKEN_PAYLOAD',
                message: 'Estrutura do token inválida'
            });
        }

        // Verificação otimizada de usuário
        const userModel = mongoose.model(decoded.role === 'admin' ? 'Admin' :
            decoded.role === 'secretary' ? 'Secretary' : 'Doctor');

        const userExists = await userModel.exists({ _id: decoded.id });

        if (!userExists) {
            return res.status(401).json({
                code: 'USER_NOT_FOUND',
                message: 'Usuário não encontrado'
            });
        }

        req.user = {
            id: decoded.id,
            role: decoded.role
        };

        next();
    } catch (err) {
        console.error(`[Auth Error] ${err.name}: ${err.message}`);

        // Respostas padronizadas
        const errorResponse = {
            'TokenExpiredError': {
                code: 'TOKEN_EXPIRED',
                message: 'Sessão expirada',
                redirect: true
            },
            'JsonWebTokenError': {
                code: 'INVALID_TOKEN',
                message: 'Token inválido'
            }
        }[err.name] || {
            code: 'AUTH_FAILED',
            message: 'Falha na autenticação'
        };

        res.status(401).json(errorResponse);
    }
};

// Middleware de autorização dinâmica
export const authorize = (roles = []) => {
    return (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
            return res.status(403).json({
                code: 'FORBIDDEN',
                message: 'Acesso negado para seu perfil'
            });
        }
        next();
    };
};

