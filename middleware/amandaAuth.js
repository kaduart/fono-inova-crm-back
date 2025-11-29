import jwt from 'jsonwebtoken';

/**
 * Middleware que aceita TANTO autenticação de usuário QUANTO token de serviço
 * Use nas rotas que Amanda precisa chamar
 */
export const flexibleAuth = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Token não fornecido'
        });
    }

    // 1️⃣ Verifica se é token de serviço (Amanda)
    if (token === process.env.ADMIN_API_TOKEN) {
        req.user = {
            id: 'amanda-service',
            role: 'admin',
            isService: true
        };
        return next();
    }

    // 2️⃣ Senão, valida como JWT normal
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        return next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Token inválido'
        });
    }
};
