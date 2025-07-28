import jwt from 'jsonwebtoken';


// middleware/auth.js
import mongoose from 'mongoose';
export const auth = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return res.status(401).json({ error: 'Token não fornecido' });
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Formato de token inválido' });
        }

        // Decodificar o token sem verificar primeiro para inspeção
        const decodedWithoutVerify = jwt.decode(token);

        // Agora verificar propriamente
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secreta');

        // Validação do ID
        if (!decoded.id) {
            return res.status(401).json({ error: 'Token inválido - ID ausente' });
        }

        const doctor = String(decoded.id);
        if (!mongoose.Types.ObjectId.isValid(doctor)) {
            return res.status(401).json({ error: 'ID no token é inválido' });
        }

        let userExists = false;
        const collections = ['Doctor', 'Admin', 'Secretary']; // Adicione todos os modelos

        for (const modelName of collections) {
            const model = mongoose.model(modelName);
            userExists = await model.exists({
                _id: new mongoose.Types.ObjectId(doctor)
            });

            if (userExists) break;
        }

        if (!userExists) {
            return res.status(401).json({ error: 'Usuário não encontrado' });
        }

        // Configura o usuário na requisição
        req.user = {
            id: doctor,
            role: decoded.role
        };

        next();
    } catch (err) {
        console.error('[Auth] Erro detalhado:', {
            errorName: err.name,
            message: err.message,
            stack: err.stack
        });

        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expirado' });
        }
        if (err.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Token inválido' });
        }

        return res.status(401).json({ error: 'Falha na autenticação' });
    }
};
export const authorize = (roles = []) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Acesso negado' });
        }
        next();
    };
};


export const adminOrSecretary = (req, res, next) => {
    if (!req.user || !req.user.role) {
        return res.status(401).json({ message: 'Usuário não autenticado ou role não definida' });
    }

    if (req.user.role === 'admin' || req.user.role === 'secretary') {
        next();
    } else {
        res.status(403).json({ message: 'Acesso negado' });
    }
};
